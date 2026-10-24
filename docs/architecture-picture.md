# the repo, in pictures

what runs, what talks to what, what builds into what. the words are in `overview.md` and `spec.md`.

## one machine

```mermaid
flowchart LR
  subgraph people["browsers"]
    direction TB
    streamer["streamer<br/>at /live"]
    watcher["watcher<br/>at /watch/name"]
  end

  subgraph box["one machine · docker compose · open 80/tcp 443/tcp 7882/udp"]
    direction TB
    frontend["frontend<br/>caddy · :80 → :443<br/>serves the pages, forwards the rest"]
    api["api<br/>rust axum · :4000<br/>bio, go-live, heartbeat, stop, watch, streams"]
    chat["chat<br/>the api binary run as api chat · :4100<br/>text chat"]
    video["video<br/>rust webrtc · ws :7880 · media udp :7882<br/>one upload in, copies out, thumbnails"]
    database[("database<br/>postgres · streamers, sessions<br/>+ a second database, debug · client_errors")]
    redis[("redis<br/>live:name locks · chat:name streams")]
    dummy["dummy<br/>the video binary run as video dummy<br/>fake streams, off by default"]
    certs["certs<br/>self-signed cert for PUBLIC_IP<br/>runs once, exits"]
    pages["pages<br/>vite build → volume<br/>runs once, exits"]
  end

  streamer -->|"https · pages, /api, /thumb<br/>wss /ws, wss /chat"| frontend
  watcher -->|"https · pages, /api, /thumb<br/>wss /ws, wss /chat"| frontend
  streamer ==>|"webrtc media · udp 7882"| video
  video ==>|"webrtc media · udp 7882"| watcher

  frontend -->|"/api/*"| api
  frontend -->|"/ws · /thumb/*"| video
  frontend -->|"/chat/*"| chat

  api --> database
  api --> redis
  api -.->|"GET /live · who is really connected<br/>GET /health · up_secs, live, build"| video
  streamer -.->|"POST /api/errors · when a page breaks"| frontend
  chat --> redis
  chat -.->|"is this socket the streamer"| database

  dummy -.->|"publishes through /ws like a browser"| video
  dummy -.->|"bio, go-live, heartbeat, stop"| api
  dummy -.->|"pretend viewers"| chat

  certs -.->|"certs-data volume"| frontend
  pages -.->|"pages-data volume"| frontend
```

the frontend never touches video packets. the api serves one html page, `/watch/name`, and it is the pages' own index.html with a different head. video never serves pages.

## what the frontend does with a url

```mermaid
flowchart LR
  http["http://ip/anything"] -->|"redirect"| https["https://ip"]
  https --> q{"path"}
  q -->|"/api/*"| api["api:4000<br/>json"]
  q -->|"/watch/*"| doc["api:4000<br/>index.html from the pages volume<br/>+ title, og tags, profile card for that name<br/>so a shared link gets a preview"]
  q -->|"/ws"| vws["video:7880<br/>websocket · offer in, answer out"]
  q -->|"/thumb/*"| vthumb["video:7880<br/>jpeg of a live stream, a few seconds old"]
  q -->|"/chat/*"| chat["chat:4100<br/>websocket · one per person"]
  q -->|"/assets/*"| assets["/srv/assets<br/>hashed js + css · cache forever"]
  q -->|"anything else"| spa["/srv/index.html<br/>no-cache · react router takes it from here"]
  spa --> home["/<br/>home · who is live"]
  spa --> live["/live<br/>go live"]
  spa --> admin["/admin<br/>this box's health + the pages' error reports · ADMIN_NAMES"]
  doc --> watch["/watch/:name<br/>watch · same js, react replaces the card"]
```

## one stream, start to end

```mermaid
sequenceDiagram
  autonumber
  participant S as streamer browser
  participant A as api
  participant D as database
  participant R as redis
  participant V as video
  participant W as watcher browser

  Note over S,W: everything on :443 goes through caddy. only the udp media goes straight to video

  S->>A: POST /api/streams/billy/go-live
  A->>V: GET /live · is billy already connected?
  A->>D: INSERT sessions (name) → id, random token
  A->>R: SET live:billy = id NX EX 90
  A-->>S: { url: "/ws", session, token }
  S->>V: wss /ws · {"role":"publish","name":"billy","sdp":offer}
  V-->>S: {"sdp": answer}
  S-)V: opus + vp8 over udp 7882
  Note over V: room billy · 2 tracks · a small ffmpeg writes /tmp/thumb-billy.jpg

  loop every 15s
    S->>A: POST heartbeat (session, token)
    A->>D: is that session open, is the token right?
    A->>R: EXPIRE live:billy 90
  end

  loop every 3s, the home page
    W->>A: GET /api/streams
    A->>V: GET /live
    A->>D: bio and started_at for those names
    A-->>W: [{ name, bio, since }] · pictures from /thumb/name.jpg
  end

  W->>A: POST /api/streams/billy/watch
  A->>V: GET /live
  A-->>W: { url: "/ws", bio, live: true }
  W->>V: wss /ws · {"role":"watch","name":"billy","sdp":offer}
  V-->>W: {"sdp": answer}
  V-)W: copies of billy's packets over udp 7882
  W--)V: PLI when the picture is lost
  V--)S: PLI forwarded, at most one per 1.5s

  S->>A: POST stop (session, token) · sendBeacon if the tab closed
  A->>D: UPDATE sessions SET ended_at = now()
  A->>R: DEL live:billy
  S-xV: close /ws
  V-->>W: {"event":"ended"} · socket closed
```

## inside video

```mermaid
flowchart LR
  cam["publisher<br/>browser camera, or the dummy's ffmpeg"]

  subgraph video["video · every peer shares one udp socket :7882"]
    direction LR
    ws["/ws<br/>one json frame in, one out"]
    subgraph room["room billy · in the Hub"]
      direction TB
      pp["publisher peer"]
      tr["2 × TrackLocalStaticRTP<br/>opus · vp8"]
      gen["generation<br/>bumps when the publisher leaves"]
    end
    wp1["watcher peer"]
    wp2["watcher peer"]
    wp3["watcher peer …"]
    ff["ffmpeg<br/>decodes a copy of the vp8<br/>/tmp/thumb-billy.jpg every 5s"]
  end

  w1["watcher"]
  w2["watcher"]
  w3["watcher …"]

  cam -->|"offer / answer"| ws
  w1 -->|"offer / answer"| ws
  cam ==>|"rtp in, once"| pp
  pp -->|"read_rtp · drop header extensions · write_rtp"| tr
  tr --> wp1 & wp2 & wp3
  wp1 ==>|"rtp out, one copy each"| w1
  wp2 ==> w2
  wp3 ==> w3
  tr -.->|"same packets"| ff
  w1 -.->|"PLI · lost the picture"| wp1
  wp1 -.->|"request_keyframe · max 1 per 1.5s"| pp
  pp -.->|"PLI"| cam
  gen -.->|"event ended"| wp1 & wp2 & wp3
```

no decode on the media path. no redis, no database. `GET /live` is the room list. sigterm ends every room at once.

## inside chat

```mermaid
flowchart LR
  v1["viewer"]
  v2["viewer"]
  st["streamer<br/>hello carries session + token"]

  subgraph chatbox["chat · the api binary run as api chat · :4100"]
    direction TB
    sock["one websocket per person<br/>/chat/billy"]
    task["one task per room with people in it<br/>XREAD BLOCK 5000 chat:billy"]
  end

  redis[("redis stream chat:billy<br/>last 500 lines · gone 7 days after the last one")]
  db[("database · sessions")]

  v1 & v2 & st -->|"wss /chat/billy"| sock
  sock -->|"hello → history · XREVRANGE 200"| redis
  sock -->|"say → XADD MAXLEN ~500"| redis
  redis -->|"new entries"| task
  task -->|"message · to every socket in the room"| sock
  sock -.->|"owns_session? → the streamer mark"| db
```

the sender sees its own line come back through the stream like everyone else, so order is the same on every screen.

## who is live

```mermaid
flowchart TB
  q{"is billy live?"}
  q --> video["video · GET /live<br/>rooms with a connected publisher<br/>the truth, when it answers"]
  q --> redis["redis · live:billy = session id<br/>SET NX EX 90 · heartbeat every 15s<br/>a lock, not the truth"]
  q --> db["database · sessions<br/>started_at, ended_at, token<br/>the log, and proof of ownership"]
  video -->|"answers"| yes["home list, watch.live, go-live 409s come from video<br/>a redis key with nobody behind it is deleted"]
  video -->|"does not answer"| no["redis alone decides list and watch<br/>go-live refuses with 503 rather than guess"]
```

## what builds into what

```mermaid
flowchart LR
  subgraph src["repo"]
    cargo["Cargo.toml workspace<br/>api/ · video/ · one Cargo.lock"]
    fe["frontend/<br/>react + vite"]
    caddyfile["frontend/Caddyfile"]
  end

  subgraph images["images"]
    apiimg["stream-api<br/>api/Dockerfile"]
    videoimg["video/Dockerfile<br/>+ static ffmpeg"]
    dummyimg["video/Dockerfile.dummy<br/>same build stage + ffmpeg + a font + the gifs"]
    pagesimg["frontend/Dockerfile<br/>node build → alpine holding dist/"]
    caddyimg["caddy:2-alpine"]
    pgimg["postgres:17-alpine"]
    redisimg["redis:7-alpine"]
    osslimg["alpine/openssl"]
  end

  subgraph containers["containers"]
    api["api"]
    chat["chat · api chat"]
    video["video"]
    dummy["dummy · video dummy"]
    pages["pages · one-shot"]
    frontend["frontend"]
    database["database"]
    redis["redis"]
    certs["certs · one-shot"]
  end

  subgraph vols["volumes"]
    pagesdata[("pages-data → /srv")]
    certsdata[("certs-data → /certs")]
    dbdata[("database-data")]
    caddydata[("caddy-data · caddy-config")]
  end

  cargo --> apiimg --> api
  apiimg --> chat
  cargo --> videoimg --> video
  cargo --> dummyimg --> dummy
  fe --> pagesimg --> pages
  caddyimg --> frontend
  pgimg --> database
  redisimg --> redis
  osslimg --> certs

  pages -->|"publish-pages.sh · new files first, then stale ones removed"| pagesdata -->|"ro"| frontend
  certs -->|"cert.pem key.pem"| certsdata -->|"ro"| frontend
  caddyfile -.->|"bind mount · reloaded in place"| frontend
  database --> dbdata
  frontend --> caddydata
```

redis has no volume. who is live clears when it restarts. the database keeps the bio and the log.

## the repo, folder by folder

```text
docker-compose.yml       the services above, their env, ports, volumes
deploy.sh                one command: pick PUBLIC_IP, write .env, build, up, wait for /api/health
test.sh  test/           playwright + chrome with a fake camera: e2e, dup, chat, auth, preview, errors, regress, redeploy, dummy
.env  .env.example       PUBLIC_IP, CARGO_BUILD_JOBS, ENV_NAME, ADMIN_NAMES, OPS_TOKEN, DUMMY_STREAMS, DUMMY_PASSWORD, DUMMY_NAMES
Cargo.toml  Cargo.lock   one rust workspace, two members

api/                     → containers api, chat
  src/main.rs              axum on :4000. bios, go-live, heartbeat, stop, watch, streams, health
  src/chat.rs              `api chat` on :4100. websocket chat on redis streams
  src/debug.rs             POST/GET /api/errors, the debug database. see docs/debugging.md
  Dockerfile               rust:1-bookworm build → debian-slim, one binary

video/                   → containers video, dummy
  src/main.rs              ws :7880 · /ws /live /thumb /health. udp 7882 mux. Hub → rooms → tracks
  src/media.rs             opus + vp8 only, nack, twcc for the publisher
  src/thumbs.rs            one ffmpeg per publisher → /tmp/thumb-<name>.jpg
  src/dummy.rs             `video dummy`: ffmpeg bouncing gifs published through /ws
  gifs/                    the gifs it bounces. shrunk at image build time
  Dockerfile               + static ffmpeg
  Dockerfile.dummy         + static ffmpeg + a font + the gifs, entrypoint `video dummy`

frontend/                → containers pages (build), frontend (caddy)
  Caddyfile                /api /ws /chat /thumb, spa fallback, cache headers
  Dockerfile               node build → alpine with dist/ + publish-pages.sh
  vite.config.mts          dev on :42069, proxies /api /ws /chat /thumb to BACKEND
  src/router.tsx           /  /live  /watch/:name  /admin  *   (CrashPage as the error boundary)
  src/app/                 HomePage  LivePage  WatchPage  AdminPage  CrashPage  NotFoundPage
  src/infra/api.ts         fetch wrappers for /api
  src/infra/report.ts      the pages' own failures → POST /api/errors (sendBeacon)
  src/infra/relay.ts       the /ws one-frame protocol + RTCPeerConnection
  src/infra/atoms/         publish, watch, chat, auth session state (jotai)
  src/shared-components/   Avatar  Button  ChatPanel  GeneratedAvatar  PageFrame  StatusLine  TestBadge  UserPanel  VideoFrame

monitor/                 docker-compose.yml for the monitor droplet: uptime kuma polling every box. docs/debugging.md
docs/                    overview, spec, chat, architecture, accounts, kubernetes, debugging, this file
```

## deploy

```mermaid
flowchart LR
  ip["pick PUBLIC_IP<br/>arg › env › .env › detect"] --> env["write .env<br/>+ CARGO_BUILD_JOBS from ram<br/>+ ENV_NAME = hostname when empty"] --> build["get pages, video, dummy, api<br/>one at a time · tag = BUILD = last commit touching image-paths"] --> up["compose up -d<br/>video restarts when the images moved"] --> wait["poll https://ip/api/health<br/>up to 120s"]
```

```mermaid
flowchart LR
  fe["./deploy.sh frontend"] --> pagesc["pages rebuilt, files copied<br/>caddy untouched · streams stay up"]
  apid["./deploy.sh api"] --> apic["api + chat swapped<br/>a few seconds of 502 · streams stay up"]
  vid["./deploy.sh video"] --> videoc["video swapped<br/>ends every stream · warns first"]
  dum["./deploy.sh dummy"] --> dummyc["dummy rebuilt<br/>DUMMY_* from .env"]

  pull["./deploy.sh --pull"] --> gp["git pull --ff-only"] --> diff{"what changed?"}
  diff -->|"api/**"| apic
  diff -->|"video/**"| videoc & dummyc
  diff -->|"Cargo.toml · Cargo.lock"| apic & videoc & dummyc
  diff -->|"frontend/Caddyfile"| reload["caddy reload in place"]
  diff -->|"other frontend/**"| pagesc
  diff -->|"docker-compose.yml"| compose["compose up -d"]
  diff -->|"docs only"| nothing["nothing"]
```

## from a laptop

```mermaid
flowchart LR
  dev["browser<br/>http://localhost:42069"] --> vite["vite dev server<br/>frontend/ · edits show up live"]
  vite -->|"/api /thumb /ws /chat proxied"| stack["the stack<br/>BACKEND, else https://PUBLIC_IP from .env"]
  dev ==>|"webrtc media · udp 7882"| stack

  ts["./test.sh<br/>optional url · optional --all"] --> pw["playwright · installed chrome<br/>fake camera + mic"]
  pw -->|"e2e · dup · chat · auth · preview · errors"| stack
  pw -->|"regress · redeploy · dummy<br/>local stack only, they restart containers"| stack
```
