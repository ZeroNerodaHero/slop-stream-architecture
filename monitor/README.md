# monitor

a second compose project. it is not started by the main `docker-compose.yml`.

it runs the api image as `api monitor` on loopback port 3002 (override with `MONITOR_PORT`). it polls `GET /api/health` and, if you set tokens, `GET /api/errors` and `GET /api/metrics` (each box's agent: host and container numbers, graphed for 1h, 24h and 7d) on the boxes in `TARGETS`.

```
cp .env.example .env
# set TARGETS=prod=https://1.2.3.4,dev=https://5.6.7.8
# optional: OPS_TOKENS, ALERT_WEBHOOK, CHECK_EVERY_SECS, DOWN_AFTER
docker compose up -d
# from your laptop:
ssh -L 3002:127.0.0.1:3002 <this-box>
# open http://localhost:3002
```

the page has no login of its own; ssh forwarding is the door. state is `/data/monitor.json` and `/data/metrics.json` in a volume.

the same monitor also runs beside the main stack as https://stats.nodentity.xyz, behind caddy's basic auth (`docs/metrics.md`). this one is for watching that box from outside.

`docs/debugging.md` is the long doc. the monitor *box* itself is still something you stand up (the code is here; the machine is not provided).
