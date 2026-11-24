# Cloudflare cache rules (nodentity.xyz)

The exact Cache Rules to set up by hand for `nodentity.xyz`, what to check after, how the api
purges a takedown, how a deploy purges the html, and how to back it all out. **Nothing here is
applied automatically**: no code or deploy touches the zone's rules. Free plan only; no paid
feature is used or needed.

The live zone is in the **billyz404meter** Cloudflare account, zone id
`f0cc0d1347c485b580f9dcd3a3e72dc5`.

Where: Cloudflare Dashboard > nodentity.xyz > **Caching > Cache Rules** > Create rule.

Why rules at all: by default Cloudflare only caches by file extension, and none of the api's
media urls have one. The rules below make those paths *eligible*; whether a given answer is kept,
and for how long, is still the origin's `Cache-Control`:

| Route | Origin `Cache-Control` |
| --- | --- |
| `/assets/*` (frontend build) | long-lived, hashed file names |
| public chat picture / video (`/api/chat-images/*`, `/api/chat-videos/*`) | `public, max-age=86400` |
| private (group or DM) chat picture / video | `private, no-store` (never kept) |
| `/api/emotes/*`, `/api/streamers/*/avatar`, `/api/streamers/*/thumbs/*` | `public, max-age=86400` |
| `/api/models/*`, `/api/streamers/*/assets/*`, `/api/streamers/*/about-file/*` | `public, max-age=31536000, immutable` (about-page text files: `no-store`) |
| `/api/streams` | `public, max-age=5` |
| html shell: `/`, `/groups`, `/groups/*`, `/live`, `/login`, `/signup` (`frontend/Caddyfile`) | `public, max-age=0, s-maxage=60, must-revalidate` |
| `/watch/<name>`, a 200 render (`api/src/profile.rs`) | `public, max-age=0, s-maxage=15, must-revalidate` |
| `/watch/<unknown>`, a renamed name's 302, a db/redis fallback, every other spa path | `no-cache` (never kept) |

## Rule 1: "Cache public static+media"

- **Rule name:** `Cache public static+media`
- **When incoming requests match:** Custom filter expression > Edit expression:

```
(starts_with(http.request.uri.path, "/assets/"))
or (starts_with(http.request.uri.path, "/api/chat-images/"))
or (starts_with(http.request.uri.path, "/api/chat-videos/"))
or (starts_with(http.request.uri.path, "/api/emotes/"))
or (starts_with(http.request.uri.path, "/api/models/"))
or (http.request.uri.path wildcard "/api/streamers/*/avatar")
or (http.request.uri.path wildcard "/api/streamers/*/thumbs/*")
or (http.request.uri.path wildcard "/api/streamers/*/assets/*")
or (http.request.uri.path wildcard "/api/streamers/*/about-file/*")
or (http.request.uri.path eq "/api/streams")
```

  (`starts_with`, `wildcard` and `eq` are all available on Free. Don't use `matches`: regex is
  not on Free.)

- **Then:**
  - Cache eligibility: **Eligible for cache**
  - Edge TTL: **Use cache-control header if present, bypass cache if not**
  - Browser TTL: leave as **Respect origin** (default). Do not set an override.
  - Leave every other setting (cache key, serve stale, respect strong ETags, origin error page
    pass-thru, etc.) at its default.
- **Never** pick "Ignore cache-control header and use this TTL" or "Override origin" for Edge
  TTL. The origin's TTL is the only thing keeping private media out of the cache
  (`private, no-store`) and `/api/streams` at 5 seconds.

## Rule HTML: "Cache HTML shell"

The spa's `index.html` for a cold first load, kept at the edge for a minute (a `/watch/<name>`
page for 15 s) so the first byte comes from the nearest Cloudflare location instead of the box.
The browser never keeps it (`max-age=0, must-revalidate`), so a deploy reaches every open tab as
before. Nothing in these pages is per viewer: the shell is a static file, and `/watch/<name>` is
the shell plus that streamer's public profile, presence and preview tags (`og:*`, `twitter:*`,
canonical), built from `PUBLIC_URL`, never from request headers, and with no cookie read or set.
Who is logged in is asked by react after it boots (`/api/me`), never in the html.

Why the ttl stays short and the deploy purges: `frontend/publish-pages.sh` deletes the previous
build's hashed `/assets/*` files, so a kept html that names them would load a blank page until
it expires. `scripts/deploy.sh` purges these urls right after publishing (below).

- **Rule name:** `Cache HTML shell`
- **Expression:**

```
(http.request.uri.path eq "/")
or (http.request.uri.path eq "/groups")
or (http.request.uri.path eq "/live")
or (http.request.uri.path eq "/login")
or (http.request.uri.path eq "/signup")
or (starts_with(http.request.uri.path, "/groups/"))
or (starts_with(http.request.uri.path, "/watch/"))
```

- **Then:**
  - Cache eligibility: **Eligible for cache**
  - Edge TTL: **Use cache-control header if present, bypass cache if not**
  - Browser TTL: **Respect origin** (default). Do not set an override.
  - Every other setting at its default.
- `/watch/<unknown>`, a rename's 302 and the fallbacks answer `no-cache`, so the edge does not
  keep them even though the path matches.

## Rule 2: "Bypass dynamic" (must be LAST)

Cache Rules run top to bottom and a later matching rule wins, so the order is **Rule 1, Rule
HTML, Rule 2** (drag them there if needed). `/watch/` used to be in this rule; it is not any more,
or it would undo Rule HTML for every stream page.

- **Rule name:** `Bypass dynamic`
- **Expression:**

```
(http.request.uri.path eq "/api/explore")
or (http.request.uri.path eq "/ws")
or (starts_with(http.request.uri.path, "/chat/"))
or (http.request.uri.path eq "/events")
or (http.request.uri.path eq "/voice")
```

- **Then:** Cache eligibility: **Bypass cache**.

Deploy the three rules, then run the checklist.

## Test checklist

Use `curl -sI` (or `curl -s -D- -o /dev/null`) against `https://nodentity.xyz` and read
`cf-cache-status`, `cache-control` and `age`. Pick real ids from the site.

**Private media is never cached.** For a picture and a video posted in a private group and in a
DM, request each url three ways, several times each:

- [ ] no cookie: denied (no media body), `cf-cache-status` is never `HIT`
- [ ] a member's session cookie: 200 with the media, `cache-control: private, no-store`,
      `cf-cache-status` `BYPASS`/`DYNAMIC`/`MISS`, never `HIT`, and `age` absent
- [ ] a non-member's session cookie: denied, never `HIT`
- [ ] repeat the no-cookie request *right after* the member's: still denied. (A `HIT` or a media
      body here means the edge kept a private answer: disable Rule 1 at once, see Rollback.)

**Video Range requests.**

- [ ] `curl -s -D- -o /dev/null -H 'Range: bytes=0-1023' <public chat video url>` returns
      `206` with a correct `content-range`, on the first request and again after it is a `HIT`
- [ ] the video seeks and plays in the browser (Network tab shows 206s)

**MISS then HIT, per route.** For one url of each route in Rule 1, request it twice:

- [ ] `/assets/<some hashed file>`
- [ ] `/api/chat-images/<public id>`
- [ ] `/api/chat-videos/<public id>`
- [ ] `/api/emotes/<id>`
- [ ] `/api/models/<file>`
- [ ] `/api/streamers/<name>/avatar`
- [ ] `/api/streamers/<name>/thumbs/<id>`
- [ ] `/api/streamers/<name>/assets/<id>`
- [ ] `/api/streamers/<name>/about-file/<id>` (a picture; a text file must stay uncached)
- [ ] `/api/streams`

  First: `cf-cache-status: MISS` (or `EXPIRED`). Second: `HIT`, with `cache-control` unchanged
  from the origin's.

**`/api/streams` staleness is at most 5 s.**

- [ ] after a `HIT`, `age` never exceeds 5; at 6 s or later the next request is `EXPIRED`/`MISS`
- [ ] start or end a stream: the list reflects it within ~5 s

**The html shell.** For `/` and for `/watch/<name of someone live>`:

- [ ] first request `cf-cache-status: MISS` (or `EXPIRED`), the second `HIT`
- [ ] `age` never above 60 on `/` and never above 15 on `/watch/<name>`
- [ ] `cache-control` is `public, max-age=0, s-maxage=60, must-revalidate` on `/` and
      `public, max-age=0, s-maxage=15, must-revalidate` on `/watch/<name>`: the browser keeps
      nothing (max-age=0)
- [ ] no `set-cookie` on either
- [ ] a request with a logged-in session cookie gets byte-for-byte the same html as one without
      (`curl -s <url> | shasum` both ways, within the ttl)
- [ ] `/watch/<a name that does not exist>`, `/oauth`, `/admin`, `/explore` and a made-up path
      answer `no-cache` and are never `HIT`
- [ ] `./scripts/deploy.sh frontend` says `cloudflare: purged ...` twice, and the next request to
      `/` and to `/watch/<name>` is a `MISS`

**Bypass routes are never cached.** For each of `/api/explore`, `/ws`, `/chat/<…>`, `/events`,
`/voice`:

- [ ] `cf-cache-status` is `DYNAMIC` or `BYPASS`, never `HIT`
- [ ] websockets (`/ws`, `/voice`) and the event stream (`/events`) still connect and stay open

## Purge on takedown

The edge keeps a public answer as long as its `Cache-Control` says (a day for a chat picture, a
year for an immutable asset), so a takedown that only removes the file from the bucket would
leave Cloudflare serving it. `api/src/cf_purge.rs` purges those urls by url when the api takes
something down:

- Fires when the owner (uploader / streamer) **or an admin** deletes a public chat picture,
  chat video, emote, avatar, thumbnail, streamer asset or about-page file.
- Calls `POST https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache` with
  `{"files": [...]}`, 30 urls per call (the Free plan's limit), each url being
  `$PUBLIC_URL` + the path.
- Runs on its own task with a 3 s timeout; it never delays or fails the delete request. A failure
  is a `warn` log line (`cf purge ...`).
- Never purges private (group or DM) urls: they are `private, no-store` and the edge never had
  them.
- Env vars (api service):
  - `CF_PURGE_TOKEN`: the API token (scope below)
  - `CF_ZONE_ID`: nodentity.xyz's zone id (Dashboard > Overview, right column)
  - `PUBLIC_URL`: the public origin, e.g. `https://nodentity.xyz` (trailing `/` is ignored)
- **No-op if any of the three is unset or empty**: a `debug` log line per would-be purge, nothing
  else. That is the right state while the rules are off.

Check it: delete a public chat picture that was a `HIT`, then request its url: it must not be a
`HIT` (the origin's 404/410 comes through).

## Purge on deploy

`scripts/deploy.sh` purges the html right after the pages are published (`./scripts/deploy.sh
frontend`, `--pull` when the pages changed, and a full deploy), reading `CF_PURGE_TOKEN`,
`CF_ZONE_ID` and `PUBLIC_URL` from `.env`:

1. `{"files": ["$PUBLIC_URL/", "$PUBLIC_URL/groups", "$PUBLIC_URL/live", "$PUBLIC_URL/login", "$PUBLIC_URL/signup"]}`
2. `{"prefixes": ["<host>/watch/", "<host>/groups/"]}` (host without the scheme; prefix purge is
   on the Free plan)

Each is one `POST .../zones/$CF_ZONE_ID/purge_cache` with a 10 s timeout. The token goes to curl
on stdin, never on the command line or in the output. Any of the three unset: one `skipped` line,
nothing else. A failure is a `WARN` with the HTTP status and Cloudflare's `errors[].message`, and
never fails the deploy; the edge then serves the old html until its `s-maxage` runs out (60 s,
15 s for `/watch/`). Purge by hand if a page is blank: Caching > Configuration > Custom Purge.

### Token scope

Create it at My Profile > API Tokens > Create Token > Custom token:

The same token serves the api (takedowns) and `scripts/deploy.sh` (html on deploy).

- Permissions: **Zone > Cache Purge > Purge**, and **nothing else**
- Zone Resources: **Include > Specific zone > nodentity.xyz** only
- No account permissions, no other zones. Optionally an IP filter for the api host and a TTL.

## Rollback

1. Caching > Cache Rules: toggle **Rule 1** off (or delete it). That alone stops the edge from
   keeping any api answer; Rule 2 can stay or go.
   - html only: toggle **Cache HTML shell** off and add
     `or (starts_with(http.request.uri.path, "/watch/"))` back to Rule 2's expression, then purge
     `/`, `/groups`, `/live`, `/login`, `/signup` and the `/watch/`, `/groups/` prefixes (or
     Purge Everything). The origin headers can stay: without the rule the edge does not keep
     html.
2. Optionally Caching > Configuration > **Purge Everything** to drop what is already kept.
3. Unset `CF_PURGE_TOKEN` and `CF_ZONE_ID` on the api and restart it: purging becomes a no-op.
   Leave `PUBLIC_URL` set: OAuth callbacks need it too (`api/src/oauth.rs`).
4. Revoke the token under My Profile > API Tokens if it is no longer wanted.
