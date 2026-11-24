# monitor

its own compose project, `monitor`. the app's `docker-compose.yml` does not have it, and app deploys never stop, restart or recreate it: only `./scripts/deploy.sh stats` does (`docs/metrics.md`, "the monitor and app deploys").

it runs the api image as `api monitor`, `restart: unless-stopped`, on loopback port 3002 (`MONITOR_PORT`). it polls `GET /api/health` on the boxes in `STATS_TARGETS` and, with their tokens in `STATS_TOKENS`, `GET /api/errors` and `GET /api/metrics` (each box's agent: host and container numbers and endpoint timings, graphed for 1h, 24h and 7d), and posts down and up to `STATS_ALERT_WEBHOOK`. state is `/data/monitor.json` and `/data/metrics.json` in the volume `monitor-data`.

on test-machine, `./scripts/deploy.sh stats` runs it with `beside-app.yml`: on the app's `stream_stats` network as `stats`, behind the app's caddy at https://stats.nodentity.xyz, and behind its own caddy too when `STATS_HTTPS_PORT` is set in the root `.env`.

on a box of its own, with its own caddy on 443:

```
cp .env.example .env
docker compose --profile tls pull
docker compose --profile tls up -d --no-build
```

fill in `STATS_TARGETS`, `STATS_TOKENS`, `MONITOR_IMAGE`, and `STATS_PUBLIC=true` or `STATS_BASIC_AUTH_USER` and `STATS_BASIC_AUTH_HASH` first. without `--profile tls` there is no caddy and `ssh -L 3002:127.0.0.1:3002 <this-box>` is the door.

moving it off test-machine: `docs/metrics.md`, "the monitor on a box of its own". the long doc: `docs/debugging.md`.
