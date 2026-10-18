# test stream — build spec

Source of truth for product decisions is `new-plan-human.md`. If they conflict, follow the human file. This file is the implementable version of that plan, and it describes what is in the repo now.

## goal

Run one program set on one machine. A person opens `https://<that-machine-ip>` and either goes live from the browser or watches someone who is live.

One streamer per stream. Many watchers. The streamer uploads once. The machine copies packets to each watcher. No transcode. No accounts.

This is a lab. It is reachable by anyone who can hit the IP. That is accepted.

## non-goals

Do not build these.

- accounts, passwords, stream keys, permission roles
- chat, follows, vod, recording, moderation
- transcoding, simulcast, quality ladder, cdn
- group calls where several people publish into one room
- a second machine, a real fanout tier, TURN, ICE-TCP
- mobile apps, OBS ingest, RTMP

Leaving them out is the point of the test. Structure the media path so a later fanout machine can be added without rewriting the site.

## what the user sees

Three pages. One site.

| page | url | what it does |
|---|---|---|
| home | `/` | lists streams that are live right now. each row links to watch. a button links to go live |
| go live | `/live` | camera preview. a name field. a bio box. start sends the camera. stop ends it |
| watch | `/watch/:name` | plays that stream and shows that streamer's bio. if nobody is live, says so and retries every 5s |

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

One machine. Seven services in `docker-compose.yml`; `certs` and `pages` run once and exit.

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
  browser -->|media udp :7882| video
```

| container | job |
|---|---|
| pages | built from `frontend/`: node builds the React app (Vite); the final image only copies `dist/` into the `pages-data` volume (`publish-pages.sh`: new files first, then stale ones removed) and exits. Re-running it is how the pages redeploy, without touching caddy |
| frontend | `caddy:2-alpine`, no custom build. serves the `pages-data` volume as a single-page app (`try_files … /index.html`). `/api/*` → `api:4000`, `/ws` → `video:7880`. https :443 with the volume cert. :80 redirects to https. The Caddyfile is a bind mount; `deploy.sh` reloads caddy in place when it changes |
| api | Rust (axum) in `api/`. bios, sessions, live list, heartbeats |
| database | postgres. `streamers(name, bio, updated_at)`, `sessions(id, name, token, started_at, ended_at)`. no host port; peek with `docker compose exec database psql -U stream` |
| redis | `live:<name>` = session id, 90s TTL, kept alive by the page's heartbeat. no host port; peek with `docker compose exec redis redis-cli` |
| video | Rust (webrtc-rs) in `video/`. one upload in, packet copies out. all media on udp 7882. Opus + VP8 only. this is ingest and fanout for the test |
| certs | `alpine/openssl`. writes a self-signed cert for `PUBLIC_IP` into a volume (EC P-256, 825 days, SAN = ip + 127.0.0.1 + localhost, serverAuth), exits. reused while the SAN still matches |

The frontend never touches video packets. The api never serves HTML. `video` never serves pages.

`video` speaks one websocket on `:7880/ws` (not published; reached through the frontend). The browser sends a single JSON text frame, then keeps the socket open until it hangs up.

```json
{"role":"publish","name":"billy","sdp":"<offer sdp>"}
{"role":"watch","name":"billy","sdp":"<offer sdp>"}
```

The server answers `{"sdp":"<answer sdp>"}`. `"error"` instead of `"sdp"` means no: `"someone is already live"`, `"not live"`, `"bad name…"`, `"bad offer"` (over 32 KB, over 4 media lines, or unparseable), `"could not negotiate"`, `"server error"`. The browser has 10s to send its frame and the server 10s to answer. A watcher waits up to 8s for a publisher that is still setting up. When the publisher leaves, watchers get `{"event":"ended"}` and the socket closes. A new watcher gets one keyframe request on connect; further watcher PLI/FIR are forwarded at most once per 1.5s per stream. Header extensions from the publisher are stripped before fan-out. Lost packets are re-sent to watchers from a 512-packet history. ICE gives up on a vanished peer after 15s. On SIGTERM every room ends, every watcher gets `ended`, and the process exits at once.

No token on the socket. Anyone who can open it can publish. `video` does not read redis or the database. It exposes `GET /live` (sorted JSON array of names connected right now) and `GET /health` (`ok`).

What each store holds:

- **database** — `streamers`: `name`, `bio`, `updated_at`. `sessions`: one row per go-live with a random `token`, `ended_at` null while live. Survives a restart. No passwords, no vod. A bio can exist while they are offline.
- **redis** — `live:<name>` = session id, `SET NX EX 90`. Heartbeat refreshes every 15s; `stop` deletes. It is a lock, not the truth: when `video` answers, the api uses `video`'s connected list for home and for `watch.live`, treats a key with no connected publisher as stale (deleted on the next go-live), and refuses a go-live when `video` says the name is connected even if the key is gone. When `video` does not answer, redis alone decides, and go-live refuses (503) rather than guess.

## browser https rule

`getUserMedia` only runs in a secure context. `http://<ip>` redirects to https. Serve the site on https with a self-signed cert. The browser warning is expected. After the user proceeds, the camera works.

WebRTC signaling from the page must use `wss` to the same host, proxied to `video` at `/ws`. Otherwise a https page will refuse a `ws` socket. The api returns `url: "/ws"`; the page builds `wss://<location.host>/ws`.

## deploy

`./deploy.sh` on the machine. It picks `PUBLIC_IP`, writes `.env`, builds the two Rust images one at a time, runs Docker Compose, and waits for `/api/health`. From another device on the same network, or from the public internet if the ports are open, browse to the machine IP.

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

The database volume keeps bios and sessions. Redis does not use a volume, so "who is live" clears when that container restarts. The cert is a named volume written by `certs`; nothing in the repo.

## config

`.env` holds the values that change per machine: `PUBLIC_IP` and `CARGO_BUILD_JOBS`. `deploy.sh` writes both. Database and redis passwords in this test are the literals in `docker-compose.yml` (`stream` / no redis password).

The api container receives:

```text
DATABASE_URL=postgres://stream:stream@database:5432/stream
REDIS_URL=redis://redis:6379/0
VIDEO_URL=http://video:7880
PORT=4000
```

The video container receives `PUBLIC_IP`, `WS_PORT=7880`, `UDP_PORT=7882`, `RUST_LOG=warn,video=info,webrtc_ice=error`.

There is no video api key. The test does not check one.

Hostnames on the compose network are the service names: `frontend`, `api`, `database`, `redis`, `video`.

## api

JSON. The browser calls these on the frontend origin. The frontend container forwards `/api` to `http://api:4000`.

| method | path | behavior |
|---|---|---|
| PUT | `/api/streamers/:name` | body `{ "bio" }`. upsert the bio. does not start a stream |
| GET | `/api/streamers/:name` | `{ name, bio }`. empty bio if they never saved one |
| GET | `/api/streamers/:name/sessions` | last 20 `{ id, name, started_at, ended_at }` (never the token) |
| GET | `/api/streams` | names `video` reports connected (redis names if `video` is down) → `[{ name, bio, since }]`, `since` = the open session's `started_at` or null, newest first |
| POST | `/api/streams/:name/go-live` | 409 if `video` says the name is connected. If the key exists: delete it when `video` says not connected, else 409 (503 if `video` is down). Insert a session, `SET NX EX 90`; a lost race ends that row and 409s. Then end any other open rows for the name. Returns `{ url: "/ws", session, token }` |
| POST | `/api/streams/:name/heartbeat?session=&token=` | 403 unless that session row is open and the token matches. Then: key held by this session → `EXPIRE 90`, `{ ok }`. Held by another → 409. Gone → re-claim with `SET NX` (`{ ok, reclaimed }`) |
| POST | `/api/streams/:name/watch` | `{ url: "/ws", bio, live }`; `live` from `video` when it answers, else from redis |
| POST | `/api/streams/:name/stop?session=&token=` | end that row if it is open and the token matches, else 403 `not your session`. Delete the key only if this session holds it. Query string, so `sendBeacon` can send it |
| GET | `/api/health` | `{ ok }` when postgres and redis answer, else 503 |

Errors are `{ "error" }`; unknown routes 404 `no such route`; bad JSON 400. `PUT` bio trims and caps at 500 chars. `video` is asked over http with a 1.5s timeout.

Pages, served by `frontend`:

| page | url |
|---|---|
| home | `/` |
| go live | `/live` |
| watch | `/watch/:name` |

Home poll interval: 3s. No websockets required for the stream list. The video websocket is only for the camera.

## client behavior

Go live:

- preview the camera before start. no mic → video only, status "camera ready, no mic"
- start disabled until a name is present and the camera is allowed
- the bio box can `PUT /api/streamers/:name` before or after start
- on start, `POST /api/streams/:name/go-live`, open the video websocket, send `role: publish` plus the WebRTC offer (sendonly transceivers, video capped near 2.5 Mbps), apply the answer. A stop pressed mid-start cancels that attempt cleanly
- heartbeat every 15s with `?session=&token=`. 403/404/409 means the session is not ours any more: show "session lost. press start again" and do not call stop
- show the watch url
- stop: clear the timer, close the socket and peer, `POST /api/streams/:name/stop?session=&token=`. Tab close does the same with `sendBeacon`

Watch:

- `POST /api/streams/:name/watch`. If `live` is false, show "not live yet. checking" and retry in 5s. Same after "ended" and after an api error, so a restarted stream shows up on its own
- open the video websocket, send `role: watch` plus a recvonly offer, attach the remote stream from `ontrack`
- start muted. "connected, waiting for video" until frames play, then "watching" and an "unmute" button. If autoplay is refused, the button reads "tap to play"
- show the bio under the video
- after 10s without a connection: "no video. udp blocked?"; `/watch/<name>/` with a trailing slash works too

Use the browser `RTCPeerConnection` directly, no iceServers. One `<video>` element, autoplay, playsinline, muted on the streamer's own preview so they do not hear themselves. The watcher offer has one recvonly video transceiver and one recvonly audio transceiver.

## repo shape

```text
docker-compose.yml   certs, frontend, api, database, redis, video
deploy.sh            one command. picks PUBLIC_IP, installs docker on linux, builds, starts
.env                 PUBLIC_IP, CARGO_BUILD_JOBS. written by deploy.sh (.env.example to start by hand)
.dockerignore        keeps target/, frontend, docs and .env out of the rust images
Cargo.toml           workspace: video, api. one Cargo.lock (commit it: the images build with --locked)
video/               rust sfu. ws 7880 internal, media udp 7882. Dockerfile with ARG CARGO_BUILD_JOBS
api/                 rust axum api on 4000. Dockerfile with ARG CARGO_BUILD_JOBS
frontend/            react app (vite). see "frontend" above. Dockerfile builds it, Caddyfile serves it
```

`certs` writes the cert for `PUBLIC_IP` into the volume before `frontend` starts and keeps it while the SAN still has that ip (so the browser's "proceed" choice survives redeploys). Browsers will still warn. That is fine. `index.html` is served with `Cache-Control: no-cache` and the hashed `/assets/*` as immutable, so a deploy never pairs old js with a new api.

## frontend

Same stack and conventions as Axiom-Frontend, scaled down: Vite 8 + React 19 + TypeScript (strict) + Tailwind 3 with the same token names (`background`, `textPrimary`, `primaryBlue`, `primaryStroke`, `increase`, `decrease`…) fed by css variables, Jotai 2 atoms, React Router 7, TanStack Query for the home poll, `clsx` + `tailwind-merge`, Geist, oxlint + oxfmt (`printWidth` 169, single quotes, no trailing commas).

Conventions kept from `frontend-conventions.mdc`:

- Session state lives in atoms (`src/infra/atoms/publish-atoms.ts`, `watch-atoms.ts`); the peer connection, socket and timers are module handles because nothing renders from them.
- Every transition is a wrapper action function (`goLive`, `stopLive`, `watch`, `retry`, `markPlaying`…). No `useEffect` that reacts to state. The only effects are mount-only: open the camera, start watching, add `pagehide` listeners, and the cleanup that ends the stream when the route unmounts.
- `store` is the file-level `getDefaultStore()` in `src/infra/store.ts`. `VideoFrame` binds `srcObject` through `store.sub` on a MediaStream atom, not through a reactive effect.
- Element ids and status strings are stable (`#name #start #stop #status #video #unmute #retry`, "live", "watching", "ended…") because the browser tests key on them.

```text
frontend/
  package.json         dev, build (tsc + vite), preview, typecheck, lint (oxlint), format (oxfmt)
  vite.config.mts      port 3000; /api and /ws proxied to https://<PUBLIC_IP> from ../.env
  Dockerfile           node:24 build → alpine image holding dist/ (the `pages` one-shot)
  publish-pages.sh     copies dist/ into the pages volume caddy serves
  Caddyfile            /api, /ws, spa fallback (try_files … /index.html), cache headers. bind-mounted into caddy
  src/main.tsx         QueryClientProvider + RouterProvider
  src/router.tsx       / , /live , /watch/:name , *
  src/app/             HomePage, LivePage, WatchPage, NotFoundPage, globals.css
  src/infra/           api.ts, relay.ts (ws + ice), names.ts, store.ts, atoms/
  src/shared-components/  Button, StatusLine, PageFrame, VideoFrame
  src/utils/           cn, since
```

Local work: start the stack (`./deploy.sh`), then `cd frontend && npm install && npm run dev`, open `http://localhost:3000`. `localhost` is a secure context, so the camera works over plain http; the dev server proxies `/api` and `/ws` to the running stack and the media goes to `<PUBLIC_IP>:7882` as always. The `pages` image builds the same code with `npm ci && npm run build`, so no node is needed on the machine.

`video` binds one udp socket, `7882` (udp mux, 4 MB buffers), for every peer. Compose publishes only `7882/udp`. Do not add a second media server. Volumes: `database-data`, `certs-data`, `caddy-data`, `caddy-config`; `down -v` drops all four.

## deploy script

`deploy.sh` at the repo root. Three modes:

- `./deploy.sh [PUBLIC_IP]` — full deploy, described below. First time on a machine, or whenever the ip changes.
- `./deploy.sh frontend|api|video …` — partial. Keeps `PUBLIC_IP` from `.env`, rebuilds only the named images, swaps only their containers (`compose up -d --no-deps`), then waits for `/api/health`. `frontend` rebuilds `pages` and re-runs the copy; caddy is not restarted, so live websockets survive. `api` is a few seconds of 502 on `/api`; streams survive (heartbeats ignore non-4xx failures). `video` ends every live stream and prints a warning first. An ip argument with services is refused: an ip change is a full deploy.
- `./deploy.sh --pull [services…]` — `git pull --ff-only` first (needs an upstream; refuses otherwise). With no services named, the files changed between the old and new HEAD pick the services: `api/**` → api, `video/**` → video, `Cargo.toml`/`Cargo.lock` → api + video, `frontend/Caddyfile` → caddy reload in place, other `frontend/**` → frontend, `docker-compose.yml` → `compose up -d`. Docs-only pulls redeploy nothing.

Full deploy: pick `PUBLIC_IP` (arg > `$PUBLIC_IP` > existing `.env` unless it is `127.0.0.1` > Linux: ipify, `ip route`, `hostname -I`; macOS: en0/en1 > `127.0.0.1` with a warning; warns when `.env` disagrees with what the machine looks like); Linux: install docker + compose plugin if missing, refuse if 80/443 are taken by something else (macOS too, via lsof), refuse under 4 GB free disk, add a 2G swapfile when RAM < 2GB and there is no swap (session only), `ufw allow 80/tcp 443/tcp 7882/udp` if ufw is active; macOS: refuse if Docker Desktop's credential helper hangs; pick `CARGO_BUILD_JOBS` = `$CARGO_BUILD_JOBS` if set, else RAM / 1.5 GB capped at the core count (the `.env` value is overwritten each run); write `.env`; `docker compose build pages`, then `video`, then `api` (a build failure prints the out-of-memory hint), then `up -d`; poll `https://<PUBLIC_IP>/api/health` with `curl -k` every 3s for up to 120s, accepting `https://127.0.0.1` after 30s (cloud 1:1 nat); print the url; exit non-zero if nothing answered. Rerunnable. Cloud firewalls: open 80/tcp, 443/tcp, 7882/udp by hand.

## known limits

- One fan-out task per stream: roughly 150–200 watchers per stream on one core, then egress (~300 at 2.5 Mbps on 1 Gbps). That is the "add fanout computers" step, not this test.
- No simulcast or downstream congestion control. A watcher on a bad link gets loss, not a lower quality.
- No rate limiting on the api or the socket. Anyone can publish, watch, or set a bio. Session rows grow with every go-live.
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
