# slop-stream-architecture

one computer. you open its ip. one person goes live. other people watch like fucking cuck lamo

this is a live-stream site for a single machine: a rust api, a rust webrtc box that copies packets, postgres, redis, a local s3, and a react front end behind caddy. accounts are optional. the long docs live in [`docs/`](docs/README.md). start with [`docs/overview.md`](docs/overview.md). the contract is [`docs/spec.md`](docs/spec.md).

```
git clone https://github.com/ZeroNerodaHero/slop-stream-architecture.git
cd slop-stream-architecture
./scripts/deploy.sh          # on a server: pull images the github action built
# or, on a laptop with docker:
./scripts/deploy.sh --build
```

it prints a url. open it. click through the certificate warning. the camera needs https.

## what you get

- `/` — who is live
- `/live` — go live (camera, screens, pictures, mic, a 3d model as a face cam)
- `/watch/<name>` — watch, or their profile if they are off
- `/groups` — open servers, channels, roles
- follows, dms, notifications, presence

## work on the pages

```
cd frontend && npm install && npm run dev
```

open http://localhost:42069. by default this talks to the docker stack on this machine. to talk to a box instead, put `BACKEND=https://<ip>` in `frontend/.env` (see `frontend/.env.example`).

## tests

```
./scripts/test.sh                  # this machine
./scripts/test.sh https://1.2.3.4  # a server
./scripts/test.sh --all            # also redeploy and dummy streams
```

needs node and google chrome.

## update and stop

```
./scripts/deploy.sh --pull         # git pull, then the images for that commit
./scripts/deploy.sh api            # only the api; streams stay up
./scripts/deploy.sh frontend       # only the pages; streams stay up
./scripts/deploy.sh video          # ends every stream; it warns first
docker compose down                # stop. add -v to also drop the database
```

there is no email password reset: `./scripts/deploy.sh passwd <name>` prints a new one.

a full restart runbook (single services, a hard dev wipe, health, logs, a remote box) is not in this file on purpose; see `docs/overview.md`, `docs/debugging.md`, and the comments at the top of `scripts/deploy.sh`.

## ports

- 80 and 443, tcp — the site
- 7882, udp — the video

## layout

- `api/` — http api, chat, events, home, and monitor (one binary)
- `video/` — webrtc sfu and the dummy streams
- `frontend/` — the pages
- `scripts/` — deploy, ship, test, seed, models
- `monitor/` — a second compose file that watches boxes
- `docs/` — the human docs
- `.github/workflows/images.yml` — builds the four images on every push to `main` that touches them

## env

copy `.env.example` to `.env` only if you start compose by hand. `./scripts/deploy.sh` writes it. names only: `PUBLIC_IP`, `ADMIN_NAMES`, `OPS_TOKEN`, `DUMMY_STREAMS`, `S3_ENDPOINT`, and the rest in that file. do not commit `.env`.
