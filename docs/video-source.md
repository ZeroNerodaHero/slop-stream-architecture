# video/ source

the header comment of each file in `video/src` and the doc comment of each top-level item, plus the notes from video's Dockerfiles and Cargo.toml, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a piece was written for at the time of the move, so check a detail against the code before trusting it.

## `video/src/dummy.rs`

`video dummy`: fake streams for styling and debugging.

Each stream is a few gifs bouncing around a dark frame like the old dvd logo,
the stream's name on top, a clock at the bottom, plus a quiet tone. ffmpeg
draws and encodes (VP8 + Opus) to RTP on localhost; we forward those packets
into the video server the way a browser would: go-live at the api, then the
same websocket and offer/answer with the session and token it got, plus the
dummy password. Every api call carries the password as the `X-Dummy-Password`
header. Before each go-live it writes, when missing, the bio, an avatar (a
256x256 jpeg its ffmpeg draws: the stream's colour and the name's first letter)
and an about page saying it is a fake test stream; a failure there is a warn
line and the stream goes on. A go-live refused with a 403 waits 60s before the
next try (docs/test-streamers.md).

Env: DUMMY_STREAMS (how many, 0 = idle), DUMMY_PASSWORD (must match the
server), DUMMY_NAMES (optional comma list), VIDEO_WS_URL, API_URL, DUMMY_FONT,
DUMMY_GIFS (a folder of .gif files; none there and a coloured box bounces instead),
CHAT_WS_URL (empty: no chatter), DUMMY_CHAT, DUMMY_CHAT_INTERVAL_MS.

DUMMY_STREAMS=0 (or unset, or not a number) returns from `run` before anything
starts: no names, no go-live, no `dress`, no chatter, no ffmpeg; the process
waits for a signal. `stream_count` and `stream_names` are pure and tested.

Chat (`chatter`, `Script`): while a stream is live, two tokio tasks per stream
talk in its own room, two sockets, so 4 streams fill chat's 8 sockets per ip.
They start after go-live and are aborted when the stream ends.

- the stream itself: hello with its own name, the go-live `session` and
  `token`, and `bot`. It says a line every DUMMY_CHAT_INTERVAL_MS (default 1000,
  clamped to 250..60000, `chat_every`), which chat allows because a test
  stream's own grant has its own tier there (docs/test-streamers.md, chat.md).
  Lines come from `OWNER_LINES` (short, long, one near the 500 character max,
  emoji, questions, a reply-like `@pixelfan lol`, numbers, a link, two lines in
  one, an unbroken long word, `{me}` for the stream's name), picked
  pseudo-randomly per stream and never the same line twice in a row. After
  a question it answers itself half the time from `OWNER_ANSWERS`. Every line is
  cut to 500 characters.
- one guest viewer: a nick from `VIEWER_NICKS` (none under the prefix), `bot`,
  a line from `LINES` every 30 to 39 seconds, under the nick's 2 a minute.
- the tasks read what chat sends; an error frame with a `wait` (`slow down`,
  `timed out`) pushes the next line back by that much (`wait_of`). A refused
  hello logs a warn and that chatter stops; a closed socket reconnects after 5s.
- DUMMY_CHAT: on unless `0`, `off` or `false` (any case, `chat_on`); off, the
  streams run with no chatter.

`const FPS`: The frame rate, and the keyframe interval in frames: a keyframe every second. ffmpeg cannot
be asked for one (the PLIs video forwards when a watcher joins are read and dropped in
`publish_on`), so a new watcher of a dummy waits for the next one on this schedule: half a
second on average, at most one. docs/keyframes.md.

`const GIFS_PER_STREAM`: How many gifs bounce around one stream. The frame is 426×240 and they are 80 to 106 tall.

`const CORNERS`: Where a stream's gifs start, in turn: top left, bottom right, top right, bottom left.
`(from the right, from the bottom)`.

`const HEIGHTS`: Heights the gifs are shown at, in turn. Even, so the chroma of the yuv420 frame lines up.

`const BACKDROP_ROWS`, `const BACKDROP_TEXT`, `fn backdrop`: The words "this is 240p", five to a row, twelve rows 20px apart, every other row shifted left half a word, in a dim grey on the dark frame. `drawtext` filters on the first frame only (`trim=end_frame=1` before them, `loop=loop=-1:size=1` after), so they run once at start, not per frame.

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
per stream. Small (426×240, 180 kbps, `-cpu-used 16`) and `FPS` (15) on purpose: the dummies share a small box with
real streams. ffmpeg runs under `nice -n 19` (nice execs it, so `kill` still reaches ffmpeg),
and the container has `cpu_shares: 128`.

The gifs are inputs of their own, read once (no `-stream_loop`), and `overlay` moves them:
its `x`/`y` are evaluated per frame with `t` the time. (`drawbox`, which the box used to be,
evaluates once, and its `t` is the thickness: it never moved.) Each gif goes through
`scale=-2:<HEIGHTS>,format=yuva420p,loop=loop=-1:size=GIF_FRAMES,setpts=N/FPS/TB`: decode,
scale and the pixel format conversion happen once per frame of the gif, and `loop` replays
the converted frames from memory forever, `setpts` giving them a steady clock again.
`GIF_FRAMES` is 20 s of `FPS` (300 frames). `loop` keeps only the frames the gif has (the bundled
ones are at most 92, a few MB a gif; a full 300 at 106 tall is about 15 MB).
Dockerfile.dummy cuts every gif to 20 s (`-t 20`) so none is longer than the cache. A longer
one would replay only its first 20 s. The image also shrank the gifs to the size and rate
they are shown at; the originals cost more to decode than the stream costs to encode.

Audio is libopus at `-compression_level 0` (the default is 10): a sine tone needs none of the
encoder's search. Measured with prod's static ffmpeg 7.1 and these exact args, 450 frames
(30 s of video) to `-f null`, one core: 0.98 s of cpu before, 0.70 s with the cached gifs,
0.45 s with the opus level too. On prod (2 vCPU e2-medium) four dummies took 52% of a core
before. What is left is mostly vp8 itself and the overlays; the tiled backdrop and the clock
cost nothing measurable.

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

`const MAX_MEDIA_LINES`: Audio, the camera, three screens, and the camera's VP8 copy when it is VP9 (`docs/vp9.md`). Each costs a transceiver per peer.

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
Opus and VP8 for every peer, and VP9 profile 0 on publish peers. A VP9 camera
also sends a VP8 copy, so a watcher that cannot decode VP9 gets VP8 (`docs/vp9.md`).

`pub fn media_setup`: `vp9`: also register VP9 profile 0 (publish peers). `twcc`: ask the remote side for transport-wide feedback. Only useful when the
remote is a browser uploading to us; it adapts its bitrate to that feedback. `resend`: a watcher's own nack answerer (`video/src/resend.rs`) in place of the stock one, so nacks for packets from before a layer switch go unanswered; `None` keeps the stock one. It also registers the mid and rid header extensions a simulcast offer needs.

`pub fn opus_voice_capability`: Opus for voice only: mono speech at a low bitrate, with DTX so silence costs
almost nothing. Never use it for the stream; music must not get DTX.

`pub fn voice_media_setup`: Like `media_setup`, but for voice: the voice Opus for the mics, and VP8 for the cameras and
screens shown in a voice channel, with TWCC so a browser sending one adapts its bitrate.

Keyframes are read by `parse_vp8` in `video/src/simulcast.rs` (`simulcast.md`): the first packet of partition 0 (S set, PID 0), past the payload descriptor, with the P bit of the VP8 frame tag clear. `parse_vp9` takes B set, P clear, spatial id 0 (`vp9.md`). Anything short or malformed is not a keyframe.

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

## `video/src/voice.rs`

`video voice`: a small voice sfu, same binary. who may talk where is the api's word: a page
brings a grant from `POST /api/groups/:group/voice/:channel/join`, and we redeem it once with
the api (`POST /api/voice/redeem`, X-Voice-Secret) for the person and the room. the room and
the name come from that reply, never from the page.

websocket on :7881/ws (VOICE_WS_PORT), media on one udp port, 7883 (VOICE_UDP_PORT).
`GET /health` on the same port says {ok, rooms, peers}. the first frame, within 10s:
  {"role":"voice","grant":"<64 hex>","sdp":"<offer>"}
the offer's audio: m-line 0 is your mic and must send, the other audio ones (15 at most)
are recvonly and are where you hear the others. it may have video m-lines too (see video,
below). we answer {"sdp":"<answer>"} or {"error":"..."}, then send
  {"event":"seats","seats":[{"seat":0,"user":"a","line":1,"mute":false,"deaf":false,"video":[]},...]}
right after the answer and on every join and leave. a grant the api turns down (used,
older than 30s, no longer yours to use) is "bad grant"; an api that does not answer within
1.5s is "api unreachable".

env: API_URL (http://api:4000) and VOICE_SECRET, the api's own. with VOICE_SECRET unset or
empty no grant can be redeemed, and every join is "voice is not open". VOICE_DEV_OPEN=1 is
for the spike (test/voice-spike.js): it also takes the old frame,
  {"role":"voice","room":"<server>/<channel>","user":"<name>","sdp":"<offer>"}
from anyone, and those joins are never told to the api.

a room has 16 seats and each person takes the lowest free one. your own seat is not
in the list and has no m-line: seat N is heard on m-line N+1 if N is below your seat
and on m-line N if it is above (`line` says which, so a page need not work it out).
joins and leaves only swap the track behind those m-lines (replace_track), so nobody
renegotiates. an empty seat's m-line gets an idle track nobody writes to: webrtc-rs
cannot put a track back on a sender once it was replaced with none.

video: a seat shows at most a camera and a screen, two tracks of its own (`camera<id>` and
`screen<id>`, stream `seat<id>`), VP8 only. the page is always the one that offers, so
there is no glare: after the answer it may send a new offer at any time,
  {"sdp":"<offer>","video":{"<mid>":"camera","<mid>":"screen"}}
(the join frame may carry `video` too), and gets {"sdp":"<answer>"} back. `video` names the
page's own sending video m-lines; a sending one it does not name is "bad offer", and the audio
m-lines must stay as they were. what sends is what shows: a camera line that goes inactive is
the camera off. the page's recvonly video m-lines are where it sees the others, at most 30:
each seat's `video` in the seats frame lists what it shows, `[{"kind":"camera","mid":"17"}]`,
the mid that carries it, or null while the page has no free video m-line for it (it adds
one and offers again). like the audio, a line only swaps tracks; a line given a new picture
asks its sender for a keyframe (a PLI), and a viewer's own PLI or FIR is passed on the same
way, at most one per KEYFRAME_GAP per track. the page also says
  {"state":{"mute":true,"deaf":false}}
for the others' tiles, the seats frame's `mute` and `deaf`. those are the page's own word:
they carry nothing about what is sent.

`const MAX_SDP_BYTES`: sixteen audio and 32 video m-lines, VP8 alone on the video ones

`const MAX_VIDEO_LINES`: a camera and a screen sending, and the others' 15 of each to see

`const KEYFRAME_GAP`: keyframe requests to one track's sender, at most one per this

`const API_TIMEOUT`: how long any one call to the api may take, as the stream's (main.rs)

`const BEAT_EVERY`: how often everyone seated is told to the api, a third of its sweep's 45s

`const PING_EVERY`: a ping on the socket this often (30s; the api's chat and events ping at 20s and cut at 45s, api/src/socket.rs): a call's
socket can say nothing for an hour, and a nat or a proxy between forgets an idle connection.
one that sent nothing back (pong, text, anything) for IDLE_LIMIT is gone

`const SEND_TIMEOUT`: a frame that cannot be written in this long is a page that stopped reading: the call ends
rather than wait in the write, deaf to the kick and the peer's end, for as long as tcp keeps it

`struct Api`: the api's internal voice routes. no Debug, so the secret cannot end up in a log line.

`struct Redeemed`: what a redeemed grant stands for, the api's reply

`struct Presence`: a granted person, as the api knows them: what `attached` and `left` say

`type Snapshot`: who sits where, as every peer of the room sees it

`enum Kind`: a camera or a screen

`struct Show`: what a seat shows. the tracks and their keyframe bells are the seat's for its whole stay;
`on` says which of them its page is sending now

`fn same`: whether two strings are the same, in a time that says nothing about where they differ (the
length aside): every byte is looked at, with no early way out

`fn inside`: the gate on `/internal/voice`, the api's voice.rs `inside`: 404 for anything caddy passed (it
always sets X-Forwarded-For), 503 with no secret, 403 for a wrong or missing X-Voice-Secret

`struct Seats`: the seats of a room. each comer takes the lowest free one.

`fn line_of`: the m-line that carries `seat` to the person in `own`: theirs is skipped, and
m-line 0 is their mic

`struct Join`: the first frame as it comes. `room` and `user` are the dev-open frame's.

`enum Claim`: who a join says it is: a grant to redeem, or (dev-open only) a room and a name

`fn read_join`: the first frame read, with `open` (VOICE_DEV_OPEN=1) and `granting` (a secret to redeem
with). a grant wins over a room and name in the same frame. Err is the word for the page.

`fn valid_grant`: the shape of what join hands out: 32 bytes as hex. anything else is not worth a call.

`fn read_labels`: the `video` the join frame and every later offer may carry: the page's sending video m-lines
by mid, each `camera` or `screen`

`fn sending_kinds`: which kind each sending video section is, from the page's labels: every one named, each
kind at most once. None is a bad offer.

`struct Said`: what the page says after the join: a new offer, or its own mute and deafen

`struct Shown`: one picture a seat shows, and the mid that carries it to this page (None: no line free yet)

`async fn moderate`: `POST /internal/voice {action, user_id, server}`: a moderator's word, from the api (the
module's head). → {"seats": n}; 400 for a body that does not read.

`struct Held`: a seat and an address slot, given back on drop however the socket ends

`enum Media`: what an m= section carries

`struct Section`: one m= section of an offer, as far as voice cares

`fn check_offer`: the offer's sections if voice can take it: at most 128 KB, every section with a mid, the
first one a sending audio one, 1 to 16 audio and at most 32 video, two of those sending at
most, and nothing else (no data channel)

`fn same_audio`: whether a later offer keeps the audio m-lines of the first, mid for mid

`struct Line`: what one m-line that hears a seat is bound to

`struct Joined`: the room a join sat in, and the `video` of its frame

`fn on_of`: which of the camera and the screen a page sends, from its sending video mids

`async fn renegotiate`: a later offer from the page: checked against the first, its new video lines readied, and
answered. → the answer and the page's sending video mids; Err is the word for the page

`struct Shower`: a page's camera and screen coming in, onto the seat's own tracks of those kinds

`struct Screen`: one m-line that shows this page a camera or a screen

`struct Video`: the m-lines a page sees the others' video on

`async fn add_line`: a sendonly line with `idle` on it, its sequence numbers the sender's own. a line carries one
sitter's packets, then another's (replace_track), on one ssrc, and each comer's browser starts
its numbers anywhere: one that starts behind the last is a replay to the viewer's srtp, every
packet dropped until it catches up (minutes). the transformer goes on from the last number at
each replace_track, and must be on before the line sends anything

`async fn rebind`: point every m-line at the mic of whoever sits in its seat now, or at its idle track

`fn seats_event`: the seats frame for the page in `own`: everyone else, with what each shows and on which mid

`fn gone_word`: the word for a page whose peer failed: `linked`, it had connected once

`async fn voice_peer`: the stream's ice settings (main.rs new_peer) with the voice codecs. `linked` is set once
the peer connects, `dead` told when it fails or closes

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
- the gifs that bounce around the fake streams (random-media/gifs), shrunk once here to the size and rate they are shown at: 128 tall (shown at 80 to 106), 15 fps, at most 20 s (`-t 20`, the most `GIF_FRAMES` in dummy.rs caches), a palette of their own. the originals are up to 640px at 50 fps, and decoding three of those per stream cost more than encoding the stream. only the small ones go into the image (3 MB, not 24). (at `FROM debian:bookworm-slim AS gifs`)
- a font for the name on the picture. ffmpeg itself is a static build, no libs needed. (at `RUN apt-get update \`)
- the commit this was built from, same as the video image. compose passes it; unused here, but docker warns about a build arg nobody declares. (at `ARG BUILD=dev`)
