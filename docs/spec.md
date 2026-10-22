# test stream — build spec

Source of truth for product decisions is `overview.md`. If they conflict, follow the human file. This file is the implementable version of that plan, and it describes what is in the repo now. The chat has its own document, `chat.md`.

## goal

Run one program set on one machine. A person opens `https://<that-machine-ip>` and either goes live from the browser or watches someone who is live.

One streamer per stream. Many watchers. The streamer uploads once. The machine copies packets to each watcher. No transcode. Accounts are optional (see "accounts").

This is a lab. It is reachable by anyone who can hit the IP. That is accepted.

## non-goals

Do not build these.

- stream keys, permission roles, email, password reset, oauth, 2fa (accounts are a name and a password, optional: see "accounts")
- follows, vod, recording, moderation (the text chat is in: `chat.md`)
- transcoding, simulcast, quality ladder, cdn
- group calls where several people publish into one room
- a second machine, a real fanout tier, TURN, ICE-TCP
- mobile apps, OBS ingest, RTMP

Leaving them out is the point of the test. Structure the media path so a later fanout machine can be added without rewriting the site.

## what the user sees

Five pages. One site.

| page | url | what it does |
|---|---|---|
| home | `/` | one card per stream that is live right now, as many across as fit (one on a phone, four at full width): the picture of the stream a few seconds old with one chip on it (`just started`, `live for 12 min`, `live for 3 hr`, `live for 2 days`; plain `live` when the api has no start time), then the streamer's picture or first letter, the name, the bio cut at two lines. the whole card links to watch. a button links to go live |
| go live | `/live` | camera preview. a name field. a bio box and a picture. start sends the camera. stop ends it |
| watch | `/watch/:name` | plays that stream and shows that streamer's picture and bio. if nobody is live, says so and retries every 5s. the one page whose html comes from the api, so a shared link gets a preview card (see "the watch document") |
| log in, sign up | `/login`, `/signup` | name + password. optional: see "accounts" below. `?next=/path` is where you land after |
| admin | `/admin` | this box's `/api/health` and the last error reports, for a login in `ADMIN_NAMES`. see `debugging.md` |

Every page header has who you are: a name box (localstorage, your chat nick and the go-live default) with a `log in` link, or your account name with `log out`.

Name rules: lowercase `a-z 0-9 _ -`, 1 to 32 chars. The page lowercases input; api and video trim and lowercase too, then reject what is left if it does not match (api: 400; video: `{"error":"bad name. use a-z 0-9 _ - (1 to 32)"}`). Show the watch link after start so the streamer can copy it.

Empty home: say nobody is live, and show go live.

## how a session works

```mermaid
flowchart LR
  cam[browser camera] --> enc[browser compresses]
  enc --> ingest[ingest on this machine]
  ingest --> fan[fanout on this machine]
  fan --> w1[watcher browser]
  fan --> w2[watcher browser]
```

1. Streamer opens `/live`, types a name, allows the camera, hits start.
2. The page calls go-live. The api opens a `sessions` row, sets the redis key, and returns the socket path plus a session id and a random token. Heartbeat and stop must carry both.
3. The browser compresses camera and mic locally, then opens one WebRTC connection to `video` and publishes.
4. The name shows up on home.
5. A watcher opens `/watch/:name`. The page asks the api, then opens its own WebRTC connection to `video`, which copies the streamer's packets to that watcher. It does not decode them.
6. More watchers mean more copies out of the same machine. The streamer still has one upload.
7. Streamer hits stop, or closes the tab. Watchers get `{"event":"ended"}` and are closed. The name leaves home at once.

Reject a second publisher on a name that already has one. First streamer keeps it until stop, tab close, or the connection fails.

One quality. Every watcher gets whatever the streamer is sending.

## processes

One machine. Nine services in `docker-compose.yml`; `certs` and `pages` run once and exit; `dummy` idles unless `DUMMY_STREAMS` is set. Every long-running one logs to json-file capped at 3 × 10 MB (the `x-logging` anchor), so a box left alone does not fill its disk with caddy's access log.

```mermaid
flowchart TB
  certs -.->|cert volume| frontend
  pages -.->|pages volume| frontend
  browser[browser] -->|https :443| frontend
  frontend -->|/api| api
  frontend -->|/ws| video
  api --> database
  api --> redis
  api -.->|GET /live| video
  video -.->|is this session open| api
  browser -->|media udp :7882| video
  dummy -->|ws + media, like a browser| video
  dummy -.->|bio, go-live, heartbeat| api
  frontend -->|/chat/name| chat
  chat --> redis
  chat -.->|is this the streamer| database
  dummy -.->|pretend viewers| chat
```

| container | job |
|---|---|
| pages | built from `frontend/`: node builds the React app (Vite); the final image only copies `dist/` into the `pages-data` volume (`publish-pages.sh`: the build is copied to a temp dir on the volume, the hashed assets renamed in next to the old ones, `index.html` renamed over the old one last — a rename is atomic, so a browser gets the whole old page or the whole new one — then the files the new build no longer has are removed) and exits. Re-running it is how the pages redeploy, without touching caddy |
| frontend | `caddy:2-alpine`, no custom build. serves the `pages-data` volume as a single-page app (`try_files … /index.html`). `/api/*` and `/watch/*` → `api:4000`, `/ws` and `/thumb/*` → `video:7880`, `/chat/*` → `chat:4100`. When the api is down (502/503/504: a `./deploy.sh api`, a crash), `/watch/*` falls back to the plain `index.html` from the volume (`handle_errors`), so a shared link still boots the spa, which keeps checking; that one fetch has no preview tags. Every other route keeps its error. https :443 with the volume cert. :80 redirects to https. The Caddyfile is a bind mount; `deploy.sh` reloads caddy in place when it changes |
| api | Rust (axum) in `api/`. bios, pictures, sessions, live list, heartbeats, and the html of `/watch/<name>` (read from the same `pages-data` volume, mounted read-only at `/srv`) |
| chat | the `api` binary run as `api chat` (same image, no extra build) on `:4100`. one websocket per viewer at `/chat/<name>`, lines in a redis stream per room (last 500), the database only to confirm the streamer. moves with `./deploy.sh api`. the whole design is in `chat.md` |
| database | postgres. `streamers(name, bio, avatar, avatar_at, password_hash, created_at, updated_at)`, `sessions(id, name, token, verified, started_at, ended_at)`, `logins(token_hash, name, created_at, last_seen, expires_at)`. no host port; peek with `docker compose exec database psql -U stream` |
| redis | `live:<name>` = session id, 90s TTL, kept alive by the page's heartbeat. no host port; peek with `docker compose exec redis redis-cli` |
| video | Rust (webrtc-rs) in `video/`. one upload in, packet copies out. all media on udp 7882. Opus + VP8 only. this is ingest and fanout for the test |
| certs | `alpine/openssl`. writes a self-signed cert for `PUBLIC_IP` into a volume (EC P-256, 825 days, SAN = ip + 127.0.0.1 + localhost, serverAuth), exits. reused while the SAN still matches |
| dummy | the `video` binary run as `video dummy` (`video/Dockerfile.dummy`, same build stage as `video` so the layers are shared, plus a static ffmpeg and a font). Publishes `DUMMY_STREAMS` fake streams through the normal `/ws` handshake: ffmpeg draws a bouncing box, the name and a clock at 480×270 / 15 fps, encodes VP8 + a quiet Opus tone to RTP on localhost, and the binary forwards the packets into `TrackLocalStaticRTP`s. `PUT`s a bio and runs go-live (first: `video` wants its session and token in the publish frame) / heartbeat / stop against the api, so home shows `since`. Reconnects 5s after the socket drops (a `video` redeploy), closing the old peer connection on every way out. ~8% of a core per stream |

The frontend never touches video packets. The api serves one html route, `/watch/<name>`, and it is the pages' own `index.html` with a different head; it never builds pages of its own. `video` never serves pages.

`video` speaks one websocket on `:7880/ws` (not published; reached through the frontend). The browser sends a single JSON text frame, then keeps the socket open until it hangs up.

```json
{"role":"publish","name":"billy","sdp":"<offer sdp>","session":12,"token":5551212}
{"role":"watch","name":"billy","sdp":"<offer sdp>"}
```

The server answers `{"sdp":"<answer sdp>"}`. `"error"` instead of `"sdp"` means no: `"someone is already live"`, `"not live"`, `"not your stream"`, `"api unreachable"`, `"bad name…"`, `"bad offer"` (over 32 KB, over 4 `m=` lines of any kind, or unparseable), `"could not negotiate"`, `"server error"`. The browser has 10s to send its frame and the server 10s to answer. A watcher waits up to 8s for a publisher that is still setting up. When the publisher leaves, watchers get `{"event":"ended"}` and the socket closes. A new watcher gets one keyframe request on connect; further watcher PLI/FIR are forwarded at most once per 1.5s per stream, and no two requests of any kind go out within 300ms, so a burst of joins shares one keyframe. Header extensions from the publisher are stripped before fan-out. Lost packets are re-sent to watchers from a 512-packet history. ICE calls a vanished peer disconnected after 5s and gives up at 20s. On SIGTERM every room ends, every watcher gets `ended`, and the process exits as soon as those frames are out (2s at most; axum stops tracking a socket once it is upgraded, so `video` waits for its own tasks).

`video` also serves `GET /thumb/<name>.jpg` (caddy routes `/thumb/*` to it): the latest picture of a live stream, `Cache-Control: private, max-age=3`, 404 for anything not live. It is made on this machine for every publisher, browser or dummy: when a publisher's video track comes up, a small ffmpeg is started beside it (`video/src/thumbs.rs`), fed a copy of the VP8 packets over localhost as plain RTP described by an SDP file in `/tmp`, and writes a 320px jpeg atomically to `/tmp/thumb-<name>.jpg`, the first decoded frame right away and then one every `THUMB_EVERY_SECS` (5). Browsers only send a keyframe when asked, so `video` requests one every 2s until the first picture exists (or until ffmpeg is found dead, which is logged once); the first one shows up a second or two after going live. It decodes every frame, roughly 5–10% of a core per 720p stream, so viewers pay nothing (decoding only keyframes would mean asking the publisher for one every few seconds, and every viewer would download those). `THUMBS=0` turns it off; a `video` image without ffmpeg just logs that and serves 404. Nothing is stored anywhere; the file goes with the room.

A publish frame must carry the `session` and `token` that go-live handed out. `video` asks the api (`POST {API_URL}/api/streams/<name>/heartbeat?session=&token=`, 1.5s timeout) whether that session is open for that name: 200 → go on, 4xx → `{"error":"not your stream"}`, no answer → `{"error":"api unreachable"}`; a frame without them is `not your stream` too. The check comes after the cheap ones (name, offer), so a bad offer is still `bad offer`. This is what makes "only your login can go live as it" hold on the socket and not just at go-live: whoever skips the api has no session. Names starting with `DUMMY_PREFIX` (`dummy-`) are reserved for the fake streams as well and need `"password": "<DUMMY_PASSWORD>"` in the frame, else `{"error":"reserved name"}`. With no `DUMMY_PASSWORD` set they are refused outright. The api applies the same rule to go-live (`?password=`, 403 otherwise). `video` does not read redis or the database. It exposes `GET /live` (sorted JSON array of names connected right now) and `GET /health` (`ok`).

## fake streams

`video dummy` (`video/src/dummy.rs`) runs one ffmpeg per stream: a single lavfi graph (`color` → `drawbox` bouncing on `abs(mod(t·v, 2·range) − range)` → `drawtext` name and `%{pts}` clock; `sine` at a per-stream pitch, `volume=0.15`), libvpx (`-deadline realtime -cpu-used 8`, 480×270 @ 15 fps, 500 kbps, 2 s GOP) and libopus to RTP on two localhost ports; the Rust side `write_rtp`s those packets into two `TrackLocalStaticRTP`s on a peer connection that did the normal `/ws` publish handshake: go-live at the api first (`?password=`), then the frame with that `session` and `token` plus `"password"`. `-threads 1 -filter_threads 1` sit after the `-i`: before it they only limit the source and libvpx spins one thread per core (measured: ~100% → ~8% per stream). `DUMMY_STREAMS=0`, an empty password or an empty `API_URL` → the container logs why and idles. `DUMMY_NAMES` entries that break the name rule are skipped with a warning (that rule is also what keeps them safe inside the `drawtext` expression). A pretend chatter whose nick has since been claimed by a signup is refused by the chat; the dummy logs that once and that chatter stays quiet. The pages show a `test` badge on `dummy-` names.

What each store holds:

- **database** — `streamers`: `name`, `bio`, `avatar`, `avatar_at`, `updated_at`, plus `password_hash` and `created_at` once the name has an account; `logins`: the hashed login tokens (see "accounts"). `sessions`: one row per go-live with a random `token` (53 bits from the api's os rng, so it survives a js number) and `verified` (the go-live came from the name's own login), `ended_at` null while live. A row whose tab vanished without stop is ended by a sweeper once a minute: open, older than 3 minutes, and no live key holds its id. Survives a restart. No vod. A bio can exist while they are offline.
- **redis** — `live:<name>` = session id, `SET NX EX 90`. Heartbeat refreshes every 15s; `stop` deletes. It is a lock, not the truth: when `video` answers, the api uses `video`'s connected list for home and for `watch.live`, treats a key with no connected publisher as stale once its session is older than 20s (deleted on the next go-live, only if it still holds that id; younger, the publisher is still on its way to `video` and the name is taken), and refuses a go-live when `video` says the name is connected even if the key is gone. When `video` does not answer, redis alone decides, and go-live refuses (503) rather than guess.

## browser https rule

`getUserMedia` only runs in a secure context. `http://<ip>` redirects to https. Serve the site on https with a self-signed cert. The browser warning is expected. After the user proceeds, the camera works.

WebRTC signaling from the page must use `wss` to the same host, proxied to `video` at `/ws`. Otherwise a https page will refuse a `ws` socket. The api returns `url: "/ws"`; the page builds `wss://<location.host>/ws`.

## deploy

`./deploy.sh` on the machine. It picks `PUBLIC_IP`, writes `.env`, builds the pages and the three Rust images (`api`, `video`, `dummy`) one at a time, runs Docker Compose, and waits for `/api/health`. From another device on the same network, or from the public internet if the ports are open, browse to the machine IP.

```text
https://<PUBLIC_IP>/
```

`PUBLIC_IP` is the address browsers and WebRTC should use. LAN test: the LAN IP. VPS test: the public IP. Cloud VMs with a private NIC and a mapped public IP: the public one.

Ports that must be reachable:

| port | proto | use |
|---|---|---|
| 80 | tcp | redirect to https |
| 443 | tcp | pages, `/api`, `/ws` |
| 7882 | udp | all media, one port (udp mux) |

`7880/tcp` is not published. `video` must advertise `PUBLIC_IP`, not a docker bridge address. If it advertises the wrong IP, the socket connects and the video stays black.

No STUN, TURN, or ICE-TCP. Watchers who cannot reach udp 7882 get no video. Same LAN, or a VPS with that port open, is the supported setup.

The database volume keeps bios, accounts and sessions. Redis does not use a volume, so a restart of that container clears "who is live", every room's chat history and the login/signup/error-report counters. The cert is a named volume written by `certs`; nothing in the repo.

## config

`.env` holds the values that change per machine: `PUBLIC_IP` and `CARGO_BUILD_JOBS` (`deploy.sh` writes both and keeps every other line), `ENV_NAME` (what the box calls itself in `/api/health` and every stored error; empty, and `deploy.sh` writes the machine's hostname in once, never touching a set value; still empty by hand = `unnamed`), `ADMIN_NAMES` (accounts that may read `/api/errors` and open `/admin`; each needs an account on that box or the api drops it at boot with an error line), `OPS_TOKEN` (a machine's bearer token for `/api/errors`; 16 characters at least, shorter is ignored with a warn line), plus the optional fake-stream settings `DUMMY_STREAMS` (default 0), `DUMMY_PASSWORD` (empty = reserved names refused), `DUMMY_NAMES` (comma list; default `dummy-mango, dummy-pixel, dummy-disco, …`). Database and redis passwords in this test are the literals in `docker-compose.yml` (`stream` / no redis password).

The api container receives:

```text
DATABASE_URL=postgres://stream:stream@database:5432/stream
DEBUG_DATABASE_URL=postgres://stream:stream@database:5432/debug
REDIS_URL=redis://redis:6379/0
VIDEO_URL=http://video:7880
PORT=4000
ENV_NAME=<hostname>      ADMIN_NAMES=            OPS_TOKEN=          (from .env, see debugging.md)
```

The video container receives `PUBLIC_IP` (must be an ipv4 address, or it refuses to start: anything else would fail every negotiation while `/health` says ok), `WS_PORT=7880`, `UDP_PORT=7882`, `API_URL=http://api:4000` (where it checks publishers' sessions), `DUMMY_PASSWORD`, `THUMB_EVERY_SECS=5` (and optionally `THUMBS=0`), `RUST_LOG=warn,video=info,webrtc_ice=error`. The api also gets `DUMMY_PASSWORD`. The dummy container gets `DUMMY_STREAMS`, `DUMMY_PASSWORD`, `DUMMY_NAMES`, `VIDEO_WS_URL=ws://video:7880/ws`, `API_URL=http://api:4000`.

`BUILD` is a build arg, not `.env`: `deploy.sh` sets it to the short git sha (`-dirty` when `api/`, `video/`, `frontend/`, `Cargo.toml` or `Cargo.lock` have edits or new files) and the `pages`, `api`, `video` and `dummy` images bake it in (`ENV BUILD`, vite `define` `__BUILD__`); it goes on the `compose build` command line as well as in the environment, so a `sudo docker` fallback cannot lose it. A hand-run `docker compose build` gets `dev`; `BUILD=$(git rev-parse --short HEAD) docker compose up -d --build` is the by-hand equivalent. `/api/health` and every error report carry it. Because the image carries it, a new commit is a new image for every service, cache or not: see "deploy script".

There is no video api key. The test does not check one.

Hostnames on the compose network are the service names: `frontend`, `api`, `chat`, `database`, `redis`, `video`, `dummy` (`certs` and `pages` exit before anyone could call them).

## api

JSON. The browser calls these on the frontend origin. The frontend container forwards `/api` to `http://api:4000`.

| method | path | behavior |
|---|---|---|
| PUT | `/api/streamers/:name` | body `{ "bio" }`. upsert the bio. does not start a stream. 403 `that name has an account. log in as it` when the name is claimed and the cookie is not its owner |
| GET | `/api/streamers/:name` | `{ name, bio, verified, avatar }`. empty bio if they never saved one. `avatar` = when the picture was saved (unix seconds) or null |
| PUT | `/api/streamers/:name/avatar` | body: the jpeg bytes themselves (`content-type: image/jpeg`), 256 kb at most, 400 `not a jpeg`, 413 `picture too big`. same 403 as the bio. → `{ name, avatar }`. the page makes the jpeg (the middle square, 256×256, quality 0.85) before sending, so the api never decodes an image |
| GET | `/api/streamers/:name/avatar?v=` | the jpeg, `Cache-Control: public, max-age=86400`. 404 `no picture`. `v` is the `avatar` number above: a new upload is a new url, so the old one may be cached |
| DELETE | `/api/streamers/:name/avatar` | 204. same 403 as the bio |
| GET | `/api/streamers/:name/sessions` | last 20 `{ id, name, started_at, ended_at }` (never the token) |
| GET | `/api/streams` | names `video` reports connected (redis names if `video` is down) → `[{ name, bio, since, verified, avatar }]`, `since` = the open session's `started_at` or null, newest first; `verified` = the live session was started by the account (the open session's flag; false with no open session, and for an anonymous session even after someone signs up as that name) |
| POST | `/api/streams/:name/go-live[?password=]` | 403 `reserved name` for a `dummy-` name without the right password. 403 `that name has an account. log in as it` for a claimed name without its cookie. 503 `video server unreachable` when `video` does not answer, before anything is written. 409 if `video` says the name is connected. If the key exists but `video` has nobody under the name: 409 while the holding session is open and younger than 20s (its publisher is still on its way to `video`); older or ended, the key is stale and is deleted, only if it still holds that id. Insert a session (`token` from the api's os rng, `verified` = the cookie is this name), `SET NX EX 90`; a lost race ends that row and 409s. Then end any other open rows for the name. Returns `{ url: "/ws", session, token }` |
| POST | `/api/streams/:name/heartbeat?session=&token=` | 403 unless that session row is open and the token matches. Then: key held by this session → `EXPIRE 90`, `{ ok }`. Held by another → 409. Gone → re-claim with `SET NX` (`{ ok, reclaimed }`). `video` calls this too, once per publish frame, to check the grant |
| POST | `/api/streams/:name/watch` | `{ url: "/ws", bio, live, verified, avatar }`; `live` from `video` when it answers, else from redis; `verified` = live and the live session was started by the account (never true while offline) |
| POST | `/api/streams/:name/stop?session=&token=` | end that row if it is open and the token matches, else 403 `not your session`. Delete the key only if this session holds it. Query string, so `sendBeacon` can send it |
| GET | `/api/health` | `{ ok, env, build, up_secs, postgres, redis, debug_db, errors_dropped, video, video_up_secs, video_build, live }`. 200 when postgres and redis answer, else 503 with the same body. the probes run concurrently; `debug_db` and the `video` call are capped at 1.5s each. `video` is true when `video`'s `GET /health` answers 2xx; `video_up_secs`, `video_build`, `live` come from that answer (null when it does not come, `video_build` also null on an older video build). `errors_dropped` = reports the rate limit refused in the current 10-min window. see `debugging.md` |
| POST | `/api/errors` | a page reporting its own failure: raw body ≤ 16 KB (413 above), `{ kind, message, stack?, page?, stream?, phase?, build?, ua?, extra? }` (text/plain, sendBeacon). `kind` is one of `crash` `error` `rejection` `soft` `api`. 204 always, also over the limit (60 per ip, then 2000 total, per 10 min; the ip is checked first, so one ip cannot spend the total) and with the debug database or redis down (logged, not stored); 400 only when the body is not that json or `kind` is not in the list. control characters are stripped from every field, `extra` over 2 KB is clipped. every accepted one is a `warn` line in the api log and a row in the debug database |
| GET | `/api/errors?limit=&since=&kind=&page=` | the stored reports, newest first, `limit` ≤ 500 (100), `since` rfc3339 (`Z` or url-encoded; a bare `+` is a space). for a login in `ADMIN_NAMES` or `Authorization: Bearer <OPS_TOKEN>`; 401 otherwise, 404 when neither is configured, 503 `no debug database` when the api has no `DEBUG_DATABASE_URL`, 500 `database error` when it has one and the database does not answer |
| POST | `/api/signup` | `{ name, password }` → 201 `{ name }` + the login cookie. 400 bad name or `password: 8 to 128 characters`, 403 `reserved name` (`dummy-`), 409 `name taken`, 429 after 20 signups from one ip in an hour. a `streamers` row with no hash (a name someone used without an account) is claimed by the first signup, bio and all |
| POST | `/api/login` | `{ name, password }` → 200 `{ name }` + the cookie. 401 `wrong name or password` for both cases, same timing (it hides which of the two was wrong, not that the name exists: `verified` is public). 429 `too many tries. wait 15 minutes` after 10 tries on a name from one ip, or 100 tries from one ip, in 15 minutes; counted before the check, so a parallel burst is counted too; a right one clears the name's count |
| POST | `/api/logout` | 204, deletes that login, clears the cookie. 403 `not from this site` when the browser's `Sec-Fetch-Site` is not `same-origin`/`none` (no header passes) |
| POST | `/api/logout-all` | 204, deletes every login of the account. 401 without one |
| GET | `/api/me` | `{ name }`, `null` for nobody. never an error |
| POST | `/api/password` | `{ old, new }` → 204, every other login of the account is out. 401 without a login, 403 `wrong password`, 429 on the login counter (a wrong `old` is a try at that name from that ip) |

Errors are `{ "error" }`; unknown routes 404 `no such route`; bad JSON 400 `bad json body`; a missing or malformed query string (`stop` without `session`) 400 `bad query string`. `PUT` bio trims and caps at 500 chars. `video` is asked over http with a 1.5s timeout.

### the watch document

`GET /watch/<name>` (and `/watch/<name>/`) is html, the api's only one. Caddy sends `/watch/*` to the api instead of the files. It exists for link previews: iMessage, Discord, Slack and X make the card with a bot that fetches the url once, reads `<title>` and the `og:*` tags, and never runs js, and the spa's `index.html` says "streams" for every page.

The api reads `index.html` from the `pages-data` volume (mounted read-only at `/srv`, `PAGES_DIR`) on every request, so the hashed asset names are always the current build's and `./deploy.sh frontend` needs no api restart. It drops the `<title>`, and before `</head>` adds: `<title>name · live|offline</title>`, `description`, `canonical`, `og:type website`, `og:site_name streams`, `og:title`, `og:description` (the bio as one line, 200 chars, or `live now` / `not live right now`), `og:url` (`https://<host>/watch/<name>`, from the `Host` header caddy passes through, never the query string), `twitter:card`, `twitter:title`, `twitter:description`, and when there is a picture `og:image` + `twitter:image`. The picture is the stream's thumbnail (`/thumb/<name>.jpg`, checked with a `HEAD` to `video`, so a stream younger than ~6s has none) with `summary_large_image` while live, else the profile picture with `summary`, else nothing.

The body is the same `<div id="root">` and `<script>`, so react boots and the watch page runs exactly as from caddy. Inside `#root` goes the profile card from `index.html`'s `<template id="watch-shell">` with `{{avatar}} {{name}} {{verified}} {{status}} {{tone}} {{bio}}` filled in (html-escaped), so the name, picture, status and bio are on screen before the js has loaded; `createRoot().render()` replaces it. The card uses no test ids. `Cache-Control: no-cache`, like `index.html`.

An invalid name or an extra path segment gets the untouched `index.html` with a 404, so the spa shows its own "bad name" / not found. If the volume has no `index.html` yet: 503 `pages not published yet`.

Previews are cached by the chat apps (Discord for hours, X for days, iMessage on the sender's device), so the status in a card is the status at first unfurl. The watch link the live page hands out is therefore `/watch/<name>?s=<session>`: a new url every time you go live, a fresh card every time. The page and the api ignore `?s`. Previews need a certificate the bots trust; with the self-signed one they fetch nothing.

### accounts

Optional. Without one you are whatever name you type, like before. With one, the name is yours: only your login can go live as it, save its bio, or talk as it in chat (an anonymous nick equal to a claimed name is refused). Home and watch show a `✓` on a live stream its account started (the session's flag, not the name's: signing up as a name somebody is streaming under anonymously does not decorate their stream), chat lines said by a login carry `verified`. See `accounts.md` for the why.

- password: normalised (nfkc), then 8 to 128 characters, the same rule at signup, login and change. argon2id (19 MiB, 2 passes, 1 lane) in `spawn_blocking`, at most 4 at a time. the stored string carries salt and settings. the api never logs request bodies.
- login: 32 random bytes, hex, in `login=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`. the `logins` table keeps `sha256(token)`, `name`, `expires_at` (30 days, fixed), `last_seen` (moved at most once an hour). a new login does not end the old ones (many devices); a name's expired rows are swept when it logs in. `Secure` still sets on `http://localhost` (chrome, firefox), so `npm run dev` works. `SameSite=Lax` is the csrf story: another site's form cannot post with the cookie; `logout`, which needs no cookie, checks `Sec-Fetch-Site` as well.
- which names have an account is public: `verified` on `GET /api/streamers/:name`, the lists and watch, the `✓`, and chat's refusal of an anonymous nick on a claimed name all say so. the login error hides which of name and password was wrong, nothing more.
- the cookie goes with the `/chat/:name` handshake too; that is how chat knows you.
- no email, so no reset: `./deploy.sh passwd <name>` (= `docker compose exec api api passwd <name>`) prints a new random password once and logs every login of that name out. on a name with no account it makes one.
- no new secrets. nothing to rotate.
- `video` holds the same gate on the socket: a publish frame carries the go-live `session` and `token`, and `video` asks the api that they are open for that name before it takes the stream (see the ws protocol above). The api decides who may go live; `video` only checks that it did.

Pages, served by `frontend`:

| page | url |
|---|---|
| home | `/` |
| go live | `/live` |
| watch | `/watch/:name` |
| log in, sign up | `/login`, `/signup` |
| admin | `/admin` — this box's `/api/health` and the last error reports, for a login in `ADMIN_NAMES` |

Home poll interval: 3s. No websockets required for the stream list. The video websocket is only for the camera. Three grey placeholder cards (`#loading`) until the first answer; when the api stops answering, `api is down: …` alone (the last list is not kept on screen). The cards live in `#list article` and each thumbnail is `img[data-thumb=<name>]`; the tests key on those. Each card's thumbnail re-fetches on a 5s bucket of the poll's own clock; a 404 (the first picture takes ~6s) only hides it until a later bucket loads.

## client behavior

Go live:

- preview the camera before start. no mic → video only, status "camera ready, no mic"
- start disabled until a name is present and the camera is allowed
- the bio box can `PUT /api/streamers/:name` before or after start. the picture (`#avatar-pick`, a hidden file input) is cut to its middle square, drawn at 256×256 on a canvas, encoded as jpeg and `PUT` to `/api/streamers/:name/avatar`; `#avatar-remove` deletes it
- the streamer's own chat panel joins the room of the name box as last settled (blur, enter, start), not of every keystroke; leaving the name box also loads that name's bio and picture, and another name than before starts those clean
- on start, `POST /api/streams/:name/go-live`, open the video websocket, send `role: publish` plus the WebRTC offer (sendonly transceivers, video capped near 2.5 Mbps), apply the answer. A stop pressed mid-start cancels that attempt cleanly; so does leaving the page mid-prompt (a camera granted after that is stopped, not kept)
- heartbeat every 15s with `?session=&token=`. 403/404/409 means the session is not ours any more: show "session lost. press start again" and do not call stop
- show the watch url, `/watch/<name>?s=<session>` (see "the watch document" for the `?s`)
- stop: clear the timer, close the socket and peer, `POST /api/streams/:name/stop?session=&token=`. Tab close does the same with `sendBeacon`

Watch:

- `POST /api/streams/:name/watch`. If `live` is false, show "not live yet. checking" and retry in 5s. Same after "ended" and after an api error, so a restarted stream shows up on its own
- open the video websocket, send `role: watch` plus a recvonly offer, attach the remote stream from `ontrack`
- start muted. "connected, waiting for video" until frames play, then "watching" and an "unmute" button. If autoplay is refused, the button reads "tap to play". An ice blip reads "reconnecting" (the button stays) and goes straight back to "watching" when the connection returns
- leaving the page mid-request drops that attempt when the grant lands; a newer `watch` call always wins over an older one
- show the picture next to the name and the bio under the video. the tab is titled `<name> · streams`
- after 10s without a connection: "no video. udp blocked?"; `/watch/<name>/` with a trailing slash works too
- **picture in picture** (`#pip`, a toggle): with it on, leaving the page does not end the stream. It keeps playing in a corner of every other page (`#pip-player`: the video, the name as a link back, the status word, `×`), with the sound setting it had. Coming back to its page takes the same connection over (no second `/api/streams/:name/watch`); opening another stream's page ends the first and the corner follows the new one, still on. `×` ends it and turns it off; so does a page load. The player is only the watch session seen from outside the page: the same atoms, the peer connection and socket kept as module handles, so nothing is copied or reconnected. A stream that is not live yet can wait in the corner too ("not live yet. checking")

Use the browser `RTCPeerConnection` directly, no iceServers. One `<video>` element, autoplay, playsinline, muted on the streamer's own preview so they do not hear themselves. The watcher offer has one recvonly video transceiver and one recvonly audio transceiver.

## repo shape

```text
docker-compose.yml   certs, pages, frontend, api, chat, database, redis, video, dummy
deploy.sh            one command. picks PUBLIC_IP, installs docker on linux, builds, starts
.env                 PUBLIC_IP, CARGO_BUILD_JOBS, ENV_NAME (written by deploy.sh), ADMIN_NAMES, OPS_TOKEN, DUMMY_* (.env.example to start by hand)
.deployed            the commit the last deploy.sh run that ended well deployed (gitignored). --pull diffs from it
.dockerignore        keeps target/, frontend, docs, .env and .deployed out of the rust images
Cargo.toml           workspace: video, api. one Cargo.lock (commit it: the images build with --locked)
video/               rust sfu. ws 7880 internal, media udp 7882. Dockerfile with ARG CARGO_BUILD_JOBS
video/src/dummy.rs   `video dummy`, the fake streams. video/Dockerfile.dummy adds a font
video/src/thumbs.rs  one ffmpeg per live stream making /thumb/<name>.jpg. both video images carry a static ffmpeg
api/                 rust axum api on 4000. Dockerfile with ARG CARGO_BUILD_JOBS
api/src/chat.rs      `api chat`, the text chat on 4100. see docs/chat.md
api/src/auth.rs      accounts: signup, login, the cookie, `api passwd`. see docs/accounts.md
api/src/debug.rs     the pages' error reports: POST/GET /api/errors, the `debug` database. see docs/debugging.md
docs/                overview, spec, chat, architecture, accounts, debugging. docs/README.md says which is which
frontend/            react app (vite). see "frontend" above. Dockerfile builds it, Caddyfile serves it
monitor/             docker-compose.yml for the monitor droplet (uptime kuma). see docs/debugging.md
test.sh, test/       browser tests. see "tests" below
```

`certs` writes the cert for `PUBLIC_IP` into the volume before `frontend` starts and keeps it while the SAN still has that ip (so the browser's "proceed" choice survives redeploys). Browsers will still warn. That is fine. `index.html` is served with `Cache-Control: no-cache` and the hashed `/assets/*` as immutable, so a deploy never pairs old js with a new api.

## frontend

Same stack and conventions as Axiom-Frontend, scaled down: Vite 8 + React 19 + TypeScript (strict) + Tailwind 3 with the same token names (`background`, `textPrimary`, `primaryBlue`, `primaryStroke`, `increase`, `decrease`…) fed by css variables, Jotai 2 atoms, React Router 7, TanStack Query for the home poll, `clsx` + `tailwind-merge`, Geist, oxlint + oxfmt (`printWidth` 169, single quotes, no trailing commas).

The look: hard edges. The tailwind theme has no border radius at all (`borderRadius: { none }`, so a `rounded-xl` typed out of habit produces no css), every box is a 1px stroke on the secondary background with a solid offset shadow (`shadow-hard`; `shadow-hard-blue` on hover and focus for boxes that are links, `shadow-hard-lg` for the corner player), buttons move onto their shadow when pressed, inputs turn their border blue on focus instead of a ring, avatars and the live dots are squares, page titles carry a 4px blue bar on the left and the header a rule underneath. `panelClassName()` in `shared-components/Panel.tsx` is the one place the box look lives. The api's pre-react watch card (`api/src/profile.rs`, `index.html`'s template) and the monitor's page (`api/src/monitor.html`) follow the same rules by hand.

Conventions kept from `frontend-conventions.mdc`:

- Session state lives in atoms (`src/infra/atoms/publish-atoms.ts`, `watch-atoms.ts`); the peer connection, socket and timers are module handles because nothing renders from them.
- Every transition is a wrapper action function (`goLive`, `stopLive`, `watch`, `retry`, `markPlaying`…). No `useEffect` that reacts to state. The only effects are mount-only: open the camera, start watching, add `pagehide` listeners, and the cleanup that ends the stream when the route unmounts.
- `store` is the file-level `getDefaultStore()` in `src/infra/store.ts`. `VideoFrame` binds `srcObject` through `store.sub` on a MediaStream atom, not through a reactive effect.
- Element ids and status strings are stable (`#name #start #stop #status #video #unmute #retry`, "live", "watching", "ended…") because the browser tests key on them.

```text
frontend/
  package.json         dev, build (tsc + vite), preview, typecheck, lint (oxlint), format (oxfmt)
  vite.config.mts      port 42069; /api and /ws proxied to $BACKEND, else https://<PUBLIC_IP> from ../.env
  .env.example         BACKEND=https://<server ip>  (copy to frontend/.env, gitignored)
  Dockerfile           node:24 build → alpine image holding dist/ (the `pages` one-shot)
  publish-pages.sh     publishes dist/ into the pages volume caddy serves: assets renamed in first, index.html renamed over last, stale files removed after
  Caddyfile            /api, /ws, /watch/* → api (the watch document; plain index.html when the api is down), spa fallback (try_files … /index.html), cache headers. bind-mounted into caddy
  index.html           the shell, plus <template id="watch-shell">: the profile card the api fills in for /watch/<name>
  src/main.tsx         QueryClientProvider + RouterProvider
  src/router.tsx       / , /live , /watch/:name , /login , /signup , /admin , *   (CrashPage as the error boundary; a Shell renders every page plus MiniPlayer; the watch route is keyed on the name)
  src/app/             HomePage, LivePage, WatchPage, AuthPage, AdminPage, CrashPage, NotFoundPage, globals.css
  src/infra/           api.ts, relay.ts (ws + ice), report.ts (the pages' own failures → /api/errors), names.ts, store.ts, atoms/ (publish, watch, chat, auth)
  src/shared-components/  Button, Panel (the box look), StatusLine, PageFrame, UserBar, VideoFrame, ChatPanel, TestBadge, Avatar, MiniPlayer (picture in picture)
  src/utils/           cn, since
```

Local work: `cd frontend && npm install && npm run dev`, open `http://localhost:42069`. `localhost` is a secure context, so the camera works over plain http. The dev server proxies `/api` and `/ws` to one backend: `BACKEND` (shell env or `frontend/.env`, e.g. `https://192.81.135.162`), else the docker stack on this machine via `PUBLIC_IP` from the repo `.env`. Proxying keeps everything same-origin for the browser, so no CORS and no credentials are involved; the media goes to the backend's ip:7882 directly, exactly as from its own pages. Verified from a laptop against the VPS: publish, watch, frames, ended, 10/10. The `pages` image builds the same code with `npm ci && npm run build`, so no node is needed on the server.

Replacing the frontend: the backend has almost no opinion about it. A new one needs the `/api` routes above, the `/ws` one-frame protocol (`src/infra/relay.ts` is the whole client side of it, ~100 lines), and the publish/watch sequences in `src/infra/atoms/`. The one coupling is the watch document: the api looks for `<title>`, `</head>`, `<div id="root"></div>` and the optional `<template id="watch-shell">` in the built `index.html`. Keep the element ids and status strings if `./test.sh` should keep working.

`video` binds one udp socket, `7882` (udp mux), for every peer. It asks for 4 MB send and receive buffers; the kernel decides (linux caps a plain `SO_SNDBUF`/`SO_RCVBUF` at `net.core.wmem_max`/`net.core.rmem_max`, 208 KB by default, silently) and the startup log says what it got, as a warning when it is less than asked. Those sysctls are not namespaced, so they are set on the host, not in compose. Compose publishes only `7882/udp`. Do not add a second media server. Volumes: `database-data`, `certs-data`, `pages-data`, `caddy-data`, `caddy-config`; `down -v` drops all five.

## deploy script

`deploy.sh` at the repo root. Four modes:

- `./deploy.sh [PUBLIC_IP]` — full deploy, described below. First time on a machine, or whenever the ip changes.
- `./deploy.sh frontend|api|video|dummy …` — partial. Keeps `PUBLIC_IP` from `.env`, rebuilds only the named images, swaps only their containers (`compose up -d --no-deps`), then checks what it swapped — the container is `running` with no restart since the swap and, where the image has a healthcheck (`api`, `chat`, `video`), `healthy` within 60s; `/api/health` alone would not do, it says 200 with `video` down — removes the untagged images the swap left behind (`docker image prune -f`: dangling only, never volumes or the build cache), and then waits for `/api/health`. A container that is not up fails the run with its last 30 log lines; there is no rollback (the old image lost its tag), the way back is a fix and another deploy. Like a full run it checks free disk and adds the swapfile first (swap is session-only, so the first partial after a reboot would otherwise build without it). `frontend` rebuilds `pages` and re-runs the copy, and the one-shot's exit code is the verdict (a full disk fails the run); caddy is not restarted, so live websockets survive. `api` is a few seconds of 502 on `/api`; streams survive (heartbeats ignore non-4xx failures). `video` ends every live stream and prints a warning first. `dummy` rebuilds the fake-stream image and applies the `DUMMY_*` values from `.env`; `video` and `api` are included in that `up` but compose only recreates them if `DUMMY_PASSWORD` changed. An ip argument with services is refused: an ip change is a full deploy.
- `./deploy.sh --pull [services…]` — `git pull --ff-only` first (needs an upstream; refuses otherwise). With no services named, the files changed since the last deploy pick the services: `api/**` → api, `video/**` → video + dummy, `Cargo.toml`/`Cargo.lock` and the root `.dockerignore` → api + video + dummy, `frontend/Caddyfile` → caddy reload in place, other `frontend/**` (its `.dockerignore` included) → frontend, `docker-compose.yml` → `compose up -d`. They run in that order — pages and images first, `compose up -d` last — so the plain `up` starts the new images rather than the old ones. Docs, tests, `monitor/`, `.env.example` and `deploy.sh` itself map to nothing. "Since the last deploy" is `.deployed` (gitignored), written with the commit at the end of every full or partial run that ended well, when it is an ancestor of HEAD; else the pre-pull HEAD. So a `--pull` that died in a build leaves `.deployed` where it was, and the next `--pull` — even with nothing new upstream — says so and redeploys what the failed one did not, instead of "nothing changed". A pull that moves HEAD without touching a service file says which commits it skipped, lands new `.env` keys, and advances `.deployed`. When the pull changed `deploy.sh`, the running script hands over to the new one (`exec`, same arguments, the pre-pull head passed along) before deciding anything; its last line is `main "$@"; exit $?` on purpose, so bash never reads a rewritten file past that point.
- `./deploy.sh passwd <name>` — `docker compose exec api api passwd <name>`: a new random password for that account, printed once, every login of it out. The only reset there is.

Every full or partial run, and a `--pull` that finds nothing to redeploy, also appends to `.env` whatever keys `.env.example` has that `.env` lacks (comment block and default included; `ENV_NAME`, `ADMIN_NAMES`, `OPS_TOKEN`, the `DUMMY_*`), so a pull that brings a new knob leaves it in `.env` to find. Existing lines are never changed, with one exception: an empty or missing `ENV_NAME` is filled in with this machine's hostname (lowercased, `a-z 0-9 -`, 32 chars at most), once.

The images carry `BUILD`, so a new commit is a new image for every service even on a full cache hit, and `compose up -d` swaps every container whose image changed: a full deploy restarts `video` whenever HEAD moved since the last one, and every live stream ends. The script prints the same warning `./deploy.sh video` does before `up`, and does not stop (a full deploy is "everything"). Partial and `--pull` runs touch only what changed, as before.

Full deploy (builds `pages`, `video`, `dummy`, `api`): pick `PUBLIC_IP` (arg > `$PUBLIC_IP` > existing `.env` unless it is `127.0.0.1` > Linux: ipify, `ip route`, `hostname -I`; macOS: en0/en1 > `127.0.0.1` with a warning; warns when `.env` disagrees with what the machine looks like; on Linux, when the pick is on no local interface and the box has a lan ip, a loud warning names both and the command to switch — right behind cloud 1:1 nat, wrong on a home lan, where ipify answers with the router and video stays black for everyone; the pick stands either way); Linux: install docker + compose plugin if missing, refuse if 80/443 are taken by something else (macOS too, via lsof), refuse under 4 GB free disk (6 GB when the swapfile is about to be made out of it), add a 2G swapfile when RAM < 2GB and there is no swap (session only), `ufw allow 80/tcp 443/tcp 7882/udp` if ufw is active (docker-published ports bypass ufw anyway; the rules keep `ufw status` honest); macOS: refuse if Docker Desktop's credential helper hangs; pick `CARGO_BUILD_JOBS` = `$CARGO_BUILD_JOBS` if set, else RAM / 1.5 GB capped at the core count (the `.env` value is overwritten each run); write `.env`, fill in `ENV_NAME` if empty; `docker compose build pages`, then `video`, `dummy`, `api`, each with `--build-arg BUILD=` (a build failure prints the out-of-memory hint), then `up -d`, then `docker image prune -f` (the untagged images the swap left; the build cache stays, `docker builder prune` is yours); poll `https://<PUBLIC_IP>/api/health` with `curl -k` every 3s for up to 120s, accepting `https://127.0.0.1` after 30s (cloud 1:1 nat; the warning says that on a home lan this means the wan ip is in `.env` and video is black for lan watchers); print the url; write `.deployed`; exit non-zero if nothing answered. Rerunnable. Cloud firewalls: open 80/tcp, 443/tcp, 7882/udp by hand.

## tests

`./test.sh [https://ip] [--all]` at the repo root drives the installed Google Chrome through Playwright (`test/`, `npm install` on first run) with a fake camera and mic, so no prompt and nothing recorded. Needs node and Chrome on the machine running the tests; with a url that is any machine, without one it is the server itself (the local-only suites restart containers through `docker compose`, and `auth` and `errors` read redis and the database the same way). With no url it targets the local stack from `.env` and starts it if `/api/health` is down. Stream names are fixed (`e2etest`, `r1`…`r7`, `rd1`, the dummies' own), so one person at a time per server: two people running the suites against one box at once collide, and the `e2e` preflight says so rather than guess (a key left by an aborted run expires within 90s).

| suite | what it proves | where |
|---|---|---|
| `test/e2e.js` | go live → listed on home → watcher decodes frames (`getStats`) → stop → watcher sees ended → unlisted | anywhere |
| `test/dup.js` | second publisher on a live name is refused, first keeps going | anywhere |
| `test/pip.js` | picture in picture: on, home keeps the stream playing in the corner with sound; back on its page the same connection is taken over (one `/watch` call in total); another stream's card replaces it with the toggle still on; `×` ends it and nothing polls the api afterwards; a page load starts clean | anywhere |
| `test/regress.js` | token-gated stop, watcher auto-recovery after a publisher reload, trailing slash, fast `video` restart (under 9s, since compose gives it 10s before SIGKILL; a bare watcher socket must get the `ended` frame; only its own `r4` is asserted gone, dummies reconnect on their own), start/stop/start race, heartbeat ownership, oversized offer, publish without the go-live grant refused | local only (restarts containers) |
| `test/redeploy.js` | `./deploy.sh frontend` and `api` keep a live stream alive; `video` warns and ends it | local only, `--all` |
| `test/dummy.js` | home lists the fake streams, one plays video and audio, `dummy-` names are refused without the password | local only, `--all`, needs `DUMMY_STREAMS ≥ 1` |
| `test/preview.js` | the watch document: `/watch/<name>` is html from the api with `<title>` and `og:*` tags (offline, with a profile picture, live with the thumbnail), the picture round-trips and is the owner's only, the shared link carries `?s=<session>`, the spa still boots on the page the api served | anywhere |
| `test/chat.js` | two viewers talk in an empty room, a reload keeps the history, 501 chars refused and 500 delivered, the streamer's line is marked on a viewer's screen | anywhere |
| `test/auth.js` | sign up (400, 201, 409, `dummy-` 403), a claimed name's go-live and bio are 403 for anyone else, log out (the cookie is cleared) / wrong password / right one, change password, `/api/password` and `/api/logout-all` are 401 for nobody and `logout-all` ends another device's login, a password typed decomposed logs in composed (nfkc, 200 raw chars), 15 wrong tries at once are 10 × 401 + 5 × 429 and then 429, the login form, `?next=/\evil.com` lands on `/`, chat as a login is `verified` and needs no nick, an anonymous claimed nick is refused (uppercase too), log out from the header; locally also `api passwd` (and the login it ends) | anywhere |
| `test/errors.js` | `/api/health` has the monitor fields, a text/plain report is 204 and shows up (the api log locally, `/api/errors` with `OPS_TOKEN`, and the `debug` database locally), garbage and `{}` are 400, the list is 401/404 for a stranger, a throw inside a page is reported with its page, `/admin` renders the health card and a notice for a stranger. off-box without `OPS_TOKEN` the two readback steps are `SKIP`, not `PASS`; locally it deletes the rows it inserted afterwards | anywhere |

Pages keep stable ids and strings for these: `#name #start #stop #status #video #unmute #retry #pip`, the corner player's `#pip-player #pip-video #pip-status #pip-close #pip-unmute`, the chat's `#chat-nick #chat-join #chat-text #chat-send #chat-lines #chat-count #chat-notice` (lines carry `data-streamer="true"` and `data-verified="true"`), the header's `#username #me #logout #login-link`, the form's `#auth-name #auth-password #auth-submit #auth-error`, and the status words `live`, `watching`, `ended…`.

## known limits

- One fan-out task per stream: roughly 150–200 watchers per stream on one core, then egress (~300 at 2.5 Mbps on 1 Gbps). That is the "add fanout computers" step, not this test.
- No simulcast or downstream congestion control. A watcher on a bad link gets loss, not a lower quality.
- No rate limiting on the api or the socket, except the login, signup and error-report counters (see "accounts" and `debugging.md`). Anyone can publish an unclaimed name, watch, or set an unclaimed bio. Session rows grow with every go-live.
- No cpu or memory limits on the containers: small vms vary, and a limit that kills `video` ends every stream at once. `video` and `dummy` carry `pids_limit: 256` (one ffmpeg per live stream, so room for ~25); watch `docker stats` for the rest.
- IPv4 only. UDP-blocked networks cannot watch.

## later, not now

When one machine's outbound bandwidth fills up, run more fanout machines. The streamer node still takes one upload and sends one copy to each fanout machine. Watchers connect to a fanout machine, not to the streamer.

Do not build that split in this test. Do not put transcode on the fanout path. The v1 media process is already "ingest role plus fanout role" so the frontend's api can stay the same when those roles move apart.

## done when

- `./deploy.sh` on a machine, then `https://<PUBLIC_IP>/` loads after the cert warning; `http://` redirects
- streamer can start a named stream from the browser camera and mic
- home shows that name
- a second browser, or a second device, can watch it with visible video and audible sound
- a second person cannot publish to the same name while the first is live
- stop, or closing the streamer tab, removes it from home and ends the watch page
- the sessions endpoint shows `started_at` / `ended_at`
- the site still works if the only configured address is an IP
