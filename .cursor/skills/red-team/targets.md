# Target map

The attack surface of this repo, area by area: the files, the invariant the code *means* to
hold (with the doc that states it), and what to try. Read the code and the doc, then look for the
gap. Line numbers drift — anchor on the function name.

## 1. Auth & session — `api/src/auth.rs`

Intended (docs/accounts.md): a claimed name can only go live, save a bio, or chat "when the
cookie says it is them"; the password is argon2id and forgotten; the login token lives only in
the browser, the DB keeps its sha256.

- **Cookie** (`set_cookie`): `HttpOnly; Secure; SameSite=Lax`, 64-hex token, 32 random bytes,
  sha256 stored. Check: entropy (fine at 32 bytes), that the token is compared by hash, that
  `Secure`/`HttpOnly` are never dropped on any path (`clear_cookie`, `with_cookie`).
- **CSRF** (`from_here`): the ONLY route gated on `Sec-Fetch-Site` is `logout`. Everything else
  leans on `SameSite=Lax` + the cookie. Hunt: a **state-changing GET** (Lax sends cookies on
  top-level GET navigations), or a POST that does damage with no `from_here` and no body the
  browser could not send cross-site. `logout` lets a missing/`none` header through by design —
  decide if any other route should have copied that gate and didn't.
- **`client_ip`**: trusts the **first** `X-Forwarded-For` hop. The invariant is "Caddy sets it and
  nothing else reaches this port." If the api port (4000) is reachable directly — docker port
  exposed, a second ingress, SSRF that can reach it — XFF is attacker-controlled: evade the
  per-ip signup/login caps, or shift your guesses onto another ip's bucket. Verify the port
  isolation claim against `docker-compose.yml` / Caddy config.
- **Rate limits**: login 10/name+ip, 100/ip, 15-min window; signup 20/ip/hr; counted via redis
  `bump` (INCR + EXPIRE NX). Try: parallel burst before the counter catches (it is counted
  *before* verify on purpose — confirm that holds on every path, incl. `check_password`), and
  limit evasion via XFF above.
- **Timing**: `decoy_hash` + `verify_blocking(None)` make a missing name cost the same as a wrong
  password. Probe whether any *other* branch (name validation, `is_held`, the `starts_with(dummy)`
  check) returns early fast enough to be a username oracle.
- **Password reset**: CLI only (`api passwd`). No email path to abuse — confirm there is no hidden
  reset route in `routes()`.

## 2. Authz & IDOR — `main.rs`, `group_mod.rs`, `dms.rs`

Intended: free name = anyone; claimed name = only its login; held name = nobody (docs/ids.md).
Stream control is by session **token**, not id (`main.rs` heartbeat comment: "Session ids are
guessable. The token is not.").

- **`may_act_as` / `may_write`** (`auth.rs`, `main.rs`): the gate for go-live, bio, picture,
  about, socials, presence, name change. Try to write a claimed name without its cookie; try a
  held name as the account that left it (docs say *nobody*, including them).
- **Session ownership** (`owns_session`, used by `attached`/`viewers`/`heartbeat`/`stop`): all
  check id+token+name+open. The id is a sequential `BIGSERIAL` and guessable; the token is 53
  bits (`new_session_token`). Hunt any control route that checks only the id, or accepts `by` /
  other fields as authority. `stop` takes `by=video` as a *label*, not a right — confirm it grants
  nothing.
- **Groups** (`group_mod.rs`): powers are `appearance`, `roles`, `channels`, `kick`, `ban`, plus
  owner. Every mutating handler should call `need(s, who.id, group, PERM)`. Hunt: a handler that
  forgets `need`, a role grant that lets you grant yourself a higher role, kicking/banning an
  owner, or acting on a group you are not in. docs/groups.md is the oracle.
- **DMs** (`dms.rs`): friends-only (mutual follow). Try reading/sending to a thread where the
  follow is one-directional or absent; try the read-mark route on someone else's thread.
- **Follows/notifications** (`follows.rs`, `notify.rs`): self-follow, follow caps, and whether a
  `notify` fact leaks a name/avatar to someone who should not see it.

## 3. Injection — SQL, redis, shell

- **SQL**: `grep "format!(" api/src -A1 | grep -i select/insert/update/delete`. Current hits —
  `group_mod.rs` (`read/write/clear_picture`, `{column}`), `notify.rs` (`ACTOR_COLUMNS`),
  `history.rs` (`LINE_COLUMNS`/`LINE_TABLES`) — all interpolate **constants**; the request-derived
  values (`group`, `name`, `room`, `id`, `user_id`) are `.bind()` params. These are **safe today**
  (Info-level watch-points). A finding requires an interpolated identifier whose value reaches the
  format from a request. Everything else uses `sqlx::query*` with bind params — good; look for a
  new one that doesn't.
- **Redis Lua** (`redis::cmd("EVAL")` in `main.rs`, `events.rs`): args are passed as `ARGV`, not
  concatenated into the script. Confirm no script is built with `format!` from input.
- **Shell** (`video/src/dummy.rs`, `video/src/thumbs.rs`): `Command::new("ffmpeg").arg(...)`. Args
  are passed as a vec (no shell), and inputs are names/paths the server controls. Check whether any
  arg can carry a request-controlled stream name or path, and whether `valid_name` gates it first.

## 4. Frontend / XSS — `frontend/src/infra/about.ts` (+ `socials.ts`, `About.tsx`)

Intended (docs/about.md): a page of fixed React blocks, "never html from a string"; media from
this origin only; links http(s) only; CSS parsed by the browser, scoped under the box, with
anything that loads/runs/leaves stripped. **This is the hardened showcase — break the sanitizer.**

- **`safeCss`**: parses with a constructed `CSSStyleSheet`, re-emits from the parsed form, scopes
  every selector under `#<scope>`, drops at-rules except `@media`/`@supports`, rewrites
  `position:fixed`→`absolute`, applies `BAD_VALUE` / `BAD_PROPERTY` regexes. Attack ideas:
  - **Parser differential** — a value the `CSSStyleSheet` parser keeps but that renders as a
    load/escape the regex missed; a declaration that round-trips differently than `BAD_VALUE`
    expects.
  - **`url()` smuggling** past `BAD_VALUE = /url|image-set|.../` (it is broad — try to find a
    loader it doesn't name, or a CSS function that fetches).
  - **Selector escape** in `scopeSelectors` / `splitSelectors` — break out of `#scope` so a rule
    hits the real page chrome (depth/quote tracking in `splitSelectors` is the place to probe).
  - **Scope-name injection** — `safeCss` only accepts `^[a-z][a-z0-9_-]*$` scopes; confirm callers
    can't pass a hostile scope.
- **`mediaPath`**: allowlist `/api/streamers/`, `/thumb/`, `/about-demo/`; rejects schemes, `//`,
  `\`, `..`, control chars. Try a request-splitting or redirect path that still starts with an
  allowed prefix and reaches something unexpected.
- **`linkHref`**: http/https only, resolved against origin. Try `javascript:`/`data:` variants and
  whitespace/control tricks that `new URL()` tolerates.
- **Where the doc is the oracle**: the `test/about.js` suite already fires hostile CSS at it. Read
  what it tests, then try what it *doesn't*.

## 5. Data layer — `api/src/s3.rs`, uploads, api→video

- **`check_key`** (s3.rs): rejects empty, leading/trailing `/`, and any `.`/`..`/empty segment —
  looks solid; try unicode/encoding tricks and confirm keys are always built from `valid_name` +
  server-side ids (`avatars/<name>.jpg`, `thumbs/<name>/<id>.jpg`, `groups/<group>/icon.jpg`).
- **Upload validation** (`jpeg_in` in `group_mod.rs`, avatar/thumb/offline in `profile.rs`): "is it
  a jpeg" = size cap + magic-byte prefix only, no re-encode. Assets allow png/jpeg/gif/webp. Served
  back with a fixed `image/jpeg` (icons) or the stored mime (assets) and long cache. Hunt:
  content-type confusion / polyglot that a browser sniffs as active content; an asset mime the
  allowlist shouldn't take (svg?); a stored file served with a sniffable type. Check the asset
  content-type allowlist in `profile.rs`.
- **SSRF**: `S3_ENDPOINT` and `video_url` are operator config, not request input — but confirm
  nothing lets a request steer them, and that `normalize_endpoint` can't be pointed inward.
- **Confirm with** `./scripts/manage.sh --db` / `--redis` that an upload or write landed where you
  think (or where it shouldn't).

## 6. Abuse / DoS

- **argon2 `HASH_SLOTS = 4`** (auth.rs): only 4 hashes at once, process-wide; the rest queue. A
  flood of logins/signups queues behind the semaphore — measure whether it can stall real logins
  (the per-ip caps are the intended backstop; see if XFF evasion removes it).
- **Caps to test for off-by-one or bypass**: signup/login windows, `GROUPS_PER_MAKER`, follow
  churn (429), dm `slow down`, chat 1 line/sec/500 chars, calendar `RANGE_MAX_DAYS=93` /
  `RANGE_LIMIT=1000`, upload sizes (`MAX_ICON`, asset 2 MB).

## 7. Info disclosure & headers

- **`/api/health`**: leaks `env`, `build`, `version`, bucket name, endpoint, uptimes. Intended for
  a monitor — decide if it's too chatty for an unauthenticated route.
- **`/api/me`**: hands the account uuid to the owner only; confirm it's owner-gated.
- **`/api/errors`** (`debug.rs`): admin names **or** an `OPS_TOKEN` bearer. Check the bearer
  comparison is constant-time and length-checked (min 16 enforced at boot), and that stored error
  reports (which hold ip/ua/message/stack) are not readable by a non-admin anywhere.
- **Security headers / CSP**: served by Caddy, not the api. Because the about page injects
  user-authored CSS into a `<style>`, a missing/loose CSP raises the cost of any sanitizer slip —
  check the Caddy config for CSP, `X-Content-Type-Options: nosniff` (matters for the upload
  sniffing angle), frame/referrer policy.
