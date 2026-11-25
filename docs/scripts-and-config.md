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
  ./scripts/deploy.sh stats             apply STATS_* from .env: caddy and the agent are recreated, the
                                monitor (compose project monitor) is brought up to date. the only
                                command that touches the monitor (https://stats.nodentity.xyz, docs/metrics.md)
  ./scripts/deploy.sh --images TAG      a tag of your choosing, e.g. the one ./scripts/ship.sh --to printed
  ./scripts/deploy.sh --build           compile the images here instead (a laptop with uncommitted changes,
                                a box without a registry). goes with --pull and services
  ./scripts/deploy.sh --prune-deploy    first give the disk back what it can spare (docker's build cache,
                                untagged and unused images, the system's rotated and oversized logs,
                                apt's cache), then deploy as asked. for the small box that says
                                "only 2664MB free". volumes, containers and the swapfile stay
  ./scripts/deploy.sh 203.0.113.7       everything, with this ip
  ./scripts/deploy.sh passwd billy      a new password for an account (there is no email reset)
  ./scripts/deploy.sh prune             check health, then drop old app image tags and dangling images
                                (PRUNE_DRY_RUN=1 only prints what would go)
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
dummy = only the dummy container. video and api read DUMMY_PASSWORD too, so each is
recreated alongside only when the DUMMY_PASSWORD its running container got (`docker
inspect`, `dummy_password_stale`) differs from the shell's or .env's; the two are compared
in bash and never printed. With `--images`, one whose running image is not the deploy's
TAG yet (`image_current`; an image not pulled counts as not current) is left alone with a
warning naming `./scripts/deploy.sh video api`, so a dummy deploy never moves video to a
new version and ends every stream by surprise.
Afterwards the swapped containers are checked: running, healthy where the
image has a check, or the script exits non-zero (no rollback).

Right after the pages are published (a full deploy, `frontend`, or `--pull` when the
pages changed) it purges the html from cloudflare, when `CF_PURGE_TOKEN`, `CF_ZONE_ID` and
`PUBLIC_URL` are all set in .env: one POST for the exact shell urls (`/`, `/groups`, `/live`,
`/login`, `/signup`) and one prefix purge for `<host>/watch/` and `<host>/groups/`, 10 s each.
The publish deletes the old build's `/assets/*`, so an html the edge kept would name files that
are gone. Any of the three unset: one "skipped" line. A failed purge is a warning with the HTTP
status and cloudflare's error messages, never the token, and the deploy goes on: the edge drops
the old html within its `s-maxage` (60 s, 15 s for `/watch/`). docs/cloudflare-cache-rules.md.

Every run that ends well writes the commit it deployed to .deployed (gitignored).
--pull diffs from there, not from HEAD, so a --pull that died in a build is
picked up whole by the next one instead of reporting "nothing changed".
After the health check, the demo models in random-media/vrms go into the bucket when the
folder changed since they last did (scripts/models.sh; .models remembers the folder).

### image prune after a deploy

Every deploy that redeploys containers (a full deploy, any named service, `--pull` that
found something to redeploy) ends with `post_deploy_prune`, and `./scripts/deploy.sh prune`
runs the same step alone. It only runs once the health check passed; when it did not, it
prints "skipping the image prune" and removes nothing, so the images from before stay for a
rollback. The standalone `prune` runs the health check first and exits non-zero when it fails.

What it does, between a `df -h /` before and after:

- for each app image repository, `$IMAGES` + `stream-<x>` and the bare `stream-<x>` a `--build`
  makes, for x in `APP_IMAGE_SERVICES` (pages, api, video, dummy: the only images
  docker-compose.yml names after this stack; chat, events and home run the api image, voice the
  video one), it ranks the tagged images by created time and keeps: every image a running
  container uses, the image `TAG` names, the newest image older than each of those (the rollback),
  and anything newer than them (pulled but not yet deployed). when none of them is present it
  keeps the newest two. every other tag in that repository goes with a plain `docker rmi
  <repo>:<tag>`, never `-f`, never by id; a refusal is printed and the run goes on.
- an image any container uses, running or stopped, is never picked.
- then `docker image prune -f` for dangling images (no `-a`, so unused third-party images stay).
  in a `--build` deploy the previous build is untagged once `:latest` moves, so this drops it:
  the rollback image is only kept for registry deploys, whose tags are commits.
- third-party images (postgres, redis, seaweedfs, caddy, alpine/openssl) are never looked at:
  only exact app repositories are listed, and `is_app_repo` refuses any name containing
  postgres, redis, seaweed, caddy or openssl before each `rmi`. no volumes, no `docker system
  prune`, no `docker volume`, no build cache (that is `--prune-deploy`).
- `PRUNE_DRY_RUN=1` prints "would remove <repo:tag>" for each pick and the dangling count,
  and removes nothing.
- a prune that stumbles is a warning; it never fails the deploy.

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

- `auto_https off`: no acme, nothing to get certs for. the cert is ours (`/certs/cert.pem`, `/certs/key.pem`); the one block with a hostname, `stats.nodentity.xyz`, names it by hand.
- `protocols h1 h2`: compose publishes 443/tcp only, so http/3 is not advertised.
- `trusted_proxies static ...` is cloudflare's ranges, from cloudflare.com/ips-v4 and /ips-v6; refresh it when they change. only a request from one of them gets its `CF-Connecting-IP` trusted as the client ip; a direct request cannot spoof it, the header is ignored. `trusted_proxies_strict` reads the header right to left, stopping at the first ip that is not a trusted proxy.
- the `(real_ip)` snippet overwrites `X-Forwarded-For` with the client ip caddy resolved. without it caddy keeps a trusted proxy's own `X-Forwarded-For` and appends, so a visitor could prepend a fake first entry, and `api/src/ratelimit.rs` and `auth.rs` read the first one. every `reverse_proxy` imports it.
- `http://` redirects to `https://` on the same host.

routes on `:443`:

| path | goes to | notes |
|---|---|---|
| `/api/metrics` | `agent:4300` | this box's host and container numbers (`api/src/agent.rs`, `docs/metrics.md`). an exact path, before `/api/*`. the agent answers 404 without an `OPS_TOKEN` on the box and 401 without the right bearer token |
| `/api/streams` | `home:4100` | the home list, served by the home container from its table (`api/src/home.rs`). an exact path: `/api/streams/<name>/...` stays the api's. caddy puts the longer path matcher first |
| `/api/*` | `api:4000` | json api, path kept: `/api/x` -> `api:4000/api/x` |
| `/ws` | `video:7880` | video setup websocket. `reverse_proxy` does the upgrade on its own |
| `/voice` | `voice:7881`, rewritten to `/ws` | voice channel websocket (`video/src/voice.rs`, listens at `/ws`). an exact path. a 502 until the voice profile is up (`docker-compose.yml`) |
| `/chat/*` | `chat:4100` | text chat websocket, one per viewer |
| `/events` | `events:4100` | presence and pushes, one per browser, open on every page; the api binary run as `api events`. an exact path. see `docs/status.md` |
| `/thumb/*` | `video:7880` | the picture of each live stream, made on the video machine |
| `/watch/*` | `api:4000` | the one page the api serves: the same `index.html` with a `<title>` and `og:*` tags for that name, so a shared link gets a preview card, and the profile filled in before react boots (`api/src/profile.rs`). a 200 render is `public, max-age=0, s-maxage=15, must-revalidate`, so cloudflare may keep it 15 s (nothing in it is per viewer; its urls come from `PUBLIC_URL`, not the `Host` header, when that is set). an unknown name, a rename's 302 and the db/redis fallbacks are `no-cache` |
| `/assets/*` | `/srv` | hashed vite assets, `immutable` for a year, but only on a hit (`@hit file`). brotli 11 is built beside each asset (`frontend/scripts/precompress.mjs`, `precompressed br`), the rest compressed on the fly: ~23% fewer bytes for the main bundle, which a cold load gets in tcp slow start (`docs/debugging.md`, "Watch startup timings") |
| `/`, `/groups`, `/groups/*`, `/live`, `/login`, `/signup` | `/srv/index.html` | always the shell. `Cache-Control: public, max-age=0, s-maxage=60, must-revalidate`: the browser asks every time, cloudflare may answer for a minute (docs/cloudflare-cache-rules.md, "Cache HTML shell"), and `deploy.sh` purges it on every publish |
| everything else | the file, or `/srv/index.html` | `Cache-Control: no-cache`, so a deploy never leaves someone running old js against a new api. `/oauth`, `/admin`, `/explore*`, unknown paths (the spa's 404) and real files like `/favicon.ico` stay here |

the `https://stats.nodentity.xyz` block (`docs/metrics.md`):

- the same self-signed cert as `:443`, named by hand (`tls /certs/cert.pem /certs/key.pem`): with `auto_https off` a host block would otherwise have none. cloudflare's "full" mode accepts it.
- `header` sets `Cache-Control: private, no-store` (and noindex, `DENY` framing, `nosniff`, `no-referrer`) before anything else runs, so the 401s and 503s carry it too. the proxy drops the monitor's own `Cache-Control` (`header_down -Cache-Control`) so there is one.
- `@public` (`STATS_PUBLIC` exactly `true`) comes first and proxies to the monitor with no `basic_auth`. the `header` above still applies.
- `@off` is an `expression` on the runtime env: `STATS_BASIC_AUTH_USER` or `STATS_BASIC_AUTH_HASH` empty or `statsoff` answers 503 and proxies nothing. compose passes `statsoff` for a blank key, because `basic_auth` reads the two at parse time (`{$VAR:statsoff}`), caddy only uses that default for an unset variable, and an empty user or hash would stop caddy loading the file, the main site with it. `statsoff` is also valid base64, which caddy wants of any hash at load.
- everything else goes through `basic_auth` to `stats:3002`: the monitor, from its own compose project, on the network `stream_stats` with the alias `stats`. only caddy and the monitor are on it.

`monitor/Caddyfile` is the same block for the monitor's own caddy (`monitor-caddy`, profile `tls`): the same headers, `@public`, `@off` and `basic_auth`, to `monitor:3002`, with `tls {$STATS_TLS:internal}` (caddy's own ca, which cloudflare's "full" accepts, or an acme email), `auto_https disable_redirects` (only 443 is published), `skip_install_trust`, and cloudflare's ranges as trusted proxies so the monitor's rate limit sees `CF-Connecting-IP`.

`handle_errors`:

- `/watch/*` with a 502, 503 or 504 (the api is down: `./scripts/deploy.sh api`, a crash) serves the plain `index.html` from the volume instead of a bare 502, so the spa boots and keeps checking on its own. that one fetch has no preview tags; a bot that unfurls right then gets the generic card. every other route keeps its error.
- a missing `/assets/*` file (a tab on an old build asking for a chunk the new publish removed) is a `no-store` 404, so the next publish or a rollback is asked again. with the catch-all's fallback instead, that tab would cache `index.html` as immutable for a year.

## the monitor (`monitor/`)

its own compose project, `monitor`, on test-machine beside the app or on a box of its own. app deploys never stop, restart or recreate it; only `./scripts/deploy.sh stats` does (`docs/metrics.md`, "the monitor and app deploys"). our own code, the api binary run as `api monitor` (`api/src/monitor.rs`): one container, one json file for its memory, one page built into the binary. see `docs/debugging.md`, "the monitor box".

it asks every box's `/api/health` every 15s, pulls its `/api/errors` every minute and its agent's `/api/metrics` every 15s, remembers up/down, restarts and new builds, posts down/up to a webhook, and serves the page on the box's loopback `:3002`.

- `monitor/docker-compose.yml`: `monitor` (`container_name` from `MONITOR_CONTAINER`, default `monitor`; `restart: unless-stopped`; `read_only`, every capability dropped, `no-new-privileges`; the volume `monitor-data`; a healthcheck on its own `/health`, since the image's looks at the api port) and `caddy` under the profile `tls` (`monitor-caddy`, `STATS_HTTPS_PORT`, default 443, published). the env takes the `STATS_*` names and falls back to the monitor's older `TARGETS`, `OPS_TOKENS` and `ALERT_WEBHOOK`.
- `monitor/beside-app.yml`, on test-machine only: the image the app's api runs (`IMAGES`, `TAG`), `TARGETS` defaulting to `<ENV_NAME>=https://frontend`, and the external network `stream_stats` with the alias `stats`. `deploy.sh stats` runs `docker compose -p monitor --env-file .env -f monitor/docker-compose.yml -f monitor/beside-app.yml`, adding `--profile tls` when `STATS_HTTPS_PORT` is set.
- on its own box: `cd monitor`, `cp .env.example .env`, `docker compose --profile tls pull && docker compose --profile tls up -d --no-build`. `docker compose logs -f monitor` (every down and up is a warn line) or `docker compose exec monitor cat /data/monitor.json` to peek.
- `test.sh` runs the monitor's compose file as a throwaway project beside a stack and sets `MONITOR_IMAGE` to the image that stack's api was started from, so the monitor under test is that checkout's.

### `monitor/.env.example`

| variable | what it is |
|---|---|
| `STATS_TARGETS` | the boxes to watch: `name=url`, comma separated. the name is what the page and the alerts call it |
| `STATS_TOKENS` | each box's `OPS_TOKEN` (the one in its own `.env`), `name=token`, for its error reports and agent numbers. a box without one is still watched, without those |
| `STATS_ALERT_WEBHOOK` | where down and up go: a url that takes json `{"content": "..."}` (a discord webhook does; so does anything that reads `"text"`). empty means nowhere; the page and the log still show them |
| `STATS_HOST`, `STATS_TLS`, `STATS_HTTPS_PORT` | the site's name (`stats.nodentity.xyz`), `internal` or an acme email for its cert, the port its caddy publishes (443) |
| `STATS_BASIC_AUTH_USER`, `STATS_BASIC_AUTH_HASH`, `STATS_PUBLIC` | the same as in the root `.env`: a password, or `true` for none. neither: 503 |
| `MONITOR_IMAGE` | the api image to run, `ghcr.io/<owner>/stream-api:<tag>`; `stream-api:latest` for one built here with `--build` |
| `MONITOR_PORT` | the page, on this box's loopback. reach it over `ssh -L` |
| `CHECK_EVERY_SECS`, `ERRORS_EVERY_SECS`, `METRICS_EVERY_SECS` | how often, in seconds, health, errors and each box's agent numbers are checked |
| `DOWN_AFTER` | how many failed rounds in a row make "down" |
| `CARGO_BUILD_JOBS` | how many cores the rust build may use with `--build`. 1 is safe on a small box |

## `docs/tech-docs/style.css`

the tech docs' look and every animation. the pages reach these by class and carry no css of their own (`.cursor/skills/tech-docs/SKILL.md` lists the classes). the site's palette (`frontend/src/app/globals.css`), 1px strokes, no radius, no shadow (`.cursor/rules/no-box-shadow.mdc`). every animation shows a fact: a dot moving is data moving, a blink is live, a bar filling is a limit. all of them stop under `prefers-reduced-motion`, at the bottom of the file, with the end state readable.

## `.env.example`

every knob in the root `.env.example`, with what its comment said. `./scripts/deploy.sh` appends any of these a box's `.env` does not have yet (`sync_env_keys`), with the default shown here; it used to copy the comment above each one along with it, and now copies just the line.

| variable | default | what it is |
|---|---|---|
| `SHOW_DOCS` | `0` | the human docs (docs/tech-docs, short pages the tech-docs skill writes from the last 100 commits) at http://localhost:42069/tech-docs while `npm run dev` runs in frontend/. 1 serves them, 0 does not. only vite reads this; the docker stack ignores it, and no deploy ever serves them. |
| `PUBLIC_IP` | `127.0.0.1` | the ip people type in the browser. deploy.sh fills this in. 127.0.0.1 counts as "not set": deploy.sh will detect the ip instead. |
| `CARGO_BUILD_JOBS` | `1` | how many cores the rust build may use. a full ./scripts/deploy.sh overwrites this every run (ram / 1.5 GB, capped at the core count); partial runs and --pull compute the same number but leave this line alone. to force a value: CARGO_BUILD_JOBS=2 ./scripts/deploy.sh |
| `IMAGES`<br>`TAG` | (empty)<br>(empty) | where ./scripts/deploy.sh gets the images. empty IMAGES: the registry the git remote implies (github.com/<you>/… → ghcr.io/<you>/), where the github action pushes them on every push to main. set it for another registry. TAG is what the last deploy ran (a commit, or a release like v12: the action tags every image with its v<n>); deploy.sh writes it. `./scripts/deploy.sh --build` compiles the images here instead and ignores both. |
| `ENV_NAME` | (empty) | what this box is called in /api/health and in every stored error. empty: deploy.sh fills in this machine's hostname. use prod, dev, ... if you prefer.  see docs/debugging.md |
| `ADMIN_NAMES` | (empty) | who may read /api/errors and open /admin: account names, comma separated. empty = nobody. each name needs an account on this box (sign up, or ./scripts/deploy.sh passwd <name>), else the api drops it at boot |
| `OPS_TOKEN` | (empty) | a machine's key for /api/errors and the agent's /api/metrics (Authorization: Bearer ...). empty = off.  make one: openssl rand -hex 32 16 characters at least: a shorter one is ignored, with a warn line in the api log |
| `PUBLIC_URL`<br>`GOOGLE_CLIENT_ID`<br>`GOOGLE_CLIENT_SECRET`<br>`DISCORD_CLIENT_ID`<br>`DISCORD_CLIENT_SECRET` | (empty)<br>(empty)<br>(empty)<br>(empty)<br>(empty) | log in with google, discord (docs/accounts.md). empty = that provider is off, no button. PUBLIC_URL is the https origin people type, no trailing slash. each provider's console needs the redirect uri {PUBLIC_URL}/api/oauth/<google\|discord>/callback, exactly (https://nodentity.xyz/api/oauth/google/callback, .../discord/callback). google refuses a bare ip and plain http (except localhost): this needs a real domain + cert. |
| `TURNSTILE_ENABLED`<br>`TURNSTILE_SITE_KEY`<br>`TURNSTILE_SECRET` | `false`<br>(empty)<br>(empty) | cloudflare turnstile, a human check on signup and login (docs/cloudflare-turnstile.md). on only with TURNSTILE_ENABLED=true and both keys; the flag on with a key missing logs an error and stays off. the site key is public (the pages draw the widget with it); the secret never leaves the api. |
| `CF_PURGE_TOKEN`<br>`CF_ZONE_ID` | (empty)<br>(empty) | cloudflare in front (docs/cloudflare-cache-rules.md): a takedown of a public picture or video purges its url (under PUBLIC_URL) from the edge. the token's only permission: Zone > Cache Purge, on this zone alone. either empty = no purge (the edge keeps it until its max-age runs out). `scripts/deploy.sh` reads the same two (and PUBLIC_URL) from .env to purge the html after publishing the pages; unset = skipped |
| `DUMMY_STREAMS`<br>`DUMMY_PASSWORD` | `0`<br>(empty) | fake streams for styling and debugging: gifs bouncing around, named dummy-mango, dummy-pixel, ... set a count and any password, then: ./scripts/deploy.sh dummy the password is what lets the dummy box publish dummy-* names. nobody else can. the box sends it to the api as the `X-Dummy-Password` header (the api still takes `?password=` too), and every name it writes is flagged `is_test` (docs/test-streamers.md). |
| `DUMMY_NAMES` | (empty) | optional: your own names instead, comma separated |
| `DUMMY_CHAT`<br>`DUMMY_CHAT_INTERVAL_MS` | (empty)<br>(empty) | the dummy streams talk in their own chat: each stream says a line about once a second, and a pretend viewer one about every 30s. `0`, `off` or `false` turns it off (the streams still run). the interval is in ms, default 1000, clamped to 250..60000. not in `.env.example`; docker-compose.yml passes both, empty means the defaults. docs/video-source.md |
| `S3_ENDPOINT`<br>`S3_BUCKET`<br>`S3_REGION`<br>`S3_ACCESS_KEY`<br>`S3_SECRET_KEY` | `off`<br>`stream`<br>`us-east-1`<br>(empty)<br>(empty) | where objects go. off (the default): the s3 container in docker-compose (seaweedfs), bucket "stream", no aws bill. set a url to use a real bucket instead, and then the key, the secret and the bucket name. the container still runs either way; a url only changes where the api sends.   https://s3.us-east-1.amazonaws.com   https://<account>.r2.cloudflarestorage.com |
| `S3_PATH_STYLE` | (empty) | empty: path-style, except amazonaws.com which wants virtual-hosted. 1 or 0 forces it. the container always uses path-style, and this line does not apply to it. |
| `MODERATION_ENABLED`<br>`OPENAI_API_KEY` | `false`<br>(empty) |  |
| `CHAT_PERSIST` | (empty) | keep chat lines in postgres, so a room can be scrolled past the last 500, searched, and jumped to. empty or 0: redis only (the last 500, gone a week after the last line). 1 turns it on. the chat process reads this. the api process does not. |
| `GROUPS_PER_OWNER` | (empty) | how many groups one login may own: the ones it made plus the ones it was named owner of. empty: 2. at most 8, the groups a login may be in (its own included); more is read as 8. the pages offer create under it, and the api refuses at it. see docs/groups.md |
| `STATS_BASIC_AUTH_USER`<br>`STATS_BASIC_AUTH_HASH` | (empty)<br>(empty) | https://stats.nodentity.xyz, the monitor page behind caddy's basic auth (docs/metrics.md). the hash from `docker compose exec frontend caddy hash-password`, in single quotes: `STATS_BASIC_AUTH_HASH='$2a$14$...'`. either empty: the site answers 503 and `deploy.sh stats` leaves the monitor as it is. `deploy.sh` refuses a user with other than letters, digits and `. _ @ -`, and a hash that is not a quoted bcrypt hash, before it changes anything |
| `STATS_PUBLIC` | (empty) | `true`: https://stats.nodentity.xyz with no password (docs/metrics.md). the page and its read-only `/api/monitor*` only; the monitor leaves the pages' error reports out, the agent's `/api/metrics` keeps its token. anything else: the two values above decide, and blank is a 503 |
| `STATS_TARGETS`<br>`STATS_TOKENS`<br>`STATS_ALERT_WEBHOOK` | (empty)<br>(empty)<br>(empty) | what the stats monitor watches: `name=url` pairs, comma separated (empty: this box alone, `<ENV_NAME>=https://frontend`); `name=token` for a box whose `OPS_TOKEN` differs from this one's; where down and up are posted. the monitor's `TARGETS`, `OPS_TOKENS` and `ALERT_WEBHOOK` under other names |
| `STATS_HTTPS_PORT` | (empty) | a port (8443): `deploy.sh stats` also runs the monitor's own caddy on it, so the page answers while the app's caddy restarts, once a cloudflare origin rule sends `stats.nodentity.xyz` there (docs/metrics.md). empty: the app's caddy only |
| `VOICE_SECRET` | (empty) | voice channels (the voice container, docker-compose.yml). the api signs grants with it and the voice container redeems them with it. make one: openssl rand -hex 32 stays empty until voice is turned on; empty, the api answers voice joins with a 503. |

not in `.env.example`; `docker-compose.yml` passes it to the api, home and chat containers, unset means off:

| variable | default | what it is |
|---|---|---|
| `HIDE_TEST_STREAMERS` | (empty) | `1` or `true`: the test streamers (`is_test`, the dummy box's names) are left out of every list, 404 on their profile, watch grant and `/watch` page, and refused go-live. empty or anything else: off, and every answer is as before. read once at boot by the api, by `api home` and by `api chat` (a test stream's faster chat tier is off with it). docs/test-streamers.md |

## `docker-compose.yml`

- test stream certs makes the https cert once, then exits pages builds the react pages, copies them into a volume, then exits frontend caddy. serves the pages. /api and /watch -> api, /ws and /thumb -> video, /chat -> chat, http -> https api save a bio and a picture, go live, heartbeat, start/end log, the /watch page. also /api/health and /api/errors chat the text chat. websocket per viewer, last 500 lines per stream in redis database the bio and the session log. not the video. plus a second database, debug, for the pages' error reports redis who is live s3 a seaweedfs bucket on this machine. S3_ENDPOINT=off (the default) uses it; a url uses that bucket instead video rust. one upload in, copies it out. media on udp 7882 dummy fake streams for styling: gifs bouncing around. DUMMY_STREAMS in .env says how many voice rust, video's image as `video voice`. voice channels, media on udp 7883. off until `--profile voice` (see the service below) start: ./scripts/deploy.sh everything, first time or any time ./scripts/deploy.sh api only the api (also: frontend, video, dummy) ./scripts/deploy.sh --pull git pull, then rebuild what changed since the last deploy that ended well ./scripts/deploy.sh --images TAG no build here: pull the images ./scripts/ship.sh pushed from a laptop (IMAGES=ghcr.io/<you>/ and TAG in .env name them; empty = built here) (by hand: cp .env.example .env, set PUBLIC_IP, BUILD=$(git rev-parse --short HEAD) docker compose up -d --build) the images carry BUILD and are named after the last commit that touched what they are built from (./image-paths), so a full deploy (or `up -d --build`) restarts video whenever that moved since the last one: every live stream ends. deploy.sh warns first. open: https://<PUBLIC_IP from the .env file> ports: 80/tcp 443/tcp 7882/udp dummies: in .env set DUMMY_STREAMS=3 and DUMMY_PASSWORD=anyword, then ./scripts/deploy.sh dummy peek: docker compose exec database psql -U stream docker compose exec database psql -U stream -d debug (the pages' error reports) docker compose exec redis redis-cli health: https://<PUBLIC_IP>/api/health errors: https://<PUBLIC_IP>/admin (ADMIN_NAMES in .env) (at `name: stream`)
- every long-running container logs through this: 3 files of 10 MB each, then the oldest goes. docker's default json-file has no cap, and caddy writes a line per request (home polls every 3s per open tab), so a lab left alone fills its disk. (at `x-logging: &default-logging`)
- builds the react pages (vite) and copies them into the volume caddy serves. runs once per deploy, then exits. redeploying pages never restarts caddy. (at `build:`)
- the commit, from deploy.sh. the pages send it with every error report (at `BUILD: ${BUILD:-dev}`)
- image names spelled out: compose would derive them from `name:` above, and chat below names the api image by hand, so they must not move with the project name (at `image: ${IMAGES:-}stream-pages:${TAG:-latest}`)
- not read by caddy. a change forces a restart so the new cert is loaded. (at `PUBLIC_IP: ${PUBLIC_IP:-127.0.0.1}`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- the pages' error reports. a second database in the same postgres, made by the api when missing. the api runs fine without it. see docs/debugging.md (at `DEBUG_DATABASE_URL: postgres://stream:stream@database:5432/debug`)
- names starting with dummy- need this password to go live (the dummy box has it) (at `DUMMY_PASSWORD: ${DUMMY_PASSWORD:-}`)
- what this box is called in /api/health and in stored errors. deploy.sh writes the hostname into .env when it is empty; still empty (by hand) and the api says "unnamed" (at `ENV_NAME: ${ENV_NAME:-}`)
- who may read /api/errors: these accounts (the /admin page), or a bearer token (a machine) (at `ADMIN_NAMES: ${ADMIN_NAMES:-}`)
- log in with google, discord (docs/accounts.md). a provider is on only with both its id and secret, and PUBLIC_URL (callback: {PUBLIC_URL}/api/oauth/<provider>/callback) (at `PUBLIC_URL: ${PUBLIC_URL:-}`)
- cloudflare turnstile on signup and login (docs/cloudflare-turnstile.md). on only with TURNSTILE_ENABLED=true and both keys (at `TURNSTILE_ENABLED: ${TURNSTILE_ENABLED:-false}`)
- purge a taken-down public picture or video from cloudflare's cache, by its url under PUBLIC_URL. either empty: no purge. see docs/cloudflare-cache-rules.md (at `CF_PURGE_TOKEN: ${CF_PURGE_TOKEN:-}`)
- how many groups one login may own. empty: 2. see docs/groups.md (at `GROUPS_PER_OWNER: ${GROUPS_PER_OWNER:-}`)
- signs voice grants and lets the voice container in. empty: voice is off (joins are a 503) (at `VOICE_SECRET: ${VOICE_SECRET:-}`)
- where a moderator's mute or disconnect is sent (voice.rs `tell_voice`): the voice container, inside (at `VOICE_URL: http://voice:7881`)
- off (the default): the s3 container below. a url: that bucket, with the key and secret. the container's own login is not these two; it is the literals on the s3 service. (at `S3_ENDPOINT: ${S3_ENDPOINT:-off}`)
- the built pages. /watch/<name> is served from here with that name's preview tags (at `PAGES_DIR: /srv`)
- no host port. browsers reach this through the frontend, at /api and /watch (at `chat:`)
- the text chat. the api binary run as `api chat`, same image, no extra build. one websocket per viewer at /chat/<name>; the live lines are a redis stream. see docs/chat.md. the chat only: presence and the pushes are the `events` container below. CHAT_PERSIST=1 also writes each line to postgres, so a room can be scrolled, searched and jumped to. (at `image: ${IMAGES:-}stream-api:${TAG:-latest}`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- empty or 0: redis only, last 500 lines. 1: also keep every line in postgres. (at `CHAT_PERSIST: ${CHAT_PERSIST:-}`)
- the site admins see every channel of a server, kept to a role or not (docs/groups.md): the same names the api reads (at `ADMIN_NAMES: ${ADMIN_NAMES:-}`)
- healthy, not started: the api creates the tables (accounts included) on its way up, and the chat reads them from its first socket on (at `api:`)
- the image's own check looks at the api port; this one looks at ours, and asks for a real answer: a wedged process still accepts connections (the kernel's backlog does), it just never answers. GET /health is "ok" from the same listener /chat hangs off (at `healthcheck:`)
- a socket per viewer per room: a file descriptor each. docker's default soft limit is 1024 on recent daemons, and a rust process does not raise its own the way go does: a thousand viewers, then accept fails. see docs/transition.md (at `ulimits:`)
- no host port. browsers reach this through the frontend, at /chat (at `events:`)
- the gateway: presence and the pushes. one websocket per browser at /events, open on every page; it marks its name here (`seen:<name>`), says which names it watches, and is told `me`, `presence`, `live`, `ended` and `renamed` as they happen. the facts come off the `events` redis stream the api writes (go-live's `live` when video has the publisher, stop's `ended`, a status change); this process tails it and fans each one out to the sockets that watch the name. the api binary run as `api events`, same image, no extra build. it reads redis and the database, nothing else, and keeps no state that matters: if it restarts, browsers reconnect in 3s and it replays the last 10s of the stream. see docs/status.md (at `image: ${IMAGES:-}stream-api:${TAG:-latest}`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- healthy, not started: the api creates the tables (accounts included) on its way up, and the gateway reads them from its first hello on (at `api:`)
- one socket per browser, every page: a file descriptor each (see the chat's note) (at `ulimits:`)
- no host port. browsers reach this through the frontend, at /events (at `home:`)
- the home list: every live stream and how many are watching it, in memory, from the facts on the `events` redis stream (`live`, `viewers`, `ended`), built from video's own word at boot and checked against it every 30s. answers GET /api/streams once per home page load; the page then takes the same facts over the events socket, so nothing polls. first on, first shown; the ranking of the home page, when there is one, goes here. the api binary run as `api home`, same image, no extra build. see docs/status.md and api/src/home.rs (at `image: ${IMAGES:-}stream-api:${TAG:-latest}`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- no host port. browsers reach this through the frontend, at /api/streams (at `database:`)
- no host port. older docker leaks "127.0.0.1" ports to the lan. peek with: docker compose exec database psql -U stream (at `healthcheck:`)
- no save file. a restart loses who is live, every room's chat history and the login/signup counters. the database keeps the bio and the accounts. (at `command: redis-server --save "" --appendonly no`)
- no host port. peek with: docker compose exec redis redis-cli (at `healthcheck:`)
- minio's images are not public any more. seaweedfs `weed mini` is one process: s3 on :8333, and it creates S3_BUCKET itself. login is stream / stream-s3, the same literals api/src/s3.rs signs with when S3_ENDPOINT is off. path-style. (at `image: chrislusf/seaweedfs:4.48`)
- a 403 is the server up and asking for the signature. no answer is down. no host port. the bucket name is S3_BUCKET. (at `healthcheck:`)
- processes + threads, together. every live stream costs one ffmpeg (a few threads) for its thumbnail, and anyone can publish; this stops a flood from starving the box instead of the stream. room for 25 or so streams. no cpu or memory limit on purpose: small vms vary, and a limit that kills video ends every stream at once. (at `pids_limit: 256`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- a picture of every live stream every few seconds, served at /thumb/<name>.jpg. THUMBS=0 turns it off (at `THUMB_EVERY_SECS: "5"`)
- webrtc_ice at error: at warn it logs one line per stray udp packet (at `RUST_LOG: "warn,video=info,webrtc_ice=error"`)
- all the video packets, one port. host port must equal container port. (at `- "7882:7882/udp"`)
- 7880 (the setup websocket) stays inside. browsers reach it through the frontend, at /ws (at `dummy:`)
- fake streams for styling and debugging. each one is a few gifs (random-media/gifs, dealt out at random) bouncing around, the stream's name on top, a clock, plus a quiet tone. same binary as video, run as `video dummy`, with ffmpeg drawing the picture. DUMMY_STREAMS=0 means it sits idle. change .env, then: ./scripts/deploy.sh dummy (at `build:`)
- one ffmpeg per fake stream, like video above: ~30 threads each on a many-core box (the lavfi source's pool grows with the cores). raise it before DUMMY_STREAMS goes past ~15 (at `pids_limit: 512`)
- the dummies get the cpu last: a cgroup weight of 128 against everyone else's default 1024, so when the box is busy video, the api and the rest win and the fake streams stutter instead. inside the container ffmpeg also runs at nice 19, but nice only ranks processes within one cgroup; this is the lever between containers. it costs nothing on an idle box (at `cpu_shares: 128`)
- optional: your own names, comma separated. default: dummy-mango, dummy-pixel, ... (at `DUMMY_NAMES: ${DUMMY_NAMES:-}`)
- the dummy streams' chatter: on unless DUMMY_CHAT is 0, off or false; a line every DUMMY_CHAT_INTERVAL_MS (default 1000). empty means the defaults (at `DUMMY_CHAT: ${DUMMY_CHAT:-}`)
- each dummy stream and a pretend viewer talk in its room. leave empty (or DUMMY_CHAT=off) to turn that off. (at `CHAT_WS_URL: ws://chat:4100`)
- the voice sfu for the servers' voice channels: same image as video, run as `video voice` (video/src/voice.rs). a page brings a grant from the api, we redeem it with VOICE_SECRET (the api's own) for the person and the room, and tell the api who is in. off by default: the profile keeps a plain `up -d` and deploy.sh from creating it. turn it on with a VOICE_SECRET in .env, udp 7883 open in the firewall (docs/voice.md), then docker compose --profile voice up -d voice until then /voice is a 502 and the api answers voice joins with a 503. (at `image: ${IMAGES:-}stream-video:${TAG:-latest}`)
- no ffmpeg here, only webrtc. the same cap as video (at `pids_limit: 256`)
- off turns the per-route request limits off (docs/rate-limits.md). unset: on (at `RATE_LIMITS: ${RATE_LIMITS:-}`)
- empty: no grant can be redeemed, and every join is "voice is not open" (at `VOICE_SECRET: ${VOICE_SECRET:-}`)
- webrtc_ice at error: at warn it logs one line per stray udp packet (at `RUST_LOG: "warn,video=info,webrtc_ice=error"`)
- the image's own check looks at video's port; this one looks at ours (at `healthcheck:`)
- all the voice packets, one port. host port must equal container port. (at `- "7883:7883/udp"`)
- 7881 (the voice websocket) stays inside. browsers reach it through the frontend, at /voice (at `volumes:`)

- `agent`: the api image as `api agent`, on every box, no profile. root (`user: "0:0"`) for the docker socket and the host's `/proc`, both read-only, with `read_only`, every capability dropped, `no-new-privileges` and 64 pids. `/proc` is bind-mounted at `/host/proc` rather than `pid: host`, which would let it signal host processes. the named volume `agent-disk` at `/disk` is there for its `statvfs`: a volume lives on docker's own filesystem, so its size is that disk's, on any host. no port; caddy reaches it at `agent:4300`. `TIMINGS_FROM` names the api processes whose endpoint timings it pulls each sample, at `<service>:9300/timings` on the default network (`docs/metrics.md`, "endpoint and call timings"), and `HEALTH_FROM` the services whose http health endpoint it asks each sample, `chat`, `events`, `home`, `video` and `voice` by default, overridable per box in `.env` (`docs/metrics.md`, "the agent"), and `COUNTS_FROM` where it reads the site counts (online, live, watching, voice) each sample, the events gateway's `/online` and video's and voice's `/health` by default, numbers only (at `agent:`)
- `api`, `chat`, `events`, `home` each also listen on `:9300` (`TIMINGS_PORT`) for the agent's `GET /timings`: unpublished, not in the Caddyfile
- the network `stats` (`stream_stats`): caddy's, and the monitor's from its own compose project (`monitor/beside-app.yml`). the monitor is not a service here, so no `up`, `down` or `restart` of the app reaches it; `down` leaves this network while the monitor is on it (at `networks:`)
- caddy gets `STATS_BASIC_AUTH_USER` and `STATS_BASIC_AUTH_HASH` with `statsoff` for a blank value (see the Caddyfile's stats block), and `STATS_PUBLIC`; the monitor gets `STATS_PUBLIC` as `PUBLIC` (at `STATS_BASIC_AUTH_USER: ${STATS_BASIC_AUTH_USER:-statsoff}`)

## `Cargo.toml`

- Smaller binaries. strip runs after the link, so it saves image size, not build memory (that is CARGO_BUILD_JOBS, in deploy.sh). debug = false is already the release default; spelled out so nobody wonders. (at `[profile.release]`)

## `.dockerignore`

- rust build output (at `target`)
- not part of the rust images (at `.git`)
- host config, must not end up inside an image (at `.env`)
- the seed script's pictures (seed.sh). random-media/gifs stays: the dummy image copies it (at `random-media/random-pfps`)
- editing these must not invalidate COPY layers (at `docker-compose.yml`)

## `.github/workflows/images.yml`

- builds the four images on github's machines on every push to main that touches what they are built from (`paths` below: the list in ./image-paths, written out by hand because a filter cannot read a file) and pushes them to ghcr.io/<owner>/stream-<x>:<tag>, :v<n> and :latest. the tag is the last commit that touched ./image-paths (not the push head: a push can end on a docs commit), 7 characters; deploy.sh and ship.sh name the images by the same rule, so a docs-only commit runs the images of the one before it and nothing is recreated for it. v<n> is the release: one more than the highest v<n> tag in the repo, taken by the `version` job before anything is built, put on every image, and — once all four are pushed — on the commit as a git tag by the `release` job. so v13 is a set of four images that exist, and the commit they came from. a commit already tagged (a re-run) keeps its number. one run at a time (`concurrency`), so two pushes cannot both take v13. on the box, deploy.sh finds the highest v<n> reachable from its HEAD and records it after the health check: /api/health says it under `version`. `./scripts/deploy.sh --images v13` pins the set by hand. see docs/spec.md, "deploy script", and api/src/release.rs. the box then runs ./scripts/deploy.sh --pull --images and pulls those, building nothing. free: actions minutes are unlimited for a public repo, and public packages cost nothing. the runners are x86-64, so no emulation: the same dockerfiles ./scripts/deploy.sh and ./scripts/ship.sh use, built natively on 4 cores. the dependency layers are cached between runs (type=gha), so a source change is a few minutes; a Cargo.lock change rebuilds them once. the GITHUB_TOKEN pushes the packages and the tag; no personal token anywhere. packages a workflow creates take the repo's visibility, so from a public repo they are public from the first push and the box pulls without a login. (a push from a laptop with ./scripts/ship.sh makes them private instead; then: github › your profile › Packages › stream-x › Package settings › Change visibility.) a tag pushed with the GITHUB_TOKEN starts no other workflow, by github's rule; nothing here wants one. (at `name: images`)
- the list this filter copies: a change to it always builds, so the two cannot drift unnoticed (at `- image-paths`)
- one run at a time, in order: the version is counted from the tags, and the tag lands at the end of the run. a push during a run waits; a third replaces the one waiting (its commit gets no number of its own, the next run's set covers it) (at `concurrency:`)
- the names everything below uses: the image tag, the registry owner, the release (at `version:`)
- the whole history, tags included: the image tag is found by walking back to the last commit that touched the image paths, and the release by the highest tag so far (at `- uses: actions/checkout@v4`)
- the tag: the last commit that touched what the images are built from, 7 characters, the same rule and the same list (./image-paths) as deploy.sh and ship.sh. owner lowercased, ghcr wants that (at `- id: meta`)
- BUILD stays the commit, not the release: it is what the image was built from, and /api/health says the release from the database (api/src/release.rs), so an image that did not change between two releases is the same image under two tags (at `- uses: docker/build-push-action@v6`)
- links the package to this repo on github; the version is on the image for `docker image inspect` (at `labels: |`)
- the git tag, last: only once all four images are in the registry under v<n>, so the tag never names a release that is not there. a failed image leaves no tag, and the next run takes the same number again, over the half-pushed set (at `release:`)

## shell comments inside YAML

- `.github/workflows/images.yml`, in a shell block: already there (a re-run): fine on this commit, wrong on another
- `.github/workflows/images.yml`, in a shell block: an empty list would make `git log -1 --` plain HEAD, a tag deploy.sh never asks for
- `.github/workflows/images.yml`, in a shell block: the release: the v<n> already on this commit (a re-run keeps its number), else one
- `.github/workflows/images.yml`, in a shell block: more than the highest anywhere in the repo (a number taken on another branch stays taken)
- `docker-compose.yml`, in a shell block: 825 days and serverAuth: the most apple devices will accept if you ever trust it by hand

## `test/voice-spike.js`

Voice spike (video/src/voice.rs): two browsers hear each other through `video voice`. A and B
join spike/lounge, each offering one sendrecv m-line (the fake mic) and 15 recvonly ones; each
hears the other on the m-line the seats frame names, and getStats shows those packets growing.
C comes and goes without anyone renegotiating (negotiationneeded and signalingState are
counted), and A and B keep hearing each other while their seats frames show C come and go.
Closing B's browser frees B's seat: A's seats frame drops it and the next comer sits there.
Not in scripts/test.sh. Run a server first, then:
  VOICE_DEV_OPEN=1 PUBLIC_IP=127.0.0.1 cargo run -p video -- voice
  node test/voice-spike.js            (VOICE_URL=ws://127.0.0.1:7881/ws by default)
A server without VOICE_DEV_OPEN turns the join away and this fails with 'voice is not open'.

## `test/voice-video.js`

Video in voice (video/src/voice.rs, docs/voice.md): three headless chromes with fake devices
(a beeping mic, the moving test picture) in one voice room of a `video voice` started with
VOICE_DEV_OPEN=1. Each joins with the page's offer (1 sendrecv mic + 15 recvonly audio), then:
A and B turn their cameras on (a new sendonly VP8 m-line, offered again with its mid named
`camera`), and every one of A, B and C gets the others' audio and video with frames decoding,
each picture on the mid its seats frame names; A shares its screen mid-call (a second sendonly
line named `screen`) and B and C decode it next to A's camera, at the screen's size; A's camera
goes off (its line inactive) and the others' seats frames drop it while the screen keeps
going; B's mute and deafen show in A's seats frame; C leaves and the rest go on. How long a
new viewer waits for its first picture (the PLI on subscribe) is printed and kept under 3s.
Not in scripts/test.sh: it needs its own voice server. Run one first, then this:
  VOICE_DEV_OPEN=1 PUBLIC_IP=127.0.0.1 VOICE_WS_PORT=17881 VOICE_UDP_PORT=17883 cargo run -p video -- voice
  VOICE_URL=ws://127.0.0.1:17881/ws node test/voice-video.js

## `test/voice.js`

Voice channels (api/src/voice.rs, video/src/voice.rs). Two parts.
The api part always runs: a voice channel is made (kind voice in the room and on the channel
fact; a kind that is neither 400), it is no chat (its socket and its search say `no such
channel`), the voice power is reached like any other (a roles holder cannot hand it out, the
owner can), and the join route's answers: nobody 401, not a member 403, a channel that is not
there or kept from you 404, a text channel 400, a member gets a 64-hex grant for /voice good for
30s (a stack with no VOICE_SECRET answers it 503 `voice is off` instead), and the internal
redeem route is a 404 from outside. Locally it also writes who is in voice
straight into redis (as the voice server's calls would) for `already in voice` 409, `channel
full` 409 (the owner never kept out) and the room's `voice`, which hides a channel you cannot see.
The voice server part runs only with VOICE=1, against a stack started with `--profile voice` and
a VOICE_SECRET: two logins join through grants and hear each other, a watcher of group:<name>
on /events hears `voice` for both, the room shows them, a grant used once is `bad grant` the
second time, and a closed page is `voice_left` within 20s.
Run through ./scripts/test.sh (VOICE=1 ./scripts/test.sh voice for both parts), or:
BASE_URL=https://<ip> [LOCAL=1] [VOICE=1] node voice.js
The local-only and voice-only steps say SKIP when they cannot run, not PASS.
