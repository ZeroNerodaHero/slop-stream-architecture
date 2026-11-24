# scripts and config

what the comments in the shell scripts, the Caddyfile, `image-paths` and the monitor files used to say, kept here now that those files carry no comments (`.cursor/rules/no-comments.mdc`). the scripts' `--help` text is still the header block at the top of each script (`scripts/ship.sh`, `test.sh`, `seed.sh`, `models.sh`, `manage.sh`, `dummy-groups.sh`): `-h` prints it with `awk` from the script itself, so it stays until each script gets a `usage()` of its own.

## `scripts/deploy.sh`

bring the stream lab up on this machine, or redeploy part of it.

```
  ./scripts/deploy.sh                   everything. first time, or any time. the images come from the
                                registry (ghcr.io/<you>/, from the git remote), named after the
                                last commit that touched what they are built from (./image-paths):
                                what the github action pushed. nothing is compiled here
  ./scripts/deploy.sh --pull            git pull, then the images for the tree just pulled
  ./scripts/deploy.sh api               only the api (also: frontend, video, dummy, voice): get its image, swap it
  ./scripts/deploy.sh --images TAG      a tag of your choosing, e.g. the one ./scripts/ship.sh --to printed
  ./scripts/deploy.sh --build           compile the images here instead (a laptop with uncommitted changes,
                                a box without a registry). goes with --pull and services
  ./scripts/deploy.sh --prune-deploy    first give the disk back what it can spare (docker's build cache,
                                untagged and unused images, the system's rotated and oversized logs,
                                apt's cache), then deploy as asked. for the small box that says
                                "only 2664MB free". volumes, containers and the swapfile stay
  ./scripts/deploy.sh 203.0.113.7       everything, with this ip
  ./scripts/deploy.sh passwd billy      a new password for an account (there is no email reset)
  PUBLIC_IP=10.0.0.5 ./scripts/deploy.sh
```

Full run, Linux (Ubuntu 22.04/24.04, Debian 12): installs docker if missing,
refuses if 80/443 are taken, opens ufw ports, writes .env (PUBLIC_IP,
CARGO_BUILD_JOBS, and ENV_NAME = this machine's hostname unless you set one),
gets the pages image and the three rust images (api, video, dummy), starts
everything, waits for /api/health. Exits non-zero if the health check fails.
With --build the images are compiled here one at a time (several minutes, a
2G swapfile is added on small boxes). The images carry BUILD (the commit they
are named after), so a full deploy restarts video whenever that moved since the
last one: every live stream ends, and the script says so before `up`. macOS (Docker
Desktop): same, minus install / swap / ufw; PUBLIC_IP comes from en0/en1.

Partial run: keeps PUBLIC_IP from .env, gets (or builds) the named services'
images, swaps only their containers. frontend = the pages; caddy keeps
running, so live streams survive. api = a few seconds of 502, streams
survive, and the s3 container is created first when it is missing (never
recreated). video = every live stream ends (the script says so first).
Afterwards the swapped containers are checked: running, healthy where the
image has a check, or the script exits non-zero (no rollback).

Every run that ends well writes the commit it deployed to .deployed (gitignored).
--pull diffs from there, not from HEAD, so a --pull that died in a build is
picked up whole by the next one instead of reporting "nothing changed".
After the health check, the demo models in random-media/vrms go into the bucket when the
folder changed since they last did (scripts/models.sh; .models remembers the folder).

It also records the release it put up: the highest v<n> tag reaching HEAD (the
github action numbers every push to main it built images for: v1, v2, ..., and
tags the commit and the four images with it; v<n>+<commit> when the images are
newer than the tag), written into the database through `api release` once the
health check passed, so /api/health says it under `version`. --images v13 deploys
that release's four images by name.

Stop everything later with:  docker compose down

## `image-paths`

what the four images (pages, api, video, dummy) are built from, as git pathspecs, one per line. blank lines and lines starting with `#` are skipped by every reader (`deploy.sh`, `ship.sh`, `.github/workflows/images.yml`).

- the images are named after the last commit that touched one of these paths: `deploy.sh` (`image_commit`) asks the registry for that tag, `ship.sh` builds and tags with it, and `.github/workflows/images.yml` builds and pushes it. the workflow's `paths:` filter is the same list written out by hand, because a workflow filter cannot read a file: change both together.
- a commit that touches none of these (docs, `deploy.sh`, `docker-compose.yml`) has no images of its own and runs the ones before it, so nothing is recreated for it.
- the Caddyfile is excluded: it is bind-mounted, in no image.
- `random-media/gifs` is in the dummy image. the rest of `random-media` (the seed script's pictures) is in none.

## `frontend/Caddyfile`

- `auto_https off`: there are no hostnames in the file, so nothing to get certs for. the cert is ours (`/certs/cert.pem`, `/certs/key.pem`).
- `protocols h1 h2`: compose publishes 443/tcp only, so http/3 is not advertised.
- `trusted_proxies static ...` is cloudflare's ranges, from cloudflare.com/ips-v4 and /ips-v6; refresh it when they change. only a request from one of them gets its `CF-Connecting-IP` trusted as the client ip; a direct request cannot spoof it, the header is ignored. `trusted_proxies_strict` reads the header right to left, stopping at the first ip that is not a trusted proxy.
- the `(real_ip)` snippet overwrites `X-Forwarded-For` with the client ip caddy resolved. without it caddy keeps a trusted proxy's own `X-Forwarded-For` and appends, so a visitor could prepend a fake first entry, and `api/src/ratelimit.rs` and `auth.rs` read the first one. every `reverse_proxy` imports it.
- `http://` redirects to `https://` on the same host.

routes on `:443`:

| path | goes to | notes |
|---|---|---|
| `/api/streams` | `home:4100` | the home list, served by the home container from its table (`api/src/home.rs`). an exact path: `/api/streams/<name>/...` stays the api's. caddy puts the longer path matcher first |
| `/api/*` | `api:4000` | json api, path kept: `/api/x` -> `api:4000/api/x` |
| `/ws` | `video:7880` | video setup websocket. `reverse_proxy` does the upgrade on its own |
| `/voice` | `voice:7881`, rewritten to `/ws` | voice channel websocket (`video/src/voice.rs`, listens at `/ws`). an exact path. a 502 until the voice profile is up (`docker-compose.yml`) |
| `/chat/*` | `chat:4100` | text chat websocket, one per viewer |
| `/events` | `events:4100` | presence and pushes, one per browser, open on every page; the api binary run as `api events`. an exact path. see `docs/status.md` |
| `/thumb/*` | `video:7880` | the picture of each live stream, made on the video machine |
| `/watch/*` | `api:4000` | the one page the api serves: the same `index.html` with a `<title>` and `og:*` tags for that name, so a shared link gets a preview card, and the profile filled in before react boots (`api/src/profile.rs`) |
| `/assets/*` | `/srv` | hashed vite assets, `immutable` for a year, but only on a hit (`@hit file`). brotli 11 is built beside each asset (`frontend/scripts/precompress.mjs`, `precompressed br`), the rest compressed on the fly: ~23% fewer bytes for the main bundle, which a cold load gets in tcp slow start (`docs/debugging.md`, "Watch startup timings") |
| everything else | `/srv/index.html` | `Cache-Control: no-cache`, so a deploy never leaves someone running old js against a new api |

`handle_errors`:

- `/watch/*` with a 502, 503 or 504 (the api is down: `./scripts/deploy.sh api`, a crash) serves the plain `index.html` from the volume instead of a bare 502, so the spa boots and keeps checking on its own. that one fetch has no preview tags; a bot that unfurls right then gets the generic card. every other route keeps its error.
- a missing `/assets/*` file (a tab on an old build asking for a chunk the new publish removed) is a `no-store` 404, so the next publish or a rollback is asked again. with the catch-all's fallback instead, that tab would cache `index.html` as immutable for a year.

## the monitor box (`monitor/`)

a different box from the ones it watches: a dead box cannot say so itself. our own code, the api binary run as `api monitor` (`api/src/monitor.rs`): one container, one json file for its memory, one page built into the binary. no database, no redis, nothing pulled from anyone. see `docs/debugging.md`, "the monitor box".

it asks every box's `/api/health` every 15s, pulls its `/api/errors` every minute, remembers up/down, restarts and new builds, posts down/up to a webhook, and serves the page on this box's loopback `:3002`.

it builds the rust image, so it needs 2 GB of ram, or 1 GB plus swap:

```
curl -fsSL https://get.docker.com | sudo sh
git clone <repo> && cd slop-stream-architecture/monitor
cp .env.example .env                                   # TARGETS, OPS_TOKENS, ALERT_WEBHOOK
BUILD=$(git rev-parse --short HEAD) docker compose up -d --build
```

update: `git pull && BUILD=$(git rev-parse --short HEAD) docker compose up -d --build`. the memory is in the volume, so a rebuild keeps the history.

the page is on loopback only; nothing is published to the internet. from your laptop: `ssh -L 3002:127.0.0.1:3002 root@<monitor ip>`, then open http://localhost:3002. peek with `docker compose logs -f monitor` (every down and up is a warn line there too) or `docker compose exec monitor cat /data/monitor.json`.

- `MONITOR_IMAGE` is `stream-api:latest` when built on the monitor box. `test.sh` runs the monitor beside a stack and sets it to the image that stack's api was started from (the registry's name and tag, or a local build), so the monitor under test is that checkout's.
- the container's healthcheck looks at the monitor's port; the image's own check looks at the api port.

### `monitor/.env.example`

| variable | what it is |
|---|---|
| `TARGETS` | the boxes to watch: `name=url`, comma separated. the name is what the page and the alerts call it |
| `OPS_TOKENS` | each box's `OPS_TOKEN` (the one in its own `.env`), so the page can show its error reports. optional: a box without one still gets watched, just without that table |
| `ALERT_WEBHOOK` | where down and up go: a url that takes json `{"content": "..."}` (a discord webhook does; so does anything that reads `"text"`). empty means nowhere; the page and the log still show them |
| `CHECK_EVERY_SECS`, `ERRORS_EVERY_SECS` | how often, in seconds, health and errors are checked |
| `DOWN_AFTER` | how many failed rounds in a row make "down" |
| `MONITOR_PORT` | the page, on this box's loopback. reach it over `ssh -L` |
| `CARGO_BUILD_JOBS` | how many cores the rust build may use. 1 is safe on a small box |

## `docs/tech-docs/style.css`

the tech docs' look and every animation. the pages reach these by class and carry no css of their own (`.cursor/skills/tech-docs/SKILL.md` lists the classes). the site's palette (`frontend/src/app/globals.css`), 1px strokes, no radius, no shadow (`.cursor/rules/no-box-shadow.mdc`). every animation shows a fact: a dot moving is data moving, a blink is live, a bar filling is a limit. all of them stop under `prefers-reduced-motion`, at the bottom of the file, with the end state readable.
