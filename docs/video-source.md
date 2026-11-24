# video/ source

the header comment of each file in `video/src` and the doc comment of each top-level item, plus the notes from video's Dockerfiles and Cargo.toml, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a piece was written for at the time of the move, so check a detail against the code before trusting it. `video/src/voice.rs` was left out of that sweep (#182 touches it) and still carries its own.

## `video/src/dummy.rs`

`video dummy`: fake streams for styling and debugging.

Each stream is a few gifs bouncing around a dark frame like the old dvd logo,
the stream's name on top, a clock at the bottom, plus a quiet tone. ffmpeg
draws and encodes (VP8 + Opus) to RTP on localhost; we forward those packets
into the video server the way a browser would: go-live at the api, then the
same websocket and offer/answer with the session and token it got, plus the
dummy password.

Env: DUMMY_STREAMS (how many, 0 = idle), DUMMY_PASSWORD (must match the
server), DUMMY_NAMES (optional comma list), VIDEO_WS_URL, API_URL, DUMMY_FONT,
DUMMY_GIFS (a folder of .gif files; none there and a coloured box bounces instead).

`const FPS`: The frame rate, and the keyframe interval in frames: a keyframe every second. ffmpeg cannot
be asked for one (the PLIs video forwards when a watcher joins are read and dropped in
`publish_on`), so a new watcher of a dummy waits for the next one on this schedule: half a
second on average, at most one. docs/keyframes.md.

`const GIFS_PER_STREAM`: How many gifs bounce around one stream. The frame is 480×270 and they are 90 to 120 tall.

`const CORNERS`: Where a stream's gifs start, in turn: top left, bottom right, top right, bottom left.
`(from the right, from the bottom)`.

`const HEIGHTS`: Heights the gifs are shown at, in turn. Even, so the chroma of the yuv420 frame lines up.

`const CLOCK`: drawtext's `%{pts}` as `HH:MM:SS` (the time of day of `pts` seconds past the epoch). The
colons inside `%{}` are escaped once for drawtext and, the `\\\:` ones, once more for the
filter option parser that runs first.

`enum Sprite`: One thing bouncing around a stream's frame.

`async fn chatter`: One pretend chatter: join the room, say a line every `every` seconds, come back
after 5s if the chat server drops us. `seed` picks the lines so rooms differ.
A refused hello (someone signed up as this nick) is said once and the chatter
gives up, instead of reconnecting forever in silence.

`fn load_gifs`: Every `.gif` in `dir`, shuffled, so each start deals the names different gifs. Empty when
the folder is missing or holds none; a warning says so, and the streams get a box.

`fn shuffle`: Fisher-Yates on xorshift64*, seeded from the process's random hasher: no crate for one shuffle.

`fn sprites`: Stream `i`'s hand: the next few gifs of the deck after stream `i-1`'s (fewer when the deck is
short; one gif is still one), or the box when there are none.

`fn bounce`: The dvd logo's path along one axis, for the overlay filter, where `t` is the time in seconds:
a triangle wave over `span` (`W-w` or `H-h`, how far the sprite can go) at `speed` pixels a
second. It starts at the far end, or at zero (half a period in) when `from_far` is false.

`fn spawn_ffmpeg`: A dark frame, a few gifs bouncing around it like the old dvd logo, the name on top, a running
clock at the bottom. Each gif starts in its own corner at its own speed and height, and the
deal differs per stream, so you can tell them apart at a glance. Audio is a quiet tone, pitch
per stream. Small and `FPS` (15) on purpose: each stream costs a slice of a core to encode.

The gifs are inputs of their own, looped forever, and `overlay` moves them: its `x`/`y` are
evaluated per frame with `t` the time. (`drawbox`, which the box used to be, evaluates once,
and its `t` is the thickness: it never moved.) The image shrank the gifs to the size and rate
they are shown at, see Dockerfile.dummy; the originals cost more to decode than the stream
costs to encode.

## `video/src/limits.rs`

Requests per address per minute, in memory (this process has no redis). Only what came
through caddy is counted: it sets X-Forwarded-For; the api and home asking `/live` and
`/viewers` from inside the compose network do not. 429 with `Retry-After` past the count.
The peer caps (`MAX_WATCHERS_PER_IP*`, `MAX_PREVIEWS_PER_IP`) still bound what an open
socket may hold; this bounds how fast sockets and thumbnails are asked for.
`RATE_LIMITS=off` turns it off, like the api's.

`pub`: The count a minute for a route, by the path as written in the router.

`type Counts`: (address, route) to (window start, count)

## `video/src/main.rs`

One person in. Copies the packets out to whoever is watching.

Websocket on :7880/ws. The browser sends one text frame:
  {"role":"publish","name":"billy","sdp":"<offer sdp>","session":1,"token":2}
  {"role":"watch",  "name":"billy","sdp":"<offer sdp>"}
We answer {"sdp":"<answer sdp>"} or {"error":"..."} and keep the socket
open. Closing it hangs up. Watchers also get {"event":"ended"} when the
publisher leaves. All media rides one UDP port (7882).

A publisher's offer can carry several video sections: the camera and some
screens. Every audio/video section it sends on is a slot of the room, made
when the room is claimed, so a watcher binds to all of them at once and a
section that only starts sending later (a screen shared mid-stream) reaches
them without anyone renegotiating; its packets are routed to the slot by mid.
The publisher says what is live where with later frames on its socket,
  {"slots":[{"slot":0,"kind":"camera"},{"slot":1,"kind":"screen","label":"screen"}],
   "scene":{"layers":[{"id":"s1","kind":"screen","slot":1,"x":0,"y":0,"w":1,"h":1},
                      {"id":"cam","kind":"camera","slot":0,"x":0.73,"y":0.714,"w":0.25,"h":0.25},
                      {"id":"i1","kind":"image","asset":12,"x":0.02,"y":0.02,"w":0.2,"h":0.11},
                      {"id":"me","kind":"avatar","x":0.35,"y":0.2,"w":0.3,"h":0.6}]}}
(`slot` counts its video sections from 0, and a slot not named is not live: a mic-only
publisher names no slot 0 and leaves the camera's section quiet; `scene`, optional, is how
it lays its frame out, see `Scene`: boxes in fractions of a 16:9 frame, drawn bottom
first, and a live slot in none of them is a tile beside the picture), and watchers get each change as
  {"event":"slots","slots":[...],"scene":{...}}
right after their answer and whenever it changes. Until the publisher says,
the first video slot is the camera and there is no scene.

A publisher's session and token are what the api's go-live handed out; we
ask the api (its heartbeat route) whether that session is open for that
name, so a stranger who skips the api cannot publish under a claimed name.
Once the room is claimed and answered we tell the api so (its `attached`
route, same grant): that is when it pushes `live` to the watchers waiting on
the name, so the first one to connect on the push is served. When the
publisher leaves we call its `stop`.

Watchers and the publisher also get {"event":"viewers","viewers":3}: how many
different addresses are receiving the stream right now, sent at most once a second
and only when it moved. A watcher counts once its ICE and DTLS are done, by the
address its media really goes to (the selected candidate pair), so a view is a
peer taking real packets, not a request. One address holds at most
MAX_WATCHERS_PER_IP_ROOM peers in a room and MAX_WATCHERS_PER_IP in all; past
that it gets {"error":"too many watchers from your address"}. docs/viewers.md.
A watch frame may carry "preview":true (home's muted camera previews): a preview
gets the same answer and events but is not counted as a viewer and spends none of
those caps; one address holds at most MAX_PREVIEWS_PER_IP previews in all, past
that it gets {"error":"too many previews from your address"}.

Also on the same port: GET /live (names connected right now), GET /viewers
({name: viewers} for every live room) and GET /health
({ok, up_secs, build, live, viewers}; the api folds it into /api/health).
Env: PUBLIC_IP, WS_PORT (7880), UDP_PORT (7882), API_URL (http://api:4000),
DUMMY_PASSWORD, DUMMY_PREFIX, BUILD.

Names starting with DUMMY_PREFIX ("dummy-") are reserved for the fake streams
of `video dummy` (see dummy.rs): publishing one needs the matching password too.

`const KEYFRAME_GAP`: Forwarded keyframe requests are rate limited to one per this gap, per slot.

`const FORCED_KEYFRAME_GAP`: Joins ask at most once per this gap per slot, and the thumbnail waits this long
after any request: a burst of joins shares keyframes instead of one each.
docs/keyframes.md.

`const KEYFRAME_IN_FLIGHT`: A request this recent with no keyframe forwarded since is taken as on its way: a
join in that time is served by it. Past this the request is taken as lost.

`const HANDSHAKE_TIMEOUT`: The browser has this long to send its one message, and we have this long to answer.

`const API_TIMEOUT`: The api gets this long to say whether a publisher's session is real.

`const SHUTDOWN_FLUSH`: After SIGTERM, how long the open sockets get to send their `ended` before we exit.

`const MAX_SDP_BYTES`: Biggest offer we accept. A real one is 5-20 KB (chrome: about 4.5 KB per video section).

`const MAX_MEDIA_LINES`: Audio, the camera, three screens, and one to spare. Each costs a transceiver per peer.

`const MAX_KIND_BYTES`: A slots frame: how long its `kind` and `label` strings may be.

`const MAX_LAYERS`: A scene: layers at most, and a layer's id at most. Each layer is a box a watcher draws,
and every watcher gets the whole list in every slots event.

`const MAX_WATCHERS_PER_IP_ROOM`: Watcher peers one address may hold in one room, and across every room. Tabs and
households share an address; past this it is someone pulling copies on purpose,
and every copy is ~2.5 Mbps of our egress.

`const MAX_PREVIEWS_PER_IP`: Preview peers (home's muted cameras, `preview: true`) one address may hold across
every room. Kept apart from the watcher caps so a few home tabs behind one address
never lock it out of watching; this bounds their egress on their own.

`const VIEWERS_TICK`: How often a socket is told the count, at most. Only sent when it moved.

`struct Slot`: One m= section of the publisher's offer and the track its packets are copied into.

`enum Ask`: Why a keyframe is wanted on a slot.

`enum Plan`: What to do with a keyframe request.

`struct KeyframeAsks`: A slot's keyframe requests: when they went out, and whether one has been answered.

`struct SlotInfo`: What a publisher says is live in one of its video slots, for the watchers' layout.
`slot` counts the video sections of its offer from 0: the camera, then the screens.

`struct Layer`: One box of a publisher's frame (docs/screen.md): a video slot of its own offer (`camera`,
`screen`), a picture it put up at the api (`image`, by asset id; the watcher builds the
url under the stream's name), or the publisher's avatar (`avatar`: the profile picture
under the stream's name, which the watcher draws and moves with the sound it receives, so
the layer carries nothing but its box). `x`,`y` is the top left corner and `w`,`h` the
size, all fractions of a 16:9 frame, so every player draws the same picture at any size.
`fit` is a video's: `cover` fills the box, `contain` shows the whole picture. Passed on as
it came, once checked.

`struct Scene`: How the publisher lays its frame out, bottom layer first: the array order is the z-order.
A live video slot that is in no layer is a tile beside the watcher's picture. Absent: the
watcher's own rule (the dummy, an older page).

`struct SlotsFrame`: A publisher's later frame: the video slots live right now (absent means not live), and
how its frame is laid out (absent: the watcher's own rule).

`struct Showing`: What the publisher says it shows: the live video slots, and its scene if it sent one.
Watchers get the two together, in every `slots` event.

`pub`: The one UDP socket every peer shares, with big buffers so a keyframe burst
to many watchers does not drop packets. Asking is not getting: linux caps a
plain SO_SNDBUF/SO_RCVBUF at net.core.wmem_max/rmem_max (208 KB by default)
without an error, so read back what the kernel gave and say so once.

`async fn health`: `up_secs` going backwards between two looks means this process restarted.

`async fn viewers`: `{name: viewers}` for every live room: the names are /live's, the numbers what the
rooms' sockets are told.

`async fn thumb`: `GET /thumb/<name>.jpg`: the latest picture of a live stream, a few seconds old.

`pub`: The browser's address as caddy saw it. 7880 is only reachable inside the compose
network, and caddy replaces whatever X-Forwarded-For a browser sent with the real
one, so the last entry is caddy's word. The fallback when ICE does not say.

`async fn owns_stream`: Is this the session the api's go-live handed out for that name, still open?
The api's heartbeat route answers exactly that (200 / 403) and refreshes the
live key on the way, which does no harm. Err carries the reply for the browser.

`async fn publish`: `grant` is the go-live session and token the publish frame carried (checked by `owns_stream`):
when the publisher leaves, the api's own `stop` is called with them, so a crashed tab stops
being `streaming` within seconds instead of the sweeper's minutes. See docs/status.md.

`async fn tell_attached`: The publisher is here: tell the api with the grant it gave, through its `attached` route,
and the api publishes `live` for the name's watchers now, not at go-live (a watcher told
then would have been answered "not live" by us). A few tries a second apart, since nothing
else says it: past them the gateway's own 30s recheck reads the key and tells the watchers.
A 4xx is the api's word (the session is not open any more) and is not retried.

`async fn end_session`: The publisher is gone: tell the api with the grant it gave, through its own `stop` route,
so the row ends, the key goes and the watchers are told now. Awaited, not spawned: the
socket and peer are already closed, nothing waits on this task, and on SIGTERM an awaited
call finishes inside the flush while a detached one would race the exit and lose. A page
that sent its own stop first gets this one a 403, which is the expected outcome, not an
error; the sweeper stays the backstop when the api does not answer.

`async fn watch_stream`: `wants`: how many (audio, video) sections the watcher's offer can receive on. The
room's slots are bound to them in order, as many as fit: a watcher that asks for one
video gets the camera. `preview`: one of home's muted previews, held apart from the
viewers (not counted, its own cap) but otherwise served like any watcher.

`async fn send_pli`: One PLI to the publisher for the slot with that ssrc.

`async fn media_ip`: Where this peer's media really goes: the remote side of the selected candidate
pair. Browsers hide their host candidates behind mdns names, but the pair that won
is the address the packets came from (peer reflexive), which is what we count.

`async fn tell_viewers`: Send the room's count if it moved since the last one this socket was told.
The room's count to this socket when it moved since last told. `Some(count)` when it was sent.

`async fn tell_api_viewers`: The publisher's count to the api (`viewers`, with the grant), which publishes it as a fact
for the name's watchers and for home. Once per move, at most once a second per stream, the
socket's own cadence. Best effort: nothing waits on it, and home reconciles against our
`GET /viewers` every 30s anyway.

`async fn negotiate`: Take the browser's offer, reply with our answer. Candidates are gathered
before the answer leaves, so one message each way is enough.

`struct MediaSection`: One m= section of an offer, as far as the room cares: what it carries, its mid,
and which way it goes (no direction line means both ways).

`fn offer_slots`: The room's slots in a publisher's offer: every audio/video section it sends on,
in order, with its mid. None if one of them has no mid: every browser and
webrtc-rs bundle, so every section has one, and without it the packets that
come later could not be told apart.

`fn offered_receivers`: How many (audio, video) sections a watcher's offer can receive on.

## `video/src/media.rs`

Codec and interceptor setup shared by the server and the dummy publisher.
Opus and VP8 only: every browser has both, so a publisher cannot pick a codec
some watcher lacks, and all watchers get the same bytes.

`pub fn media_setup`: `twcc`: ask the remote side for transport-wide feedback. Only useful when the
remote is a browser uploading to us; it adapts its bitrate to that feedback.

`pub fn opus_voice_capability`: Opus for voice only: mono speech at a low bitrate, with DTX so silence costs
almost nothing. Never use it for the stream; music must not get DTX.

`pub fn voice_media_setup`: Like `media_setup`, but for voice: the voice Opus for the mics, and VP8 for the cameras and
screens shown in a voice channel, with TWCC so a browser sending one adapts its bitrate.

`pub fn is_vp8_keyframe`: Whether a VP8 RTP payload starts a keyframe (RFC 7741): the first packet of
partition 0 (S set, PID 0), past the payload descriptor, with the P bit of the
VP8 frame tag clear. Only VP8 is registered above, so it is the one codec a
publisher can send us. Anything short or malformed is not a keyframe.

## `video/src/thumbs.rs`

Thumbnails, made here on the video machine for every publisher.

When a publisher's video track comes up, an ffmpeg is started next to it and
fed a copy of the VP8 packets over localhost (plain RTP, described by a tiny
SDP file). ffmpeg decodes, scales to 320px and writes one jpeg every few
seconds, atomically, to /tmp. `GET /thumb/<name>.jpg` serves that file while
the stream is live. Nothing is stored anywhere else; the file goes with the room.

Cost: decoding every frame, about 5-10% of a core per 720p stream. Viewers
pay nothing: no extra keyframes are requested. (The cheaper way, decoding
only keyframes and asking the publisher for one every few seconds, would
make every viewer download those keyframes too.)

`pub struct ThumbTap`: A running ffmpeg for one stream, and the socket that feeds it.

`const DIR`: Where the files go. One directory for all of them, so a start can sweep what a crash left.

`const LISTEN_TIMEOUT_SECS`: How long ffmpeg waits for packets before giving up on the stream. Its default is 10s,
which a publisher on wifi can outlast while ice still holds the peer (ice gives up 20s
after the last packet: 5s to disconnected, 15 more to failed): the picture would then
be gone for the rest of the stream. 0 is never. The room's end kills ffmpeg anyway.

`const MAX_DELAY_MICROS`: How long ffmpeg holds a packet back for an earlier one that has not come, in
microseconds. Its default is 100ms, and a packet the sfu got back by nack arrives
100-300ms late and is fed in arrival order: to ffmpeg that was a lost packet, and its
vp8 depacketizer then drops every frame until the next keyframe.

`pub fn due_after`: A picture older than this is past due: ffmpeg is waiting for a keyframe (a lost frame
breaks its vp8 depacketizer until one comes, and a browser sends one only when asked),
so the keyframe minder asks.

`pub fn stale_after`: Older than this, a picture is not "a few seconds old" any more and /thumb says 404
instead: ffmpeg died, or the publisher's video stopped while its connection held.

`pub async fn picture_age`: How old the stream's picture is. None: there is none (not made yet, taken down, or a
clock that stepped so far that the file is from the future).

`pub async fn sweep_stale`: The files of a run that did not get to clean up (an oom kill, `docker kill`). Every
room's files go with the room; at start there are no rooms, so anything here is stale,
and would otherwise be served as live the moment that name went live again.

`pub async fn ffmpeg_present`: Is there an ffmpeg to run? Checked once at startup.

## build and config files

### `video/Dockerfile`

- build context is the repo root (compose: context: ., dockerfile: video/Dockerfile) (at `FROM rust:1-bookworm AS build`)
- 1 keeps memory low on a small vps. deploy.sh raises it on bigger machines. (at `ARG CARGO_BUILD_JOBS=1`)
- manifests first so the dependency build is cached until a Cargo.toml changes (at `COPY Cargo.toml Cargo.lock ./`)
- every workspace member needs a target to exist, even when only building video (at `RUN mkdir -p video/src api/src \`)
- real source. touch so cargo notices it is newer than the dummy build (at `COPY video/src video/src`)
- ffmpeg makes the thumbnails (one small process per live stream). static build, no libs needed. (at `COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg`)
- the commit this was built from, reported by /health. set by deploy.sh; "dev" by hand. (at `ARG BUILD=dev`)
- an actual GET /health, not just a tcp connect: a wedged process still accepts connections (the kernel's backlog does), it just never answers. no curl in this image, so bash does it. (at `HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \`)

### `video/Dockerfile.dummy`

- the fake streams: the same `video` binary run as `video dummy`, plus ffmpeg, a font and the gifs. build context is the repo root (compose: context: ., dockerfile: video/Dockerfile.dummy). the build stage is byte-for-byte the one in video/Dockerfile, so docker reuses its layers. (at `FROM rust:1-bookworm AS build`)
- the gifs that bounce around the fake streams (random-media/gifs), shrunk once here to the size and rate they are shown at: 144 tall, 15 fps, a palette of their own. the originals are up to 640px at 50 fps, and decoding three of those per stream cost more than encoding the stream. only the small ones go into the image (3 MB, not 24). (at `FROM debian:bookworm-slim AS gifs`)
- a font for the name on the picture. ffmpeg itself is a static build, no libs needed. (at `RUN apt-get update \`)
- the commit this was built from, same as the video image. compose passes it; unused here, but docker warns about a build arg nobody declares. (at `ARG BUILD=dev`)
