# Cloudflare cache rules (nodentity.xyz)

The exact Cache Rules to set up by hand for `nodentity.xyz`, what to check after, how the api
purges a takedown, and how to back it all out. **Nothing here is applied automatically**: no
code or deploy touches the zone's rules. Free plan only; no paid feature is used or needed.

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

## Rule 2: "Bypass dynamic" (must be LAST)

Cache Rules run top to bottom and a later matching rule wins, so this one goes **below** Rule 1
in the list (drag it there if needed).

- **Rule name:** `Bypass dynamic`
- **Expression:**

```
(http.request.uri.path eq "/api/explore")
or (starts_with(http.request.uri.path, "/watch/"))
or (http.request.uri.path eq "/ws")
or (starts_with(http.request.uri.path, "/chat/"))
or (http.request.uri.path eq "/events")
or (http.request.uri.path eq "/voice")
```

- **Then:** Cache eligibility: **Bypass cache**.

Deploy both rules, then run the checklist.

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

**Bypass routes are never cached.** For each of `/api/explore`, `/watch/<name>`, `/ws`,
`/chat/<…>`, `/events`, `/voice`:

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

### Token scope

Create it at My Profile > API Tokens > Create Token > Custom token:

- Permissions: **Zone > Cache Purge > Purge**, and **nothing else**
- Zone Resources: **Include > Specific zone > nodentity.xyz** only
- No account permissions, no other zones. Optionally an IP filter for the api host and a TTL.

## Rollback

1. Caching > Cache Rules: toggle **Rule 1** off (or delete it). That alone stops the edge from
   keeping any api answer; Rule 2 can stay or go.
2. Optionally Caching > Configuration > **Purge Everything** to drop what is already kept.
3. Unset `CF_PURGE_TOKEN` and `CF_ZONE_ID` on the api and restart it: purging becomes a no-op.
   Leave `PUBLIC_URL` set: OAuth callbacks need it too (`api/src/oauth.rs`).
4. Revoke the token under My Profile > API Tokens if it is no longer wanted.
