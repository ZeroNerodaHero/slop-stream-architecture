# Relay (restream to Twitch, Kick, YouTube, custom RTMP)

The relay takes one extra WebRTC (WHIP) publish from the go live page and pushes it to every destination the streamer has switched on. It runs next to the video service but shares nothing with it: if the relay dies, the stream on nodentity keeps going and only the copies stop.

## How a stream flows

1. The go live page goes live on the video service as before.
2. If at least one destination is on and the api has `RELAY_URL` and `RELAY_SECRET`, the page asks `POST /api/relay/start` for a publish grant. The api checks the session is the streamer's own verified one, stores a 10 minute token in redis, sets the Twitch/Kick titles and binds a YouTube broadcast, and answers with the WHIP url `${RELAY_URL}/<session>/whip`.
3. The page draws the scene (camera, screens, images, avatar) into a 1920x1080 canvas at 30 fps (1280x720 on phones and machines with fewer than 8 cores), mixes the sound, and publishes it over a second `RTCPeerConnection`: H.264 only, about 4.5 Mbps, keyframe every 2 s.
4. MediaMTX inside the relay asks the relay's auth hook, which asks the api (`POST /internal/relay/auth`, `x-relay-secret`). Nothing else may publish, and reads are allowed only from localhost over RTSP.
5. For each target from `GET /internal/relay/targets` the relay runs `ffmpeg -c:v copy -c:a aac -b:a 160k -f flv <rtmps url>`, restarting a failed one after 1, 2, 4, 8, 16, then 30 s, and fetching a fresh key every third failure. Keys are scrubbed from every log line and status message.
6. Each egress reports `connecting`, `live` (repeated every 15 s) or `error: ...` to `POST /internal/relay/status`. The destinations rail polls `/api/destinations` every 3 s while restreaming and shows it per row. A status not repeated within 40 s disappears.
7. Stop on the page drops the grant (`POST /api/relay/stop`) and completes the YouTube broadcast.

`/internal/relay/*` is outside `/api`, so Caddy never serves it; only containers on the compose network reach it.

## Straight from the desktop app

In the desktop app, going live sends the stream to each destination from the streamer's own machine instead of through the relay. This is the setting **send to destinations from this app** under settings, this app, advanced, which is on by default there and is not shown on the web.

1. The page asks `POST /api/relay/direct` (the same checks as `/api/relay/start`). It sets titles and binds YouTube as usual and answers with the streamer's own targets (url and key, `Cache-Control: no-store`).
2. The same scene canvas is encoded in the page with WebCodecs: H.264 Constrained Baseline at 4.5 Mbps with a keyframe every 2 s, and AAC-LC 160 kbps at 48 kHz stereo from the mixed sound.
3. Each encoded frame goes to the native shell (`restream_direct_packet`, raw bytes). The shell's `rtmp.rs` publishes one RTMP or RTMPS connection per destination, checking certificates against the webpki roots. Each connection restarts on its own with the same 1 to 30 s backoff, and keys never appear in a status.
4. The rail reads `restream_direct_status` every second, so rows show `live`, `connecting` or `error: ...` exactly as with the relay.

The page falls back to the relay (when the relay is set up) if the app is too old to have the `restream_direct_*` commands, if the webview cannot encode H.264 and AAC (WebKit added AAC encoding in Safari 26, which macOS Sonoma and newer can install), or if the native side fails.

It costs the streamer's machine one H.264 encode plus one upload per destination, about 4.7 Mbps each.

## Off by default

Nothing changes until both are set on the api:

| env | where | what |
| --- | --- | --- |
| `RELAY_URL` | api | public base of the relay's WHIP, e.g. `https://relay.nodentity.xyz` |
| `RELAY_SECRET` | api and relay | at least 16 characters, the same on both, e.g. `openssl rand -hex 32` |
| `RESTREAM_DIRECT` | api | `1` lets the desktop app fetch its targets and send straight to them; it needs no relay |
| `RELAY_PUBLIC_IP` | relay | public ipv4 that ICE should advertise (falls back to `PUBLIC_IP`) |
| `RELAY_API_URL` | relay | only when the relay runs on another machine: a private address of the prod api, since the public site does not serve `/internal/relay/*` |

The relay service is in the `relay` compose profile, so `scripts/deploy.sh` never builds or starts it.

## Measured cost

On the box (8 vCPU Xeon), one 1920x1080 30 fps stream at about 4.5 Mbps:

- MediaMTX ingest: about 2.3% of one core per streamer.
- ffmpeg per destination (video copied, Opus to AAC): about 6% of one core.
- Bandwidth: about 4.7 Mbps in per streamer, and about 4.7 Mbps out per destination.

So one streamer going to Twitch, Kick and YouTube costs about 0.2 of a core and about 19 Mbps of traffic. Ten such streamers is about 2 cores and 190 Mbps sustained.

## Where to run it

**Recommended: a separate small box** (a Hetzner CPX21 or CPX31, or a GCP e2-standard-2) running only the relay. Its egress bill and CPU never compete with the video service, a restream spike cannot slow anyone's viewers, and it can be restarted or resized on its own.

Steps (each needs Billy's OK):

1. Create the box, open TCP 443 and UDP 8189 to the world, and nothing else but SSH.
2. DNS: an `A` record `relay.nodentity.xyz` pointing at it (DNS only, not proxied by Cloudflare, since WHIP needs the UDP port on the same address).
3. On the box, clone the repo, write `.env` with `RELAY_SECRET`, `RELAY_PUBLIC_IP=<its ip>`, `PUBLIC_URL=https://nodentity.xyz` and `RELAY_API_URL=<the prod api reached privately>`, then `docker compose --profile relay up -d --build relay`.
4. Put Caddy in front for TLS on 443:

   ```
   relay.nodentity.xyz {
   	reverse_proxy 127.0.0.1:8889
   }
   ```

   and publish `8889` to localhost only in that box's compose override.
5. On prod: the internal relay routes must be reachable from the relay box only, e.g. a WireGuard or VPC link, or a Caddy site on prod that serves `/internal/relay/*` only to the relay box's ip.
6. On prod `.env`: `RELAY_URL=https://relay.nodentity.xyz` and the same `RELAY_SECRET`, then restart the api.

**Alternative: the existing prod VM.** Simplest to wire, since the api is on the same compose network and `RELAY_API_URL` stays `http://api:4000`:

1. Firewall: open UDP 8189.
2. DNS: `relay.nodentity.xyz` to the prod ip, DNS only.
3. Add the Caddy site above (pointing at `relay:8889`) to `frontend/Caddyfile`.
4. `.env`: `RELAY_URL=https://relay.nodentity.xyz`, `RELAY_SECRET=<new>`, then `docker compose --profile relay up -d --build relay` and restart the api.

The cost is about 0.2 of a core and 19 Mbps per streamer with three destinations on the same machine and uplink as the video service.

## Notes

- ffmpeg receives the RTMP url with the key on its command line, which is visible only inside the relay container.
- MediaMTX's own API listens on 127.0.0.1 inside the container and is not published.
