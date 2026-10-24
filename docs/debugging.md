# debugging

how you find out something broke, and what. three layers, each cheap.

- **is the box up** — a monitor on a different machine polls every box and tells you. our own code: `api monitor`, one container, one json file, one page.
- **what broke for a person** — the pages report their own failures to `/api/errors`. the api keeps them in a separate `debug` database. `/admin` shows them, and so does the monitor, for every box at once.
- **what is the box doing** — digitalocean's own graphs for cpu, ram, disk and, the one that matters for video, outbound bandwidth.

built: the health answer, the error reports, the debug database, `/admin`, the monitor (`api monitor`, its page, its compose file, `./status.sh` for a look from a shell). not built: the monitor box itself (you make it, ten minutes), the watcher bot, grafana. see the end.

## the shape

```mermaid
flowchart LR
  subgraph prod["prod droplet"]
    pfe[pages] -->|"POST /api/errors<br/>same origin · sendBeacon"| papi[api]
    papi --> pdb[(stream db)]
    papi --> pdbg[(debug db)]
    papi -.->|"GET /health"| pvideo[video]
  end
  subgraph dev["dev droplet"]
    dfe[pages] --> dapi[api]
    dapi --> ddb[(stream db)]
    dapi --> ddbg[(debug db)]
  end
  subgraph mon["monitor box · loopback only"]
    monitor["api monitor<br/>polls · remembers · alerts · one page"]
    file[("monitor.json")]
  end
  monitor --> file
  monitor -->|"GET /api/health every 15s<br/>GET /api/errors every minute"| papi
  monitor -->|"same"| dapi
  monitor -->|"webhook on down and up"| you[you]
  you -->|"ssh -L 3002 · http://localhost:3002"| monitor
  you -->|"https://prod-ip/admin · login cookie"| papi
```

## four rules

1. **the monitor is somewhere else, and it pulls.** a dead droplet cannot post "i am dead". and it is our code, built from this repo like everything else: one more `api` subcommand, not a product nobody here has read.
2. **the browser reports to its own origin.** never to the monitor. the droplets have self-signed certs, and a browser silently refuses a cross-origin call to a second self-signed box you never clicked through. same origin also means `sendBeacon` with no cors, the same trick `stop` uses when a tab closes.
3. **debug plumbing can never hurt the app.** its own database, a lazy pool, every failure logged and swallowed, body capped, rate limited. the api starts and serves with the debug database gone.
4. **everything carries `env` and `build`.** which droplet, which commit. without those the error table is noise after the second deploy.

## env and build

- `ENV_NAME` in `.env`: `prod`, `dev`, whatever you call the box. empty or missing, `deploy.sh` writes this machine's hostname into `.env` once (lowercased, `a-z 0-9 -`, 32 chars at most) and never touches a value that is set; an empty value left by hand is `unnamed` in the api. (not `ENV`: `sh` reads `$ENV` as a startup file.) the api puts it in every health answer and every stored error.
- `BUILD`: `deploy.sh`, `ship.sh` and the action set it to the last commit that touched what the images are built from (`image-paths`: `api/`, `video/`, `frontend/` minus the Caddyfile, `Cargo.*`, `.dockerignore`, the workflow; 7 characters; the image tag), plus `-dirty` when those have edits or new files (docs, tests and the script itself do not count), and passes it as a build arg to `pages`, `api`, `video`, `dummy`: in the compose file and again on the `compose build` command line, so the `sudo docker` fallback (which resets the environment) cannot lose it. it is baked into the image, so a container reports the commit it was built from, not the commit on disk. built by hand without `deploy.sh`: `dev`, or `BUILD=$(git rev-parse --short HEAD) docker compose up -d --build`. the pages get it as `__BUILD__` (vite `define`).
- the price: a new commit is a new image for every service, cache hit or not. a full `./deploy.sh` after a commit therefore swaps `video` too and ends every live stream, where before it only swapped what the build changed. the script says so before `up`, the same warning `./deploy.sh video` prints. `./deploy.sh --pull` and `./deploy.sh api` still touch only what changed.

## health

`GET /api/health`:

```json
{ "ok": true, "env": "prod", "build": "d668007", "up_secs": 8123,
  "postgres": true, "redis": true, "debug_db": true, "errors_dropped": 0,
  "video": true, "video_up_secs": 8120, "video_build": "d668007", "live": 3 }
```

- 200 when postgres and redis answer, 503 otherwise, like before. `deploy.sh` and the image healthchecks still key on the status.
- the probes run concurrently, and the optional ones (debug database, video) are capped at 1.5s each, so the answer fits inside the image healthcheck's 3s timeout.
- `video` is whether `video`'s `GET /health` answered 2xx inside 1.5s (an old video build that still says `ok` counts); `live` is its room count; `video_up_secs` how long it has run; `video_build` its commit, `null` on a build older than this. all `null` when it did not answer. the api already degrades without video, so that is not a 503.
- `errors_dropped`: how many reports the rate limit refused in the current 10-minute window. a number that climbs is a page in a loop somewhere.
- `up_secs` resets when a process restarts. a monitor that sees it go backwards knows "api restarted at 03:12" with no docker access. same for `video_up_secs`.
- `video`'s own `GET /health` is json now: `{ ok, up_secs, build, live }`. still inside the compose network.

the free deep check: `GET /thumb/dummy-mango.jpg` is 200 only when a dummy is publishing *and* ffmpeg is decoding it. with `DUMMY_STREAMS=1` that is the whole media path on that box, end to end, refreshed every 5s. it does not prove udp from outside; that is the watcher bot, later.

## what the pages report

one function, `report()` in `frontend/src/infra/report.ts`. five places call it:

- `<RouterProvider onError>` — a render crash inside a page, once per crash, with react's component stack and the route pattern (`/watch/:name`), so one broken page is one row however many names hit it. `createRoot(root, { onUncaughtError })` stays as the last resort for a crash outside the router (the crash page itself, say).
- `window` `error` — a throw in a handler or a timer. react does not see those.
- `window` `unhandledrejection` — a promise nobody caught.
- `failed` in `watch-atoms.ts` and `publish-atoms.ts` — the ones that matter here: `no video. udp blocked?`, `connection failed`, `connection lost`, `session lost`. these are not crashes, they are the product not working. a failed watch attempt is exactly one report: the page does not retry on its own out of `failed`, the person presses retry.
- `request()` in `api.ts` on a 5xx the api itself answered — the api dying, seen from outside. not caddy's 502/504 while the api restarts, not a network failure (those are the box being down, and the monitor's job). sent after the body is read, so it carries the api's own error text; the path goes without its query string. a go-live refused with a 4xx (reserved name, a claimed name, 409) is not a report: the api said no, nothing broke.

what goes in one report:

| field | what |
|---|---|
| `kind` | `crash` `error` `rejection` `soft` `api` |
| `message` | 500 chars max |
| `stack` | 8000 chars max. the component stack for a crash |
| `page` | `location.pathname`, `/watch/billy` |
| `stream`, `phase` | the stream and the watch/publish phase at the time |
| `build` | `__BUILD__` |
| `ua` | `navigator.userAgent` |
| `extra` | for `soft`: `connectionState`, `iceConnectionState`, and the selected candidate pair from `getStats()` (bytes in and out, rtt, candidate types). that is what separates "udp blocked" from "video is dead" |

the api adds `env`, `ip` (from caddy's `X-Forwarded-For`, like login), `me` (the login, if any) and `at`.

- transport: `navigator.sendBeacon('/api/errors', json)`, fallback `fetch` with `keepalive`. sendBeacon sends `text/plain`, so the api reads the raw body, not the json extractor.
- the same message inside 30s is not sent again. a budget per kind per page load: 20 each, `api` 5; then that kind goes quiet. a render loop otherwise produces thousands, and an api that is down for an hour would crowd out the one crash that mattered.
- a crash shows `CrashPage` ("something broke. a report went out. a reload usually fixes it.", a reload button) instead of react router's default page. it only displays; the report already went.
- production builds emit hidden sourcemaps: a `.map` beside each hashed asset, not referenced from the js, so browsers never fetch it. a minified stack from `/admin` plus that map, through any source-map tool, gives the file and line back.
- `npm run dev` reports too, to whichever backend the proxy points at, with `build: "dev"`.

## the api side

| | route | does |
|---|---|---|
| POST | `/api/errors` | raw body ≤ 16 KB (413 above that), parsed as the json above. 204 always, also when rate limited and when the debug database is down. 400 only for a body that is not that json, or a `kind` outside `crash` `error` `rejection` `soft` `api`. control characters are stripped from every field; `extra` over 2 KB is clipped. 60 per ip per 10 min, 2000 total per 10 min, counted in redis like the login limits: the ip's count is checked first and the total only bumped for a report that passed it, so one page in a loop cannot spend everyone's budget. drops are counted and shown as `errors_dropped` in `/api/health`. redis down: the report is logged, not stored. every accepted report is also one `warn` line in the api log: `docker compose logs -f api` is a working dashboard on day one |
| GET | `/api/errors?limit=&since=&kind=&page=` | newest first, `limit` ≤ 500 (100). needs an admin (below): 401 otherwise, 404 when no admin is configured at all, so the route does not exist for anyone else. 503 `no debug database` when the api has no `DEBUG_DATABASE_URL`; 500 `database error` when it has one and the database does not answer. `since` is rfc3339 ending in `Z`, or url-encoded: a bare `+` in a query string is a space |

who is an admin:

- `ADMIN_NAMES=billy,alice` in `.env`: those accounts, by the login cookie. that is what `/admin` in the pages uses. each name must already have an account on that box (sign up, or `./deploy.sh passwd <name>`); a name without one is dropped at boot, with an error line in the api log.
- `OPS_TOKEN=<long random string>` in `.env`: `Authorization: Bearer <that>`. for a machine, the monitor later. 16 characters at least; shorter is ignored, with a warn line at boot. `openssl rand -hex 32` makes one.

what a report says about a person: the ip, the login name if there was one, the user agent, and the page path, which for `/watch/billy` is the stream they were watching. kept 14 days, visible to every name in `ADMIN_NAMES` and to whoever holds `OPS_TOKEN`. that is the trade for knowing what broke for whom; keep the admin list short and do not point `/api/errors` at anything that keeps it longer.

## the debug database

a separate **database**, same postgres container. not a table in `stream`, not a schema in it.

- `DEBUG_DATABASE_URL=postgres://stream:stream@database:5432/debug`. the api makes the database at boot when it is missing (`stream` is the superuser in this compose, and the api already runs its own schema the same way), then its one table.
- a lazy pool, 2 connections, 1s to get one. the api never waits for it and never fails because of it. missing, down, full: the report goes to the log and the request still gets its 204.
- peek: `docker compose exec database psql -U stream -d debug`. wipe: `docker compose exec database psql -U stream -c 'DROP DATABASE debug WITH (FORCE)'`, then `docker compose restart api` and it makes the database again on its way up. `FORCE` because the api's pool keeps a connection open (its healthcheck probes the debug database every 15s); a plain `DROP` says `being accessed by other users`. `pg_dump stream` never sees it.
- rows older than 14 days go, and the table is capped at the newest 20000 rows. housekeeping runs 60s after boot, then hourly.
- a second postgres container with its own volume is the upgrade if this table ever eats the disk. not needed first. a `docker-entrypoint-initdb.d` script was the other way to make the database; it only runs on an empty volume, so an existing droplet would never get it.

```sql
CREATE TABLE IF NOT EXISTS client_errors (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  env text NOT NULL, build text, kind text NOT NULL,
  page text NOT NULL, stream text, phase text, me text, ip text, ua text,
  message text NOT NULL, stack text, extra jsonb
);
CREATE INDEX IF NOT EXISTS client_errors_at_idx ON client_errors (at DESC);
```

## /admin

in the pages, for a name in `ADMIN_NAMES`. the droplet's own `/api/health` at the top (env, build, video, live, uptimes, and "N dropped this window" when the rate limit is refusing reports), then the last errors, newest first, filter by kind and page, click a row for the stack and the extras. refreshes every 10s; after a 401, 404 or 503 it stops polling (nothing will change until someone edits `.env`), and when a refresh fails it keeps the last list with `as of <time>` on it. anyone else sees "log in as an admin".

## the monitor box

the smallest box that can build the rust image: 2 GB, or 1 GB plus swap. `monitor/docker-compose.yml` runs the api binary as `api monitor` (`api/src/monitor.rs`): one container, one volume, nothing pulled from anyone but debian and rust.

```
git clone <repo> && cd slop-stream-architecture/monitor
cp .env.example .env            # TARGETS=prod=https://1.2.3.4,dev=https://5.6.7.8   OPS_TOKENS=prod=…,dev=…   ALERT_WEBHOOK=…
BUILD=$(git rev-parse --short HEAD) docker compose up -d --build
ssh -L 3002:127.0.0.1:3002 root@<monitor ip>      # from your laptop. then http://localhost:3002
```

per box in `TARGETS`:

| every | asks | keeps |
|---|---|---|
| 15s (`CHECK_EVERY_SECS`) | `GET /api/health`, 5s to answer. the self-signed cert is not checked: an ip has no name to check against | up or down and since when; the last answer (build, env, live, video, postgres, redis, debug db, both uptimes); the latency; an hourly tally for the 24h and 7d percentages |
| 60s (`ERRORS_EVERY_SECS`) | `GET /api/errors?limit=50` with that box's token (`OPS_TOKENS=prod=…,dev=…`, or one `OPS_TOKEN` for all) | the newest 100 reports, with stack and extras. a box without a token says so on the page instead |

- **down** is `DOWN_AFTER` (3) failed rounds in a row, dated from the first miss, so one lost packet is not a page. a miss while up shows as "1 missed check: <why>" on the page and nowhere else. **up** again comes with the downtime. both go to the log, the page's event list, and `ALERT_WEBHOOK` when set, as json `{"content": …, "text": …}`: a discord webhook reads the first, slack and most others the second. that webhook is the one thing a monitor cannot keep in-house; leave it empty and the page and the log are the alert.
- the reason is the api's own words when it answered (`503: postgres down`), caddy's code when the api behind it is gone (`502: caddy answers, the api behind it does not`), or the connect error (`tcp connect error: Connection refused`, `no answer in 5s`).
- `up_secs` going backwards is an event too, "api restarted (had been up 3h 12m)", same for video. a new `build` is "api build d668007 → 5ba44d7". so a deploy reads as two lines and a crash loop as a column of restarts, with no docker access to the box.
- its memory is one file, `/data/monitor.json` in the volume, rewritten after every round as a temp file and a rename. a restart or a rebuild keeps everything; a name removed from `TARGETS` is forgotten, a renamed one starts over. `docker compose exec monitor cat /data/monitor.json` is the whole database.
- the page (`api/src/monitor.html`, built into the binary; no node, no vite, no caddy on this box) polls `GET /api/monitor` every 10s: one card per box with the pill, the 24-hour bar, the health grid (greyed while down, showing the last answer), the events, the error table, a row opening on click. plain html and js, every string through `textContent`: the reports come from strangers' browsers.
- loopback only, so no login of its own: `ssh -L` is the door. `GET /health` on it answers `{ ok, up_secs, targets, build }` for whoever watches the watcher. `./status.sh https://<ip>` is the same questions asked once from a shell, no box needed.
- what it is not: proof from outside that video packets flow (the watcher bot, below), graphs of cpu and bandwidth (the host's own, below), or anything about the box it runs on.

install **digitalocean's monitoring agent** on every droplet (`curl -sSL https://repos.insights.digitalocean.com/install.sh | sudo bash`). free cpu, ram, disk and bandwidth graphs in the console, and alert policies on them. outbound mbit/s is the number that kills a video box, and nothing in the stack measures it yet.

## dev vs prod

a dev *environment* is a second droplet with the same compose and `ENV_NAME=dev` in its `.env` (or nothing, and it is that droplet's hostname). a second stack on the same box does not work, 80/443/7882 collide. laptop dev is already covered: `BACKEND=https://<dev droplet> npm run dev`. the monitor watches both; `env` separates them in every table.

## rolling this out

on a droplet that already runs the stack, the first update is by hand, once: `./deploy.sh --pull` would run the *old* script, which knows nothing about `BUILD` (and does not hand over to the pulled one), so every image it rebuilt would say `dev`, and later pulls would relabel only what they rebuild. instead:

1. `git pull --ff-only`.
2. in `.env`: `ENV_NAME` (or leave it empty for the hostname), `ADMIN_NAMES`, `OPS_TOKEN` (16+ characters). `./deploy.sh` appends the missing keys with their defaults, but set them now so the first boot has them.
3. every name in `ADMIN_NAMES` needs an account on that box already: sign up at `/signup`, or `docker compose exec api api passwd <name>` after the api is up. a name without one is dropped at boot with an error line, and `/admin` says "admins only" for it.
4. `./deploy.sh`, the full one. this round `video` restarts anyway: the new image carries `BUILD`, so it is a new image whatever the cache says. live streams end once.
5. `curl -k https://<ip>/api/health`: `build` is the image tag (the last commit that touched `image-paths`; HEAD when that was the last commit), `debug_db` true, `video` true, `video_build` the same sha. then `/admin` as one of the admin names.

from then on `./deploy.sh --pull` is the normal update again, and it rebuilds only what the pull changed.

## later, not now

- **the media check**: `GET /thumb/dummy-mango.jpg` is 200 only while a dummy publishes *and* ffmpeg decodes it, the whole media path on that box end to end, refreshed every 5s. one more request in `probe`, with the name per box in `.env`. it still does not prove udp from outside; that is the bot.
- **watcher bot**: a headless webrtc client that subscribes to a dummy from the monitor box and counts frames. the only check that proves udp from outside. small, in rust, same crate, run by `api monitor`.
- **grafana + prometheus + loki**: when there is a second video box and you want egress per box and every container's logs searchable in one place. `/metrics` on video and chat is item 5 in `kubernetes.md`.
- **a domain**: a $10 domain and let's encrypt remove the self-signed warning everywhere, make the pages free to call a second origin, and let the monitor check certificates and sit behind caddy with a login instead of `ssh -L`. the cheapest fix for the most things in this list.

## code

- `api/src/debug.rs` — the debug database (create, schema, lazy pool, retention), `POST` and `GET /api/errors`, the admin check.
- `api/src/main.rs` — the wider `/api/health`, `ENV_NAME`, `BUILD`, `started`.
- `video/src/main.rs` — json `/health`.
- `frontend/src/infra/report.ts` — `report()`, the window hooks, the peer snapshot.
- `frontend/src/main.tsx`, `router.tsx`, `app/CrashPage.tsx`, `app/admin/AdminPage.tsx`, the two atoms files, `infra/api.ts`.
- `docker-compose.yml`, `deploy.sh`, the four dockerfiles (`api/`, `video/`, `video/Dockerfile.dummy`, `frontend/`), `.env.example` — `BUILD`, `ENV_NAME`, `ADMIN_NAMES`, `OPS_TOKEN`, `DEBUG_DATABASE_URL`.
- `api/src/monitor.rs` — `api monitor`: the rounds, the events, the file, the webhook, `GET /api/monitor`. `api/src/monitor.html` — its page. `api/Cargo.toml` gives reqwest a tls stack for it (rustls with ring, which the tree already had).
- `monitor/docker-compose.yml`, `monitor/.env.example` — the monitor box.
- `status.sh` — the shell view of one box: containers, cpu and network, `/api/health`, who is live, the error lines of every container, the error reports. `./status.sh https://<ip>` for a box elsewhere.
- `test/errors.js` — a report lands, a bad body is 400, the route hides without an admin, health has the new fields, a thrown error in the page shows up in the api log, `/admin` renders. a step it cannot check off-box (no `OPS_TOKEN`) is `SKIP`, not `PASS`; locally it deletes the rows it inserted afterwards.
- `test/monitor.js` — local only: runs the monitor's compose file as a throwaway project on the stack's network, watching this stack and a dead address. up with the stack's own build, down with a reason after `DOWN_AFTER` rounds, error reports pulled when there is a token (`SKIP` otherwise), the page shows both, a restart keeps the events. removes everything it made.
