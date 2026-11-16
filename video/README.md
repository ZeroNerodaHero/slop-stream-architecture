# video

the webrtc box. one upload in, copies of the packets out. no decode on the media path. no redis, no database.

- websocket on `:7880/ws` (caddy publishes this as `/ws`)
- media on udp `:7882` (this port is published on the host; it must match inside the container)
- `GET /live`, `GET /viewers`, `GET /health`, `/thumb/<name>.jpg` on `:7880`

a publisher's offer can carry several video sections (camera and screens). each is a slot. a screen that starts mid-stream reaches watchers without renegotiation. later json frames carry `slots` and an optional `scene` (layers in a 16:9 frame). every player draws that frame.

`src/main.rs` is the room and the signaling. `src/media.rs` is codecs and ice. `src/thumbs.rs` is the side ffmpeg that writes a jpeg every few seconds for home cards. `src/dummy.rs` is `video dummy`: fake gif streams, off unless `DUMMY_STREAMS` is set.

redeploying this container ends every live stream. `./scripts/deploy.sh video` warns first. see `docs/architecture-picture.md` and `docs/viewers.md`.
