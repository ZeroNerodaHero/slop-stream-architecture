# video

the webrtc box. one upload in, copies of the packets out. no decode on the media path. no redis, no database.

- websocket on `:7880/ws` (caddy publishes this as `/ws`)
- media on udp `:7882` (this port is published on the host; it must match inside the container)
- `GET /live`, `GET /viewers`, `GET /health`, `/thumb/<name>.jpg` on `:7880`

a publisher's offer can carry several video sections (camera and screens). each is a slot. a screen that starts mid-stream reaches watchers without renegotiation. later json frames carry `slots` and an optional `scene` (layers in a 16:9 frame). every player draws that frame.

`src/main.rs` is the room and the signaling. `src/media.rs` is codecs and ice. `src/thumbs.rs` is the side ffmpeg that writes a jpeg every few seconds for home cards. `src/dummy.rs` is `video dummy`: fake gif streams, off unless `DUMMY_STREAMS` is set.

`src/voice.rs` is `video voice`: a small voice sfu. a page brings a grant from the api's join route, and the box redeems it once with the api for who and which room (`<server>/<channel>`); it tells the api `attached`, `left` and a beat every 15s so the api knows who is in voice. a room has 16 seats; each person's offer is one sending audio m-line (their mic) and up to 15 recvonly ones (the others), and joins and leaves swap tracks with `replace_track`, so nobody renegotiates for them. a seat may also show a camera and a screen (VP8): the page offers again to send or to see more, and a picture new to a viewer asks its sender for a keyframe. websocket on `VOICE_WS_PORT` (7881) at `/ws`, `GET /health` there, media on udp `VOICE_UDP_PORT` (7883), advertised as `PUBLIC_IP`. env: `API_URL` (`http://api:4000`) and `VOICE_SECRET`, the same secret the api has; with it empty every join is "voice is not open". `VOICE_DEV_OPEN=1` also takes the spike's `{room, user}` join from anyone (`test/voice-spike.js`). at most 4 voice peers per address.

a new watcher's first picture is a keyframe the box asks the publisher for (a pli per video slot on join). joins in a burst share one, and a join that may have just missed it gets one trailing request 300ms on, never the 1.5s wait. there is no keyframe cache, on purpose: browsers send keyframes only when asked, so a bounded one is nearly always empty. see `docs/keyframes.md`.

redeploying this container ends every live stream. `./scripts/deploy.sh video` warns first. see `docs/architecture-picture.md` and `docs/viewers.md`.
