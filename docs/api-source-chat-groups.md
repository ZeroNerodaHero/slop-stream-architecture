# api/ source: chat, groups, profiles, media, voice, boot

the header comment of each file below and the doc comment of each top-level item, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a piece was written for at the time of the move, so check a detail against the code before trusting it. the other modules are in `api-source-core.md` and `api-source-realtime.md`.

## `api/src/about_page.rs`

The about tab's page (docs/about.md): a json document of blocks, each `type` plus where it
sits (`x`, `y`, `z`) and how big it is (`w`, `h`). The bytes are in the bucket, not in the row. A picture, a clip or a
track goes up on its own (`PUT .../about-file`) and the document names it by id. The text
is html, cleaned here and cut at 10 000 characters, and that cleaned string is the object
the document's text block points at. The row keeps only the layout.

`const W_MIN`: The smallest a block can be dragged, and the largest. A missing size takes the kind's usual box.

`const MAX_IMAGE`: A picture, the same ceiling as a scene picture.

`const MAX_VIDEO`: A short clip on the page, not a stream.

`const MAX_PAGE`: The document: forty texts at the cap, plus the layout.

`struct Paint`: How a block is painted. Fonts are css families already on the machine: nothing is fetched.
A color is `#rrggbb` or it is dropped. A shape (`line`, `box`, `border`) has no file.

`pub`: The bucket key. The row's uuid, so a rename does not move the object.

`fn plan`: The layout as it will be kept. A text with id 0 is a new object. A picture, clip or track
must already be one of this name's files, and the same kind.

`fn clamp_size`: A missing size (an older page) takes the kind's usual box. A given size stays between the
smallest a block can be and `SIZE_MAX`.

`fn sanitize_html`: The text as it is kept: a fragment of the tags a line needs (`p`, `br`, `b`, `i`, `a`, a list,
a heading), nothing else. A `div` becomes a `p` (that is what a text box writes for a new
line). A link is http or https, or it is not a link. Script, style, and the rest are dropped
with what is inside them. Cut at `TEXT_MAX` characters of text. The string is what the bucket
stores, and what the page draws.

## `api/src/chat.rs`

`api chat`: the text chat next to a stream. See docs/chat.md.

One websocket per viewer at /chat/<stream name>. Messages live in a redis
stream per room (`chat:<name>`, last 500 kept). One task per room with
viewers tails that stream with XREAD BLOCK and pushes new lines to every
socket in the room; sending is just XADD, so everyone sees the same order.
`CHAT_PERSIST` also inserts each line into postgres (history.rs): the scroll
past this window, the search, and the jump to one line.
A group's channel is the same room with two names: `/chat/<server>/<channel>`.
Anyone may read it. Speaking takes a login that has joined the server. The room
page opens `/chat/<server>/*` instead: every channel of the server on one socket,
each line tagged with its channel, so switching channels opens nothing (`handle_server`).
A line in a channel is also a row in the other members' inboxes (notify.rs
`channel_line`, docs/notifications.md), written from here on a task of its own.
The database is asked two things: is this socket really the streamer, and
who does its login cookie say it is (auth.rs). A login names you; without
one you pick a nick, as long as nobody owns that name. A login's groups
(groups.rs) ride on its lines as badges; a hello that says `bot: true` wears
the `bot` badge, whoever it is, so the panel can hide those lines. The picture
of a login, or of the streamer, rides along too (`avatar`, its upload time),
so the panel can draw a face by each line: the picture the row has *now*, read
at the say and again whenever lines come back out of redis (`with_faces`), the
way history.rs joins it for a line from postgres. A login's line carries its
account (`uid`), so the face follows a rename the way the badges do not.

`pub`: A line's length, in unicode scalars. A direct message (dms.rs) has the same.

`const ANON_TIER`: The token bucket a line is paid from (`Limiter`), by who is speaking. Without an account:
two lines at once, then one every thirty seconds. A login, or the one who went live (the
grant is as good as a name in their own room): three at once, then one every 3⅓ seconds.
The pages hold the same two numbers (chat-atoms.ts `TIERS`) and refuse a line over them
before it is sent; the bucket itself is here, and the chat has the last word.

`const REACT_TIER`: A reaction's bucket (docs/chat.md "reactions"), apart from the lines': ten at once, then one a
second. A click on and off again is two. Only a login reacts, so there is one tier.

`const SWEEP_EVERY`: How often the buckets that have refilled are forgotten: a full bucket is the same as none.

`const SLOW_DOWN`: The words of a refused line. The frame carries the wait too (`slow`).

`const MAX_SOCKETS_PER_IP`: Sockets one ip may hold in one room. The count is per socket; this keeps "open
fifty tabs" from being fifty of it. (The rate is per speaker, so tabs share that.)

`const HISTORY_TIMEOUT`: The history is up to 200 lines in one frame: a slow link gets longer for that one.

`const EVERY_CHANNEL`: The channel of `/chat/<server>/<channel>` that means every channel of the server: one socket
for the whole room page (docs/groups.md). Not a name, so no channel can be called it.

`const FILL_LIMIT`: Lines sent after a `since` id, per channel. The page holds about this many per channel
to begin with (`GET /api/groups/:group/messages`); a gap wider than this is a page that
was away for a while, and older lines still scroll in through history.rs.

`pub`: Deserialize too: a pin keeps the line as this json (pins.rs), read back the same way.

`pub`: One login's emoji put on a line of the room, or taken off (docs/chat.md "reactions"): the
`react` frame everyone in the room gets, each page adding `who` to the line's `emoji` or
taking them off it. Through redis like a line (`react_key`), so every chat process's
sockets hear it.

`pub`: A video on a line (chat_videos.rs, docs/chat.md "videos"): its id and its poster's, a picture
of `POST /api/chat-images`. Kept as `<video>,<poster>`: `vid` in the stream, `video` on the
row (a room's and a direct message's), the way `image` keeps the pictures' ids.

`const REPLY_QUOTE_CHARS`: The words of a quote: the start of the line answered, enough for the one row the panel draws.

`pub`: The words for a reply whose line is not in this room (never said here, or long gone).

`pub`: What a reply answers (docs/chat.md "replies"): the line's id, who said it with their marks and
face, the start of its words and how many pictures it had, as it was when the reply was said.
Kept with the reply (`r` in the stream, `reply` on the row, json both), so the quote outlives the
room's stream trimming the line it points at; the panel finds the line itself by `id`.

`struct Hello`: The first frame: a nick for a viewer, the go-live grant for the streamer. Kept for the
socket's life, since a socket admitted with the database down is identified later.

`fn slow`: The frame for a line the bucket refused: `slow down`, and the wait rounded up to the ms.

`async fn ws`: The browser sends the login cookie with the websocket handshake; `handle` reads it from
the headers when it needs it. Not through the `Me` extractor: that turns a database
error into a 500 before the upgrade, and reading a room does not need the database (the
faces on its history are looked up there, and stay as written when it does not answer).

`async fn ws_channel`: `/chat/<server>/<channel>`. Same room as a stream, named `server/channel`. A missing
channel is said on the socket and the socket stops, so the panel does not reconnect.
`/chat/<server>/*` is every channel of the server on one socket (`handle_server`).

`fn refuse`: The room cannot be: said on the socket once it is open, and nothing more. The panel
reads these words as a reason not to reconnect.

`async fn server_of`: The server a `/chat/<server>/*` socket is for: a group that is there, and not `bot`.

`struct Who`: Who a socket speaks as, once the database has said.

`async fn identify`: The hello and the cookie against the database. Every question in here is about
speaking: whose line it would be and what marks it carries. Reading needs none of
them, so a database that does not answer is `Busy`, not a refusal: the socket gets the
room and its lines, and is asked again on its first `say` (docs/chat.md: a socket the
database cannot vouch for is a plain viewer). What would be a lie is refused outright:
a claimed name on an anonymous nick, a reserved one, a nick that is not one.

`async fn face_now`: The picture (and the oauth mark) of the name on the line, as it is now (its upload time, the `?v=`): the account's
for a login (by id, so a rename keeps it), the room's for its streamer, nobody's for a nick,
whoever's name it happens to be. Read at the say, not the hello, so a picture changed
mid-chat is on the next line. The database not answering, or not in 2 s (awaited on the
socket: bounded like `remember`'s insert), is a line with no face until it is read back
(`with_faces`): a say does not fail for a picture.

`type FaceRow`: The picture's version and the oauth mark, as `face_now` reads them.

`type FacesRow`: A row `with_faces` reads: id, name, the picture's version, the names held for it, the oauth mark.

`struct Face`: What a line wears of its speaker's row, as the row is now: the picture's version and the
oauth mark. The default: no picture, no mark (a nick, or the database not answering).

`enum FaceKey`: Whose picture a line wears: the account's for a login (`uid`, which every login's line in
every stream has: the chat writes it on every line), the
name's for the room's streamer, nobody's for a nick.

`pub`: The faces on lines read back out of redis, as they are now. A line keeps who said it, not
what they looked like: the picture is the row's today, the way history.rs joins `streamers`
for a line from postgres, so a new picture shows on every old line and a rename keeps a
login's for the hold's length; after it, the letter: the name leads elsewhere, and the page
fetches the picture by it. One query for the batch, none for a batch of nicks. A row that is
gone is no face, as the join would have it. The database not answering, or not in 2 s (the
history frame and a `since` fill await this on the socket), leaves what each line was written
with: faces a little behind, and the history still comes with the database down.

`struct Tier`: A token bucket's size and pace: `burst` lines at once, refilling at `burst` per `window`,
one token every `window / burst`. Not a sliding window: three said at once are three gone,
and the next goes when one token is back, not when the oldest of the three is a window old.

`struct Bucket`: One bucket: the tokens in it as of `at`. Refilled by the time passed whenever it is read.

`enum Speaker`: Whose bucket a line is paid from. The speaker, not the socket: another tab, or a reconnect,
draws on the same one, so neither is a fresh burst.

`struct Limiter`: The buckets, one per speaker per room, shared by every socket in the process. A token is paid
before the database or redis is asked anything about the line: a `say` the database cannot
vouch for yet costs like any other dropped line, so a socket admitted read-only cannot turn
every frame into a query, and a refused line costs nothing but this lock. Nothing awaits under
it, so it is std's. A bucket that has refilled is the same as none, so those are forgotten
once a minute (`SWEEP_EVERY`): the map is the speakers of the last minute or so.

`fn parse_say`: A `say` as it came: the words cleaned, the pictures' and the video's ids checked for shape.
`Ok(None)` is an empty line, dropped without a word. `Err` is what the socket hears. Nothing
here asks redis or the database, so it costs no token.

`pub`: The video a say named, read as a uuid; none for an empty one. dms.rs reads a line's the same way.

`async fn video_of`: The video `id` the api kept, with its poster, uploaded by `who` (media.rs `check`): `no such
video` or `not your video` otherwise.

`pub`: The words for a picture or a video somebody else uploaded: only its uploader may post it.

`const STREAM_CHAT_VIDEO`: Videos on a stream's chat (docs/chat.md "videos"): off until a stream's chat has moderation.
A group channel's and a direct message's (dms.rs) take them as ever. `true` turns them back
on; the pages hold the same flag (ChatAttach.tsx `STREAM_CHAT_VIDEO`).

`const NO_STREAM_VIDEO`: The words for a video on a stream's line while `STREAM_CHAT_VIDEO` is off.

`fn stream_video_refusal`: A line naming a video in a stream's room (no `server`) while they are off there (`on`).

`pub`: The line's pictures, video and poster are posted `place` now (media.rs `mark_posted`): the
first line to name each says who may see it.

`enum Refused`: Why a line was not taken: the words alone (`error`), or words with how long until one would
be, in ms, the `slow down` frame's shape, which the panel counts down on the send button.

`const TIMED_OUT`: The words for a login timed out of a server (docs/groups.md), with the ms until it ends.

`const COOLDOWN`: The words for a login whose role has a cooldown, with the ms until the next line may go.

`const CHANNEL_COOLDOWN`: The words for a channel with a cooldown, with the ms until this login's next line in it may go.

`type Standing`: A member's standing in a server, for one line: whether they own it, whether they hold the
channels power, the ms left on a timeout that is running, the longest cooldown of their
roles and the channel's own, in seconds (0: none). None: not a member.

`async fn accept`: An identified socket's line into `room`: in a server's channel only a member may speak, one
who is not timed out (`timeouts`, the kick power's), and whose cooldowns have passed: their
roles' (the longest; a key in redis, `cd:<server>:<account>`, alive the cooldown long since
their last line in the server) and the channel's own (`cdc:<room>:<account>`, since their
last line in the channel); the line waits for whichever is longer. An owner and a site
admin wait for nobody; the channels power, which sets a channel's cooldown, is not held by
one, but waits on its roles' like anyone. The pictures must be ones the api kept;
then the line and the room's ttl in one atomic round trip (a room whose first line landed
but whose expire did not would otherwise live forever), and the row for history on its own
task. A reply's line must be in the same room (`reply_to`). `Err` is what the socket hears,
and the line is not kept.

`const BANNED`: The words for a login banned from a stream's chat (janny.rs). No `nick` or `account` in them:
the pages read those as a dead login and hang up (auth.rs `NICK_HAS_ACCOUNT`).

`async fn stream_refusal`: A stream's chat bans and timeouts (janny.rs), for a login's line or reaction in `room`: None
when they may speak. The streamer's socket and a nick are never asked (a ban is an account's).
The database not answering is `chat is busy`, so a ban is never skipped.

`pub`: A line out of a room for good (a stream's: janny.rs `delete_line`; a channel's: group_mod.rs
`delete_message`): out of redis and postgres,
its reactions with it (its pictures stay in the bucket), and a `del` into the room's reactions
stream, which every chat process's reader turns into a `delete` frame for its sockets.

`async fn reply_to`: The line a reply answers, by its id, from this room only: redis while the stream has it, else
the kept rows (history.rs `line_at`). Another room's id, a junk one, or a line long gone with
nothing kept is `no such line`; a quote of a quote is the line alone, not its own quote.

`async fn on_react`: A `react` frame, whole (docs/chat.md "reactions"): the id and the emoji checked for shape first,
at no cost; then a token from the reactions' bucket (`REACT_TIER`, keyed by `at`, the socket's
room as a line's is) before anything is asked; a socket admitted with the database down is
asked who it is now; then `react`. `Err` is the refusal's words, with the wait for `slow down`.

`async fn react`: A login's `emoji` on the line `id` of `room`, or off it. Only a login reacts (the row is an
account); in a server's channel only a member who is not timed out, as only one speaks. The
line must be the room's to put one on (`history::line_at`, the reply's check: redis, then the
kept rows), never to take one off. A change goes into the room's reactions stream, and every
reader of the room fans it out; one that was so already says nothing. `Err` is what the socket hears.

`const NOTIFY_LIMIT`: The inbox rows for a channel's line are written within this long, or not at all.

`fn notify_members`: The inbox rows for a line in a server's channel (notify.rs `channel_line`), once redis has it:
one unread row a channel for every other member who keeps the kind and has not muted the
channel, and the fact that pushes them. Its own task, bounded like `remember`'s insert: a
database that is slow or away costs the members a row, never the room its line.

`type Tagged`: What one of a server socket's channels says, tagged with the channel, into the socket's one
queue. `Err(n)` is a room that ran ahead of this socket by n events.

`async fn follow`: A server socket follows one more channel: its room joined (counted, capped per ip like
any socket) and a task forwarding its events, tagged, into the socket's queue. The task
ends with the socket (the queue's receiver dropped) or with the room. False at the cap.

`fn is_stream_id`: `digits-digits`, a redis stream id, so a `since` the page sends cannot be anything else.

`async fn after`: The lines of a channel after `id`, oldest first, FILL_LIMIT at most: what the page missed
between the api's answer and this socket, or across a drop. Taken after the room is joined,
so a line in both arrives twice and is dropped by id, never in neither.

`async fn handle_server`: `/chat/<server>/*`: every channel of a server on one socket (docs/groups.md). The room page
opens this one and switches channels on screen, with no other socket and no history frame:
it drew every channel from `GET /api/groups/:group/messages`, and says in `since` the newest
id it has per channel, so the lines after each are sent and nothing falls between the api's
answer and this socket (or across a drop, on the reconnect). Lines go out as `message` with
`channel`, the count as `count` with `channel`; a `say` names its `channel`; `join` follows a
channel added since. Nobody is the streamer of a server, so the hello's grant means nothing here.

`fn remember`: The row for a line redis already accepted. Its own task: the socket goes back to the room.

`async fn last_id`: The newest id in a room's stream, "0-0" for an empty room, None when redis does not answer.

`async fn reader`: Tails one room's stream and fans every new line out to the room's sockets, and its reactions'
stream (`react_key`) in the same XREAD, every reaction to them too.
Own connection: XREAD BLOCK would stall the shared multiplexed one, and the
default 500ms response timeout would cut every block short.

`fn viewer_of`: The account a socket's lines go to, for their reactions' `me`: a login's, none for a nick.

`async fn history`: The last lines of a room, oldest first, with the faces and the reactions as they are now.

`const MAX_IMAGES`: Ten pictures on one line. The bytes stay in the bucket; the line names the ids. A direct
message (dms.rs) keeps the same cap, through `picture_ids`.

`pub`: The ids a say named. `images` when it sent the set, otherwise the one `image`. Each must
read as a uuid; a repeat is one picture. dms.rs reads a line's pictures with the same rule.

`async fn pictures_exist`: Every picture is one the api kept, uploaded by `who` (media.rs `check`).

`pub`: Ids in a stored field: one id, or several joined by commas.

`fn react_key`: The room's reactions as they happen (`React`): `l` the line, `e` the emoji, `w` who, `on` 1 or 0.
Not the lines' stream, which is the room's last 500 lines and nothing else. A janny's delete
rides here too, `del` the line's id (`remove_line`), so the readers tail no third stream.

`const KEEP_REACTS`: Reactions a room's stream keeps: enough for a reader that fell a little behind, never history.

`const MAX_COMBINING`: A run of combining marks longer than this is "zalgo", not spelling.

`pub`: Trim; keep newlines, but at most two between visible characters; drop control
characters and the invisible format ones (zero-width space, bidi marks and
overrides, word joiner, byte order mark); cap a run of combining marks.
No unicode tables in this binary, so the sets are the explicit code points
that make a line lie about its direction, pad it invisibly, or climb the screen.
groups.rs cleans a badge and a group's description the same way.

`fn is_invisible`: Soft hyphen, zero-width space, the bidi marks (200E 200F), bidi embeddings and
overrides (202A-202E), word joiner and invisible operators (2060-2064), bidi
isolates (2066-2069), byte order mark. Not the zero-width (non-)joiner: emoji
sequences and several scripts spell with those.

`fn is_combining`: The combining diacritical mark blocks.

## `api/src/chat_images.rs`

A picture on a chat line. The page shrinks it first and posts the bytes here;
the say names the id, and the panel fetches it back. See docs/chat.md.

Webp, or jpeg when the browser cannot write webp. Profile pictures, group
pictures, thumbnails and the offline picture stay jpeg and do not come through here.

Who may post one and who is served one is media.rs's: a stream's are public, a group
channel's and a direct message's are for those who may read them.

`const MAX_BYTES`: About five lines, drawn at two pixels per screen pixel, is still a small file.

`const RATE_PER_WINDOW`: Pictures per login per ten minutes. A chat, not a gallery.

`pub`: A chat picture kept: the row (postgres makes the id, the same as every other id, with the
bytes' sha256 and the uploader's address), then the bytes; a failed save deletes the row.
The upload's way in, and a chat video's poster's (chat_videos.rs), which the api drew itself.

`async fn take_down`: `DELETE /api/chat-images/:id`: a site admin's takedown. The bytes out of the bucket, the row
gone (a video it was the poster of keeps no poster), and the lines naming it say "removed".
204; 401 nobody, 403 anyone else, 404 no such picture.

`pub`: The picture `id` out of the bucket, then its row; a failed delete in the bucket keeps the row,
so the takedown can be tried again. chat_videos.rs takes a video's poster down this way too.
A stream's (the only public ones) is purged from Cloudflare after (cf_purge.rs).

`pub`: A picture of the api's own that is not wanted after all (a video's poster whose video was not
saved): out of the bucket and its row gone, no note kept.

`pub`: The site admins (`ADMIN_NAMES`), the same check as emotes.rs's and janny.rs's.

`fn kind`: Webp (`RIFF….WEBP`) or jpeg (`FF D8 FF`). Anything else is refused: the page is meant to send one of these.

## `api/src/chat_videos.rs`

A short video on a chat line, the pictures' way (chat_images.rs): the page posts the file
here, the say names the id, and the panel plays it back from the bucket. See docs/chat.md
"videos".

An mp4 of H.264 (with AAC, or no sound) or a webm of VP8 or VP9 (with Opus, or no sound),
10 mb and 30 seconds at most. The magic bytes say which container, and a walk of its header
(`probe`) refuses the wrong codecs before anything is run. Then ffprobe reads the file itself
(`prepare`): its streams' codecs again, and how long it really is, the container's word or its
packets' last timestamp, whichever is longer. One it cannot tell the length of is refused, as
is one over 30 seconds; the page's own reading is not asked for.

What the bucket keeps is ffmpeg's copy, not the upload: the first video and sound stream
remuxed as they are (`-c copy`), every other stream, the metadata and the chapters left out,
an mp4's index at the front (`+faststart`). Only when that copy fails is it encoded again, an
H.264/AAC mp4 at modest settings. The poster is a frame ffmpeg draws from that copy (a second
in, or the first), kept as a chat picture of the uploader's. ffmpeg and ffprobe run on a
blocking thread, two jobs at most at once, each with a timeout and, on linux, limits on its
memory, cpu time and file size, reading only local files (`-protocol_whitelist file`) with the
demuxer named, never guessed.

Who is served one is media.rs's: a stream's are public, a group channel's and a direct
message's are for those who may read them. A site admin may take one down (`take_down`).

`const MAX_BYTES`: A phone's half minute at a sensible bitrate. The bucket is on the box, and its disk is small.

`const MAX_MS`: Half a minute, and half a second over for a container's rounding (a 30s recording reads 30.02).

`const RATE_PER_WINDOW`: Videos per login per ten minutes, on top of ratelimit.rs's `VIDEO_UPLOAD`. Stricter than the
pictures' 30: each is up to forty times the bytes.

`static JOBS`: ffmpeg jobs at once, across every upload: the box has few cores and a stream to serve.

`pub`: The poster of the video `id`, when the api kept one by that id and it still has its poster.
The say checks this before it keeps a line that names a video, and puts both ids on the line.

`async fn upload`: `POST /api/chat-videos`, the file as the body: 200 `{ id, poster, duration_ms }`, the poster
a chat picture the api drew. 401 for nobody; 413 `video too big`; 400 `not an mp4 or webm`,
the codecs' words, `video too long` or `could not tell how long that video is`; 429 past five
in ten minutes. A query (an older page's `?poster=` and `?duration=`) is not read.

`async fn show`: `GET /api/chat-videos/:id`: the file, or the part of it a `Range` asks for (206, one range;
several are answered with the whole, which the spec allows), so a player can seek, and
Safari, which will not play a video it cannot ask for in parts, plays it at all. To whoever
may see it (media.rs `access`): 401/403 for anyone else, 410 `removed` after a takedown.

`async fn take_down`: `DELETE /api/chat-videos/:id`: a site admin's takedown. The file out of the bucket, the row
gone, its poster taken down with it, and the lines naming it say "removed". 204; 401 nobody,
403 anyone else, 404 no such video.

`fn range_of`: The one range a `Range: bytes=…` header asks of a file `len` long, as `start..=end`.
`Ok(None)`: the whole file (no header, one this does not read, or several ranges).
`Err`: a range wholly past the end, the 416.

`struct Ready`: What `prepare` made of an upload: the file to keep, its type, its real length and a poster.

`const MAX_PROBE_OUTPUT`: ffprobe's packet list, at most: a 30 second clip's is a few hundred kb.

`const MAX_POSTER_BYTES`: A chat picture's ceiling (chat_images.rs): the poster is one.

`fn bin`: ffmpeg's and ffprobe's paths: `FFMPEG`/`FFPROBE` when set, otherwise found on the PATH.

`struct Scratch`: A directory of one upload's files, gone when this is.

`fn prepare`: The upload made ready to keep, on a blocking thread: probed, its length checked, remuxed
(or, when that fails, encoded again), and a poster drawn.

`fn length_of`: The length to go by: the longer of the container's word and the packets' last timestamp, so
neither a header that lies short nor one that says nothing lets a long file by.

`fn probe_streams`: ffprobe's word on the streams and the container's length.

`fn packets_end_ms`: The end of the last packet of any stream, in ms: `pts + duration`, read off every packet.

`fn last_packet_ms`: The packets' list as ffprobe writes it, `pts,duration[,…]` a line, `N/A` for one not known.

`fn check_codecs`: The container's codecs, by ffprobe this time: every video stream H.264 (mp4) or VP8/VP9
(webm), every sound stream AAC or Opus, and at least one video stream. Other streams (an
iPhone's metadata track, subtitles) are left out of the copy, so they do not matter here.

`fn remux`: The first video and sound stream copied as they are into a fresh file of the same container:
no other stream, no metadata (the file's or a stream's), no chapters, no encoder's name, and
an mp4's index at the front so it plays before it has all come.

`fn encode`: The copy's fallback: an H.264/AAC mp4, 1280 on its long side at most, a fast preset at a
modest quality on two threads, cut at the 30 seconds.

`fn poster`: A frame of the kept file as a jpeg, 640 on its long side at most: a second in, or the first
frame for a clip shorter than that.

`fn ffmpeg_reading`: ffmpeg, reading `input` as `demuxer` and nothing but the local file, writing over its output.

`fn strip`: No metadata out: the file's, each stream's, the chapters', and no encoder's name.

`fn refused_or_broken`: A file ffmpeg would not read is the file's fault; anything else is ours.

`fn run`: One run of ffmpeg or ffprobe: stdin closed, stdout to `stdout` (or nowhere), stderr kept to
say why, killed past `timeout`. On linux, at a lower priority and with limits on its memory,
cpu seconds and the size of a file it writes, so one bad file cannot take the box.

`struct Probe`: What the header says about a file: its type and, when written there, its length.

`fn probe`: The container by its magic bytes (`ftyp` at 4, or the EBML mark), then its header walked for
the codecs and the length. Anything else is refused.

`fn boxes`: The boxes laid end to end in `b`: their four letters and their insides. A box that runs past
the end is cut there and ends the walk (a file is whole here, so that is a broken one).

`fn probe_mp4`: `moov/mvhd` for the length, and each `trak`'s handler and first sample entry for the codecs:
every video track `avc1`/`avc3`, every sound track `mp4a`, and at least one video track.

`fn vint`: An EBML variable-length number at the start of `b`: its value and how many bytes it took.
An id keeps its length mark (`0x1A45DFA3`); a size drops it, and all ones is `None`, unknown.

`fn elements`: The elements laid end to end in `b`: id and insides. One of unknown size (a recorder's
`Segment` and `Cluster`) runs to the end of `b`, and ends the walk after it.

`fn probe_webm`: The header's doc type must be `webm`. `Segment/Info` says the length (in its timecode scale,
a millionth of a second unless said), `Segment/Tracks` the codecs: every video track
`V_VP8`/`V_VP9`, every sound track `A_OPUS`, and at least one video track. The walk stops at
the first `Cluster`: the header is before the frames.

## `api/src/dms.rs`

Direct messages: a login writes a line to a friend (someone it follows who follows it
back), and every device of either sees it at once. See docs/dms.md.

One table of lines, `dms (from_id, to_id, text, image, sent_at)`, both ids (docs/ids.md): a
renamed name keeps its threads, and a line is shown under whatever name its writer has
now. A thread is the pair, whichever way round. The api is the one writer: a line is a
row, then a `dm` fact on the `events` stream, and the gateway (events.rs) pushes it to
the sockets of both names, the way `live` reaches a stream's watchers. Reading is http, a
page at a time. `dm_reads` says how far into each thread a login has read, so the count
of what is new holds across reloads and devices; a read on one device clears the others
through a `dm_read` fact.

A line may carry pictures, the room chat's way (chat_images.rs): the page shrinks each and
`POST /api/chat-images` keeps it, the line names the ids (`images`, ten at most), and the
row keeps them joined by commas in `image`, as a chat line does. The words may be empty
when there is a picture. A video goes the same way (chat_videos.rs): `video` names the id
`POST /api/chat-videos` handed back, and the row keeps it with its poster in `video`
(`<video>,<poster>`, chat.rs `Video`), the line answering `video: { id, poster }`.

A thread is searched the room chat's way too (`GET /api/dm/:name/search?q=`, history.rs
`read_search`: the words, a quoted phrase, and the filters among them), over its own rows
alone: the pair bounds a thread to a few thousand lines at most, so the words are matched
as `to_tsvector` over the text and a link is the rooms' regex over it, with no column or
index of their own.

`const PAGE`: Lines in one page of a thread. A shorter page is the start of the thread.

`const SEARCH_LIMIT`: Hits a search of a thread answers, newest first: the room search's number (history.rs).

`const THREADS`: Threads `GET /api/dms` lists, the newest first. More than a column of faces shows.

`const RATE_PER_MINUTE`: Lines per login per minute: a conversation, even a quick one, not a flood.

`const NOT_FRIENDS`: The one refusal of a line: the pages show it under the box as it is.

`async fn peer`: The account behind a name in the path: a held name answers for the account that left it
(docs/ids.md), a free name is nobody's and cannot be written to. 403 in the friends' words
either way: a name with no account is never a friend.

`type LineRow`: id, from (the name now), text, sent at (ms), the pictures' ids joined by commas (null for none),
then what it answers (`reply_to`) and that line as `QuoteRow` has it (nulls for one not there),
then its reactions (json, reactions.rs `Reaction`s, `[]` for none), then its video and the quoted
line's (`<video>,<poster>`, null for none)

`const LINE_SELECT`: A thread's line as every read of it selects it (`LineRow`), the line it answers joined: of the
same pair, so a reply never shows another thread's words. Its reactions with it, by the name
each reactor has now (reactions.rs).

`type QuoteRow`: The line a reply answers, as a quote: id, who wrote it (the name now), the start of its words
(120 characters, the room chat's `Reply`), their picture's version, its pictures' ids, its video.

`fn quote_json`: A quote as the pages read it, the room chat's `Reply` shape: `images` is how many pictures,
`video` there when it had one.

`async fn quote`: The line `id` of the thread between `a` and `b`, as a quote. None for a line of another
thread, or none at all: a reply answers its own thread only.

`async fn pictures_exist`: Every id a line names is a picture `POST /api/chat-images` kept for the writer (the say's
check, chat.rs `pictures_exist`): 400 `no such picture` or `not your picture` otherwise.

`async fn thread`: `GET /api/dm/:name[?before=<id>]`: one page of the thread with `name`, oldest first, the
newest page without `before`, the page before a line with it. A line is `id`, `from`,
`text`, `at` and `images` (the pictures' ids, empty for none). `friends` says whether a
line may be sent now; the thread reads either way, so an old conversation is not lost
with the follow.

`async fn search`: `GET /api/dm/:name/search?q=`: the lines of the thread with `name` that match, newest first,
50 at most, `{ lines: [{ id, from, text, at, images }] }`, a line as the thread has it. The
box is the room chat's (history.rs `read_search`): the words, a quoted phrase, and the filters
among them, `from:<name>` (one of the two; anyone else finds nothing), `has:image`,
`has:link`, `has:video`, `before:<day>`, `after:<day>`. 400 `say what to look for` for an
empty box, `too long` past 200 characters, and a filter's own words when its value will not
read; 401 nobody; 400 `that is you` and 403 for a name with no account, as the thread is. A
thread reads whether or not the two are still friends, and so does its search.

`fn search_sql`: The query for a search of a thread: the pair ($1, $2), then one clause per thing asked, each
bound in the order returned, and the limit last. The thread index narrows the rows to the
pair first; the rest is read off each row (`to_tsvector` over the words, the rooms' link
regex, `history::LINK`, over the text for `has:link`, `VIDEO_LINK` for `has:video`), since
a thread is a few thousand lines at most and a column for each would cost more than it saves.

`async fn send`: `POST /api/dm/:name` with `{ text, images?, reply? }`: a line to a friend. 201 with the line as
it was kept (`id`, `from`, `text`, `at`, `images`, `reply`: the quote of the line it answers, or
null); the same line comes back through the events socket to every device of both, which is
how the writer's other tabs hear it. 400 `too long` past 500 characters, `nothing to say` for
nothing once cleaned and no picture, `bad picture`, `too many pictures` (ten is the cap) and
`no such picture` for ids the upload never handed out, `no such line` for a reply to a line not
in this thread; 403 in the friends' words for anyone who is not one; 429 past 60 a minute.

`const REACT_PER_MINUTE`: Reactions per login per minute, apart from the lines': a click on and off again is two.

`async fn react`: `PUT /api/dm/:name/react` with `{ id, emoji, on }`: the login's `emoji` on line `id` of the
thread with `name`, or off it (docs/dms.md "reactions"). 200 with the line's `reactions` as
they are now; a change also goes out as a `dm_react` frame to every device of both. Putting on
one already there, or taking off one that is not, is no change and no frame. 400 `not a
reaction` for an emoji off the list (reactions.rs `EMOJIS`), `no such line` for a line not in
this thread, `too many reactions` for a new emoji on a line with 20; 403 in the friends' words
for anyone who is not one, the way a line is; 429 past 120 a minute.

`async fn mark_read`: The reader has seen the thread with `peer` up to `id`. Never backwards: two devices
reading at once settle on the further one.

`async fn read`: `PUT /api/dm/:name/read` with `{ id }`: the login has seen the thread up to that line. 204.
A `dm_read` fact tells the login's other devices, so their count drops too.

`type ThreadRow`: peer id, name, verified, avatar, bio, status, last id, last from, last text, last at (ms), unread, last pictures (joined by commas), last video

`async fn list`: `GET /api/dms`: every thread the login is in, the one with the newest line first, with the
other side as the sidebar lists people (face, ✓, bio, how they are), their account `id`,
the last line, and how many of their lines are past what the login has read. 100 at most.
401 for nobody.

## `api/src/emotes.rs`

A group's custom emotes, discord's server emoji (docs/chat.md "emotes").

An emote is a picture under a name in one group (`group_emotes`, migration 0011): the name is
`[a-z0-9_]`, 2 to 32, once per group, and a group holds `MAX_PER_GROUP`. An owner manages
them, and a role with the emotes power (group_mod.rs `EMOTES`), as it does the rest of a group.
The upload is a png, jpeg or webp of `MAX_BYTES` at most; the api decodes it and draws it again
as a `SIDE`-square webp (`redraw`), so what the bucket holds is a picture this binary made, with
no metadata in it, and anything that does not decode is refused.

In a line's text an emote is the token `<:name:id>` (`tokens`). Using one is for a member of
its group, in a stream's chat, a group's channel and a direct message alike: the line is
settled when it is sent (`settle`), each token the sender may not use going back to plain
`:name:`. A line's length is counted with each token as its `:name:` (`shown_chars`), the
words the reader sees. A reaction may be an emote too, by its id (reactions.rs).

`pub`: Emotes in one group, at most.

`const MAX_BYTES`: The picture as it comes. The page crops and shrinks it first; this is the ceiling.

`const FORM_SLACK`: The multipart's own bytes around the picture and the name.

`pub`: The side of the square the api draws, in pixels: 1.375em at two pixels a screen pixel, and room for the jumbo size.

`const MAX_SOURCE_SIDE`: A source picture's side, at most: a small file can still claim a huge canvas.

`const RATE_PER_WINDOW`: Uploads per login per hour, on top of the upload tier (ratelimit.rs): an emote is a picture
the api decodes, so a little tighter than a chat picture's.

`const LOOKUP_MAX`: Ids in one `GET /api/emotes?ids=`.

`const NAME_MIN`: A name, in chars.

`pub`: A name as typed: trimmed and lowercased, then held to the rule. 400 in the rule's words.

`pub`: One `<:name:id>` in a line's text, where it stands (bytes, the `<` to past the `>`).

`pub`: The emote tokens in `text`, in order. Anything shaped otherwise is words, as typed: a name off
the rule, an id that is not a uuid, a `<:` never closed.

`pub`: A line's length as its reader sees it: each token is its `:name:`. The limits on a line
(chat.rs `MAX_TEXT_CHARS`) count this, so an emote costs what it shows.

`pub`: The longest a line may be with its tokens written out: every char of `MAX_TEXT_CHARS` could
be a two-letter emote's, `<:ab:` + 36 + `>` for `:ab:`. A chat frame holds this (socket.rs).

`pub`: `text` with each token rebuilt: `<:name:id>` with the emote's own name for one `user` may use
(a member of its group), plain `:name:` for any other (not a member, a deleted emote, a nick
with no account). The database not answering leaves every token plain: a line does not fail
for its emotes, and none goes through unchecked.

`async fn usable_of`: Of `ids`, the emotes `user` may use, with their names: those of a group they are in.

`pub`: Whether `user` may use emote `id`: it is there, and they are in its group.

`pub`: The upload decoded and drawn again: the middle square of it, `SIDE` on a side, as a lossless
webp. A png, jpeg or webp by its bytes (not by what the form says it is); anything else, or
one that does not decode, is `NOT_A_PICTURE`. What comes out has none of the source's metadata.

`async fn need_manager`: Owners, a role with the emotes power, and a site admin (group_mod.rs `allows`). 403 for anyone else.

`type EmoteRow`: id, name, uploader's name now (none for a gone account), unix seconds

`async fn list`: `GET /api/groups/:group/emotes`: the group's emotes, oldest first, for a member or a site
admin, with the cap and whether this login manages them. 403 `join the group first`.

`async fn upload`: `POST /api/groups/:group/emotes`, multipart: `name` and `image` (png, jpeg or webp, 512 kb).
A manager's. 201 with the emote. 400 for the name's rule or a non-picture, 409 for a name the
group has, 409 `FULL` at the cap, 413 past the size, 429 past `RATE_PER_WINDOW` an hour.

`async fn rename`: `PATCH /api/groups/:group/emotes/:id` `{name}`: a manager's rename. The lines already sent
keep their token's id, so they draw under the new name. 409 for a name the group has.

`async fn remove`: `DELETE /api/groups/:group/emotes/:id`: a manager's. 204. The lines that used it draw its
`:name:` from now on, and the reactions with it go (reactions.rs).

`pub`: A group on its way out: its emotes' pictures out of the bucket (the rows go with the group).

`async fn mine`: `GET /api/emotes/mine`: every emote of every group this login is in, by group then name: the
composer's `:` list and the reaction picker's sections. None for nobody.

`async fn lookup`: `GET /api/emotes?ids=a,b`: what the tokens in the lines on screen are, for anyone (a stream's
chat is read by everyone): name and group for each id still there. One missing is deleted,
and the page draws its token as plain `:name:`. `LOOKUP_MAX` ids at most; past that, ignored.

`async fn picture`: `GET /api/emotes/:id`: the picture, a webp, cacheable like a group's icon.

## `api/src/group_mod.rs`

An owner's powers, and the custom roles under them. See docs/groups.md.

The maker of a group is an owner. An owner can do everything, including name another owner.
Only an owner can do that. The picture and the banner are the owner's too: no role carries
them. A custom role is a name, a colour and a set of the powers below. It cannot grant
owner, it cannot touch an owner, and it reaches only the powers its holder has: whoever
makes, changes, deletes, gives or takes a role must hold every power on it. A role is
known by a uuid postgres made (schema.sql, docs/ids.md), so a rename is a save like any
other, and a page holds a role open while its name changes under it.

`pub`: Edit the about line, the colour, public or private, and the member order. Not the pictures: those are the owner's.

`pub`: Make, edit, delete and hand out custom roles. Not owner.

`pub`: Add a channel, rename one, and delete one that is not the home channel (`general`).

`pub`: Remove a member who is not an owner.

`pub`: The same, and they cannot join again until the ban is lifted.

`pub`: In a voice channel: server mute, deafen, disconnect, and move someone to another voice channel.

`pub`: Upload, rename and delete the group's custom emotes (emotes.rs).

`const MAX_BANNER`: The banner is 2560x640, the room's width on a sharp screen; a photo at that size needs the room.

`pub`: What this login may do here. An owner may do all of it. A site admin may do the listed
powers too, and still cannot name an owner: that check does not call this.

`struct Shaper`: Who is shaping a role, and what they hold. See `shaper`.

`async fn shaper`: The login shaping a role: an owner, a site admin, or the roles power. 403 for anyone else.

`fn not_an_owner`: A role cannot touch an owner: only an owner gives one a role, or takes one back.

`async fn role_perms`: A role's powers, by id, in this group. 404 `no such role`.

`async fn need_owner`: The picture and the banner are the owner's: no role carries them. A site admin may too,
as with everything here but naming an owner.

`fn target_name`: The member a body names (a role given, an owner named, kick, timeout, ban, a transfer): the
name rule, so a 400 `bad name` and not a lookup of whatever was sent.

`async fn owner_role_of`: What the group calls its owner role (docs/groups.md): `owner` until an owner renames it.

`async fn not_the_owner_role`: A custom role cannot be called what the owner role is: that word is the owners' on the roster.

`const MAX_COOLDOWN_SECS`: A role's cooldown is seconds, none to an hour.

`const MIN_TIMEOUT_SECS`: A timeout is seconds, ten to a week.

`fn member_order`: `name`, `newest`, or `oldest`. Owners stay first either way.

`pub`: `GET /api/groups/:group`: the whole room in one answer. The group, its roles, what the
login may do, its channels, who in it is live, who is in which voice channel, the roster (anyone's on a public group; a
member's or a site admin's on a private one), and (for the ban power) the bans. `roster`,
`holders` (who holds each role) and `bans` are null for someone who may not see them. `?roster=<n>` cuts the roster to its
first page, `roster_next` the cursor for `GET .../members?after=`. The page loads this once and then
follows the `group` facts on the events socket (docs/groups.md); nothing here is asked
again on a channel change.

`async fn voice_in`: Who is in voice: `{"<channel>": [{name, uid, since}]}` from `voice:<server>` (voice.rs),
each channel in order of who came first. Only the channels in `seen`, so a hidden channel's
people stay hidden with it. `{}` when redis cannot be asked: the room still opens, and the
`voice` and `voice_left` facts fill it in from there.

`fn seated_by_channel`: The fields of `voice:<server>` (user id to `{name, channel, since, ...}`) as the room's
`voice`. A field that does not read, or sits in a channel not in `seen`, is left out. Someone
in `muted` (a moderator's mute, voice.rs `server_mute`) says `muted: true`.

`async fn set_order`: `PUT /api/groups/:group/order` `{order}`: how the member list sorts after the owners. Appearance.

`async fn put_color`: `PUT /api/groups/:group/color` `{color}`: the group's colour, `#rrggbb` as the create form
takes it (`groups::clean_color`). Appearance, like the about line. The `color` fact repaints
the room, and the lists the page has, at once.

`fn role_json`: One role as the room, the list and the `role` fact say it. `channels` is the ones kept to it,
`cooldown` the seconds its holders wait between lines (0: none).

`async fn roles_of`: The group's roles, oldest first: the id is a uuid and says nothing about the order. Each
with the channels kept to it, by name, and its cooldown.

`async fn holders_of`: Who holds each role, by the name they have now: `{"<role id>": [name, …]}`, a role nobody
holds left out. The whole group's, not a roster page's, so a line's speaker past the pages
loaded so far still wears their role's colour in the chat (docs/groups.md).

`async fn kept_channels`: The channels a role's body names, cleaned, as the shaper may put them: each a channel of the
group the shaper sees (`groups::may_see`; a hidden one and a missing one are both `no such
channel`, so the roles power cannot unlock for itself what it cannot see), never the home
channel (`general` until renamed: everyone's), each once. Sorted, as `roles_of` lists them.

`async fn keep_channels`: The channels kept to a role, replaced by `channels` as far as the shaper sees: a channel kept
to the role that the shaper cannot see stays kept, since the body could not have named it.
→ the role's channels as they stand after. Within the caller's transaction.

`async fn update_role`: `PUT /api/groups/:group/roles/:id`: the role replaced whole, name included: a rename is
this, since the id is what the role is known by. The same reach as making it. `channels`
replaces the channels kept to the role, as far as the shaper sees them (`keep_channels`).

`fn changed_roles`: The roles in one list and not the other: the ones a channel's save keeps it to, or lets go.

`async fn set_channel_roles`: `PUT /api/groups/:group/channels/:channel/roles` `{ roles: [id, …] }`: who sees the channel
(docs/groups.md), from the channel's side. The channel is kept to exactly these roles, in
one transaction; an empty list is everyone's (no `channel_roles` rows). The channels power,
and a member. Each role kept or let go must be within the caller's reach, as with a role's
own save: nobody hands a channel to, or takes one from, a role carrying a power they do not
hold. → `{ channel, roles }`, and a `role` fact for each role whose channels changed, so an
open room asks again who sees what. 400 for the home channel (everyone's), 404 for no such channel
or a role not of this group, 403 without the power or out of reach.

`async fn transfer_ownership`: `POST /api/groups/:group/transfer` `{ name }`: the group is `name`'s from now on, and not
this login's (docs/groups.md): they are made an owner and the caller stops being one, in one
transaction, so the group has an owner throughout. An owner, for a member who is not one
(an owner already is 409), not themselves (400); the cap on owning counts for them as it
does for a naming. Two `owner` facts, theirs then the caller's. 204. The caller keeps their
roles and stays in the group; the members tab asks before this.

`async fn rename_owner_role`: `PUT /api/groups/:group/owner-role` `{ name }`: what the owner role is called from now on
(docs/groups.md): the word on the roster's crown and the roles tab's first row. An owner
(or a site admin). A role's name rule; not a custom role's name (409). → `{ name }`, and an
`owner_role` fact to every room open. Owning itself is untouched: the owners stay the owners.

`const MEMBERS_PAGE_MAX`: The most of the roster one page carries (`GET .../members?limit=`, the room's `?roster=`).

`const MEMBERS_PAGE_DEFAULT`: A page's size when `limit` is left out but `after` or `q` asks for a page.

`struct Page`: One page of the roster: at most `limit`, after the row `after` names (`Cursor`), and with
`q`, only the members whose name, or a role they hold, has it in it.

`struct Cursor`: Where a page left off: the last row's sort key (owner, when they joined in microseconds,
name), so the next page goes on from there however many joined or left in between. Written
`<0|1>.<micros>.<name>`; the page hands it out as `next`, opaque to the client.

`fn page_of`: A page's `limit`, `after` and `q` read; none of them is the whole roster (`None`), the
answer from before there were pages. `limit` is held to 1..=MEMBERS_PAGE_MAX. `q` is the
room's search box (history.rs `SEARCH_CHARS`): 400 past that, or with a control character
(postgres refuses a \0).

`fn like_pattern`: The words as a `LIKE` pattern that means them: a `%` or `_` typed is not a wildcard.

`async fn members_of`: The roster: every member with their picture, when they joined (unix seconds, so a room
keeps the order right as people come and go), whether they own the group, and the roles
they hold. Owners first, then `order` (`name`, `newest`, `oldest`), the name breaking a tie.
With a `page`, that page alone and the cursor of the one after it (`None` at the end);
without, all of it and `None`.

`async fn members_where`: `members_of`, or with `only`, that one member's row alone (none when they are not in it).

`async fn timeout`: `POST /api/groups/:group/timeout` `{ name, seconds, reason? }`: no line of `name`'s in the group's
channels for that long (docs/groups.md): the chat refuses them with `timed out` and the wait.
The kick power; a member (404), not yourself (400), an owner only by an owner (403); ten
seconds to a week (400). Set again, the new end stands. A row of its own (`timeouts`), so
leaving and joining again does not end it; the expired rows of the group are swept here.
`reason` is kept with it, a ban's rule. They are out of voice too, and kept out until it ends
(voice.rs). A `timeout` fact carries `until`, unix seconds. 204.

`async fn lift_timeout`: `DELETE /api/groups/:group/timeout/:name`: the timeout lifted, early. The kick power. 204,
also when there was none; the name needs an account (404), not a membership, since a timeout
outlives a leave. A `timeout` fact with `until` null.

`async fn list_timeouts`: `GET /api/groups/:group/timeouts`: every timeout still running, the soonest to end first:
`[{ name, avatar, until, reason, by, member }]`. `until` is unix seconds; `by` is null when
whoever set it is gone; `member` is false for one who left while timed out, since it
outlives a leave. The kick power, the one that sets and lifts them, as the bans list is the
ban power's.

`async fn bans_of`: Who is banned, newest ban first, with the reason given.

`pub`: True when this account is banned from the group. Join asks.

`pub`: The powers that moderate a member: kick (and with it a timeout, a line's delete, a voice
mute and a disconnect) and ban. A member's lines (`member_messages`) are for either.

`const ACTIONS_PER_MINUTE`: Moderation actions one login may take a minute here, on top of the route's tier (ratelimit.rs
`MODERATE`): the jannies' number (janny.rs), so a hijacked login cannot wipe a channel.

`const LOG_PAGE_MAX`: The most of a member's lines one page carries.

`const LOG_REDIS_SCAN`: How far back redis is read for a member's lines: a room's stream keeps its last 500 (chat.rs).

`pub`: Whether `actor` may act on `target` (kick, timeout, ban, a line's delete, a voice mute or
disconnect): never on themselves, and on an owner only as an owner. The rule kick, timeout and
ban have always had; a custom role has no rank above another's.

`fn may_delete`: Whether `actor` may delete a line by `author` (None: no account behind it). Their own always;
anyone else's with the kick power (`moderates`), an owner's only as an owner (`may_touch`).

`pub`: The member a moderation names, for `who` with any power of `bits`: 403 without, 400 for
themselves, 404 for no member, 403 for an owner unless `who` is one. Paced. → (id, name).

`async fn one_member`: `GET /api/groups/:group/members/:name`: one member as the roster has them (name, owner,
avatar, joined, roles, timeout), for the member info modal: the roster's pages may not have
reached them yet. The roster's rule. 404 `they are not in the group`.

`struct LogCursor`: Where a member's log left off: its last line's id and channel, `<ms>-<seq>.<channel>` (an id
has no dot, so the first one splits them). The lines go newest first by (ms, seq, channel).

`fn log_key`: The log's order key of a line in `channel`: (ms, seq, channel), compared the other way round.

`fn merge_log`: The two sides of a member's lines into one page: by (room, id) once, newest first, `limit`
at most, the rest saying where the next page starts. `room` is `server/channel` on the way
in; the channel alone on the way out.

`async fn member_messages`: `GET /api/groups/:group/members/:name/messages?before=&limit=`: one account's lines in this
group, newest first (docs/groups.md), for the member info modal: in the text channels the
caller sees, each with its `channel`, and with what it answered (`reply`) as it was said.
The kick or ban power (an owner, a site admin). A past member's lines too: the name needs an
account, not a membership. `limit` 1..=50 (50 left out); `before` the page before's `next`,
null at the end. Kept rows and the redis tail together, so a line not yet kept (or a chat
that keeps none) is there too. 401, 403, 404 `no such account`, 400 `bad cursor`.

`async fn delete_message`: `DELETE /api/groups/:group/channels/:channel/messages/:id`: the line goes, from redis and
postgres with its reactions (chat.rs `remove_line`), and off the channel's pins. Its author
may delete it; anyone else's takes the kick power (an owner, a site admin), and an owner's
line an owner. Every room open hears it on the chat socket (`delete`, with the channel) and
drops it. 204. 401, 404 `no such channel` (or one the caller does not see), 400 `bad id`,
404 `no such line`, 403.

`async fn put_icon`: `PUT /api/groups/:group/icon`: a jpeg, from an owner. The new version goes out as `icon`.

`async fn put_banner`: `PUT /api/groups/:group/banner`: the same, 1 mb, as `banner`.

## `api/src/groups.rs`

Groups: a login joins one, and its chat lines wear the group's badge. See docs/groups.md.

A group is a name, a short badge, a colour and a line about it. A login owns a couple of
groups at most (`GROUPS_PER_OWNER`, two unless `.env` says otherwise), is in a few, and
deletes the ones it owns. One is built in and automatic: `bot`.
Nobody joins it; a chat socket whose hello says `bot: true` wears it (chat.rs), so the
pretend chatters of the fake streams can be told apart, and hidden, in the panel.

Every other group is also a server. It starts with its home channel, a text one called
`general` (renamable; `channels.home` marks it), and a voice channel called `voice`
(`VOICE_CHANNEL`), and always keeps both kinds. The
maker is its owner and can do everything, including name another owner. A custom role
(group_mod.rs) is a name, a colour and some of those powers, never owner itself.
The explorer lists them; the room is `/chat/<server>/<channel>`.

Badges travel on the chat line itself (`groups`: name, badge, colour, picture, and for the
badge's hover card the line about it, the member count and the banner, as they were when
the line was said), so drawing a room, or a badge's card, needs no lookup here.

Every change to a group is also a `group` fact on the `events` stream (presence.rs), which
the gateway pushes to the sockets watching `group:<name>`: a room on screen loads once
(`GET /api/groups/:group` with the roster and the channels, `GET .../messages` with the last
lines of every channel) and then follows the facts, never asking again.

`pub`: The automatic group. Seeded by the schema, joined by nobody, worn by a bot's socket.

`const MAX_BADGE_CHARS`: A badge is a word, not a sentence: `BOT`, `VIP`, `mod`. The panel shows it in capitals.

`const GROUPS_PER_MEMBER`: Groups one login may be in. Its lines wear one badge (`badges_of`); the cap stays. Owning has its
own cap, `AppState::groups_per_owner`, read from `.env` (`groups_per_owner_from_env`).

`pub`: Groups one login may own when `GROUPS_PER_OWNER` is not set: the ones it made plus the
ones it was named owner of.

`const TEXT_CHANNELS_PER_SERVER`: Text channels on one server, `general` included; the voice ones have their own cap. The pages
hold the same number, so the add form goes at the cap; and it bounds what `GET .../messages`
answers for one room.

`const VOICE_CHANNELS_PER_SERVER`: Voice channels on one server. A group that had more before the cap keeps them, and adds none
until it is under it again.

`const MESSAGES_PER_CHANNEL`: Lines of each channel in `GET /api/groups/:group/messages`: what a room draws before its
socket says more. The socket fills from the newest of these, so nothing falls between.

`pub`: The name of the channel a group starts with, its home channel (`channels.home`, migration
0006). The home channel is not deleted, never kept to a role, and always text; it may be
renamed, and keeps all that under its new name.

`const VOICE_CHANNEL`: The voice channel a group starts with (migration 0005 gave every older group one). Unlike
`general` it may be renamed or deleted, only not while it is the server's last voice channel.

`const CHANNEL_KINDS`: A channel is one of these (migration 0004): text for lines, voice for talking. Text unless asked.

`const RESERVED_CHANNELS`: Words the chat history routes already use, so a channel cannot be one of them.

`const MAX_CHANNEL_COOLDOWN_SECS`: A channel's cooldown is seconds, none to an hour, like a role's.

`pub`: What a chat line carries for each group its speaker is in.

`type BadgeRow`: The columns `badges_of` and `badge_of` read, in `BADGE_COLUMNS`' order.

`const BADGE_COLUMNS`: What a badge reads from `groups g`: the word and colour, the picture's version, and what the
hover card wants (the line about it, the member count, the banner's version). The count is a
subquery on the memberships' group index, so a speaker's badges stay one query.

`pub`: The badges of these groups, by name (the inbox's channel rows, notify.rs `list`). One query
for any number; a name no group has any more is left out.

`pub`: A group's name follows the name rule, from the path or the body.

`fn tagged`: The address: the title, then `-` and four digits. A long title is cut so the whole
thing still fits the name rule (32).

`fn clean_badge`: Cleaned like a chat line (no control or invisible characters, no zalgo), on one line,
1 to 12 characters.

`pub`: `#rrggbb`, lowercased.

`async fn member_of`: How many groups an account is in. The cap says when joining one more is one too many.

`pub`: `GROUPS_PER_OWNER` from the environment: how many groups one login may own. Unset or
empty is the default; anything that is not a count of one or more is said in the log and
the default is used, since a cap of zero would let nobody make a group. Never above
`GROUPS_PER_MEMBER`: every group a login owns is one it is in, so a higher cap could not
be reached, and the pages would offer `create` for a group the api refuses. More is said
in the log and `GROUPS_PER_MEMBER` is used.

`fn groups_per_owner_from`: The rule behind `groups_per_owner_from_env`, on the raw value, so it can be tested.

`pub`: How many groups this account owns: the ones it made, and the ones it was named owner of.
Making another, or being named owner of another, is refused at `groups_per_owner`.

`pub`: The words for the cap on owning, as the create and the naming of an owner say it: `a
group already. one each` for a cap of one, `2 groups already. that is the cap` above it.

`pub`: How many are in the group now: on every `joined`, `left` and `banned` fact, so a room
never counts on its own.

`pub`: One change of a group, to whoever has its room open (docs/groups.md). After the row is
written, never before: a watcher patches what it has, and must not run ahead of the api.

`type GroupRow`: name, badge, color, about, made_by, members, mine, public, title, tag, icon, primary

`async fn list`: `GET /api/groups`: every group a stranger may see, `bot` first, then oldest first.
A private group is here only for someone in it (and `bot` always). `primary` is the asking
login's primary group (`set_primary`), always false for nobody. `made_by` is the
maker's name as it is now, by the id: a renamed maker reads right everywhere.

`async fn create`: `POST /api/groups`: a login makes a group and is in it, as its owner. 201 with the group as
the list shows it. The body's `name` is the title. The stored `name` is that title plus `-`
and four random digits, so the same title can be made again. 400 for a bad name, badge or
colour; 403 while the login owns as many groups as `GROUPS_PER_OWNER` allows; 409 `name
taken` for `bot`, or when eight draws of the digits were all taken.

`async fn join`: `POST /api/groups/:group/join`: 204, also when already in it. 401 for nobody, 404 for no
such group, 403 for `bot` (automatic) and past the cap.

`async fn leave`: `POST /api/groups/:group/leave`: 204, also when not in it. 401 for nobody. 403 when this
login is the only owner and someone else is still in it: name another one first. The last
person out deletes the group. Their roles in this group go with them.

`async fn set_primary`: `PUT /api/groups/:group/primary`: the one group whose badge this login's name wears, in
place of the first joined (`badges_of`), and the one its card shows (`badge_of`). 204. 401 for
nobody, 403 `join it first` for a group it is not in. Leaving the group, or the group going,
takes the choice with the membership row (schema.sql).

`async fn clear_primary`: `DELETE /api/groups/:group/primary`: back to the first joined group's badge. 204, also when it was not
the primary. 401 for nobody.

`pub`: A group with nobody in it is gone, pictures included. `bot` stays. Whoever still has
the room open hears `deleted`.

`async fn remove`: `DELETE /api/groups/:group`: an owner, the one who made it, or an admin (`ADMIN_NAMES`).
204; its members are out with it. 401 for nobody, 403 `not your group` and for `bot`, 404.

`pub`: A server and a channel, cleaned. `bot` is not a server. The history words are not channels,
or `/chat/vip/by/alice` would be a room and a search at once.

`pub`: The room key `server/channel` once the channel is really there.

`pub`: Whether this account is in the group. Speaking in a channel asks; reading does not.

`pub`: The sql for "this viewer sees channel `c`" (docs/groups.md): a channel kept to no role is
everyone's; one kept to roles (`channel_roles`) is seen by whoever holds one of them; an
owner, the channels power and a site admin see every channel. `c` is the `channels` row in
the query this goes into, `user` the placeholder of the viewer's id (null for nobody) and
`admin` the placeholder of whether they are a site admin.

`pub`: The channels of `server` this viewer sees (`sees_sql`), by name, in their order. What the
room, the messages and the server's chat socket go by.

`pub`: Whether this viewer sees `channel` of `server` (`sees_sql`). False for a channel that is not
there, so a hidden one and a missing one read the same: `no such channel`.

`pub`: Whether `channel` is the home channel of `server` (`channels.home`): `general` until it is
renamed. False for a channel that is not there.

`pub`: `visible_channels`, text channels only: what has lines to read and say. A voice channel
is in the room's list but has no chat, so the messages, the server's chat socket, search
and pins pass it by.

`pub`: `may_see`, for a text channel only: a voice channel has no lines, so asked for its chat it
reads `no such channel`, like a hidden one and a missing one.

`type ChannelRow`: name, about, maker's id, maker's name, cooldown, kind, user_limit, home

`pub`: The channels of one server in their order (`position`, as the channels power last put them;
oldest first until then, `general` first because it was made with the group), as the room
answers them for `user`: the ones they see (`sees_sql`; a channel kept to roles they do not
hold is not here). The same rule as the explorer's: `can_delete` is who made the channel,
or anyone with the channels power (an owner, that role, a site admin).

`pub`: The members of `group` who are streaming right now, by the name they have now.

`async fn live_names`: Names video says are connected, or the `live:` keys when video cannot be asked: the lists'
shared answer (`live_set`), a second old at most.

`async fn live_members`: Which groups have which of these names in them. A name not live is never asked.

`struct ExploreRow`: One row of the explorer's query: a server, and one of its channels (none for a server
without one this login sees). By column name: more columns than a tuple takes.

`fn live_first`: Someone live first, then the order the rows came in (oldest server first).

`async fn explore`: `GET /api/explore`: every server (not `bot`) this login may see, split into the ones
it is in and the public ones it is not. A private group it has not joined is left out.
Inside each, a server with someone live comes first. `live` is those members'
names. Channels in their order (`position`), as the room lists them: the ones this login
sees (`sees_sql`), like the room.
`groups_per_owner` is the cap on owning, so a page offers `create` only under it.

`fn channel_kind`: The kind a new channel asks for: text when it says nothing, else text or voice, else 400.

`async fn create_channel`: `POST /api/groups/:group/channels` `{ name, about?, kind? }`: a member adds one, text unless
`kind` says voice. 201. `general` already exists. 20 text channels at most and 4 voice ones,
each kind counted on its own (`add_channel`).

`fn channels_cap`: How many channels of `kind` a server may have.

`fn channels_full`: Why a server holding `n` channels of `kind` cannot add another, or nothing when it can.

`async fn add_channel`: The channel itself, last in the order: 403 `<kind> channels: <cap> at most` when the server
has its kind's cap already (`channels_full`; each kind counts only its own), 409 `name taken`.
The group's row is held while it counts and adds, so two adds at once cannot both slip under
the cap. Every way a channel is made after the group's first two comes through here.

`async fn set_channel_cooldown`: `PUT /api/groups/:group/channels/:channel/cooldown` `{ seconds }`: a member waits that long
between their lines in this channel (docs/groups.md), 0 (off) to an hour; beside a role's
cooldown, the line waits for whichever is longer, and the owners, the channels power and a
site admin wait for nobody. The channels power, and a member. → `{ cooldown }`, and a
`channel_cooldown` fact (`channel`, `cooldown`) to every room open.

`async fn reorder_channels`: `PUT /api/groups/:group/channels` `{ order: [name, …] }`: the channels in this order, from
the top. The channels power, and a member. Every name must be a channel of the server, once;
a channel not named (one added since the page read the list) keeps its place after the
named ones. → `{ order }`, the whole list as it now stands, which the `channel_order` fact
carries too. 400 for a name that is not a channel or a name twice, 403 without the power.

`async fn edit_channel`: `PUT /api/groups/:group/channels/:channel` `{ name?, about? }`: the channel is called `name`
from now on, and its line about it is `about`; either may be left out, not both. Who made the
channel, or the channels power; text or voice, the home channel too (it stays the home channel
under its new name). The name goes through the door a new channel's does (the name rule, the
history words, 409 for one the server has). Everything that knows the channel by its name
follows it in one transaction: the row, the mutes, pins and voice stays on it (the foreign
keys cascade), the inbox rows for its lines (`notifications.room`) and the lines kept for
search (`chat_lines.room`); then the chat's stream in redis is renamed, so the history reads
on, and whoever sits in a voice one is seated under the new name. → the channel as the room
lists it; a `channel_renamed` fact (`channel` the old name, `name` the new) when the name
changed, then a `channel_about` fact (`channel`, `about`) when the line did, to every room
open. A page on the channel moves to the new address. Nothing changed is 200 and nothing.

`async fn delete_channel`: `DELETE /api/groups/:group/channels/:channel`: who made the channel, who made the server,
or an admin. The home channel (`general`, under whatever name it has now) stays, and so does
the server's last voice channel.

`pub`: The channels of `server` this account has muted (docs/notifications.md): none of their
lines is a row in its inbox. In the room's answer, so the list can say so. Empty for nobody.

`async fn mute_channel`: `PUT /api/groups/:group/channels/:channel/mute`: no inbox row for this channel's lines, for
this login, from now on. 204, also when it already was. What is in the inbox stays, the way
a kind switched off leaves it. 401 for nobody, 404 `no such channel`. Not only a member's:
a mute outlives a leave, so joining again finds the channel as it was left.

`async fn unmute_channel`: `DELETE /api/groups/:group/channels/:channel/mute`: the channel's lines reach this login's
bell again. 204, also when it was not muted. 401 for nobody, 404 `no such channel`.

`async fn read_channel`: `PUT /api/groups/:group/channels/:channel/read`: the login has the channel on screen, so
what was said in it is not news any more: its `chat` rows for the room are read. 204. A
`chat_read` fact tells the login's other devices when anything was still unread. No check
that the channel is still there: a row for one since deleted is read the same.

`async fn messages`: `GET /api/groups/:group/messages`: the last MESSAGES_PER_CHANNEL lines of every channel
this login sees (`visible_text_channels`: a voice channel, or one kept to roles they do not
hold, is not here), oldest first, keyed by channel: `{ "general": [line, …], "clips": [...] }`.
One answer for the whole server, so a room draws every channel at once and switching
between them asks nothing. Redis only, like the socket's history: the room's stream holds
the last 500 of each. Anyone may read a server (chat.md). 404 for `bot` and for no such group.

`?limit=` (1..=MESSAGES_PER_CHANNEL) is lines per channel: a room asks for what fills its
screen twice, and scrolls up for the rest. `?channel=<name>&before=<id>` is that channel's
page strictly older than line `id`, in the same shape with the one key; a page shorter
than the limit is the start of what redis keeps (the chat's `/before` goes on into
postgres). 400 `bad id`, `before needs a channel`; 404 `no such channel` for one this
login does not see.

## `api/src/main.rs`

The json api. Bios live in postgres. Who is live lives in redis, and the
video server is asked to confirm it is really connected.

When the video server answers, it is the truth for "live right now": the
list and the watch page come from it, and a redis key with no connected
publisher behind it is treated as stale once its session is older than a
short grace (a fresh go-live has not reached video yet). When it does not
answer, redis is used alone (list and watch), and go-live refuses rather
than guess.

go-live hands out a session id plus a random token. Heartbeat and stop
must present them, so a stranger cannot end someone else's stream. A row
whose tab vanished without stop is ended by a sweeper once its key lapsed and
video does not have the name connected.

Nobody has to log in. A name with an account (auth.rs) is the one thing a
login is for: only its owner can go live, save its bio, its pictures (profile.rs:
the face, the home card's, and the one its page shows while it is not live) or
chat as it. A login can also join groups (groups.rs), whose badges go on its chat lines,
follow names (follows.rs), write to friends (dms.rs), and has an inbox of the last 30
things that happened to it (notify.rs): a follow went live, a new follower, a friend's line.

Every streamers row has a uuid that never changes (docs/ids.md). Logins,
memberships, groups and the pictures in the bucket point at it, so a login can
change its name (auth.rs, `POST /api/name`) and keep all of them. The name stays
the url, the chat nick and every redis key: nothing a person reads is an id.
The tables are `api/schema.sql`, applied at boot to an empty database (schema.rs).

The same binary run as `api chat` is the text chat server (chat.rs),
`api monitor` watches the other boxes from a box of its own (monitor.rs),
`api passwd <name>` resets a password, and `api models <dir>` puts a folder of demo
`.vrm` models into the bucket for the go live page's picker (models.rs).

One route is html, not json: `GET /watch/<name>` (profile.rs), so a shared
watch link gets a preview card with the name, picture, bio and live status.

/api/health says how this box is doing (postgres, redis, video, the s3 bucket,
uptimes, build). The pages post their own failures to /api/errors (debug.rs).

`const LIVE_TTL_SECS`: A live key dies this long after the last heartbeat. The page beats every 15s.

`const GO_LIVE_GRACE_SECS`: A key whose publisher video does not list yet is still theirs this long after
go-live: the page needs a moment to reach video. Older than this, it is a tab
that died without stop and the name is free again.

`const ZOMBIE_AFTER_SECS`: An open session row with no live key behind it is ended by the sweeper once it
is this old: longer than the key's ttl, so a merely slow heartbeat is never hit.

`const LIVE_SET_FRESH`: How long `live_set`'s answer stands for the lists. The sidebar asks for two lists at once
on an open and one more a pause in the typing (follows.rs, groups.rs); a second is longer
than any such burst and shorter than anyone notices a word being.

`type LiveCache`: `live_set`'s last answer and when it came, one per process. Locked for a read or a write,
never across an await.

`impl FromRef`: The bucket alone, for routes that want nothing else (models.rs).

`pub`: The status, the words, and for a 429 the seconds until a retry can work (`Retry-After`).

`pub`: Postgres said a unique key was already there (23505): a race somebody else won.

`impl From`: A missing or malformed query string is a 400 in the same `{error}` shape as
everything else, not axum's plain-text page.

`pub`: Lowercase a-z 0-9 _ -, 1 to 32 chars. The same rule as video and the pages.

`pub`: A stream name from the path.

`pub`: Proof that you are the one who went live. From the query string, so the
page can also send it with `sendBeacon` when the tab closes.

`pub`: `?password=`: only needed to write a reserved (dummy) name. Everyone else sends nothing. The
`X-Dummy-Password` header carries the same and wins over it (`test_streamers::DummySecret`, docs/test-streamers.md).

`pub`: May whoever is behind `me` write `name`: go live as it, save its bio, set its picture.
A reserved name belongs to the dummy box and wants its password, nothing else opens it
(it can never be claimed, so `may_act_as` alone would hand it to anyone). Any other name
follows `auth::may_act_as`: free for anyone, claimed only for its own login.

`pub`: Names the video server says are connected right now. None if it cannot be reached.

`pub`: Who is live right now, for a list of names (`follows::words`, the explorer's groups):
video's word, else redis, kept `LIVE_SET_FRESH` so a burst of lists asks video once.
Not for a word about one name now: go live, the watch grant and the sweeper ask video
themselves, since a second-old answer could let a name go live twice.

`pub`: The names of `video_live` with how many different addresses are receiving each one
(docs/viewers.md). One call for both: the home service builds and heals its table from it.
None if video cannot be reached.

`pub`: Is this name live right now: the video server's word when it answers, else redis.

`pub`: Does the video server have a picture of this stream yet (about 6s after going live).

`pub`: Names with a live key in redis.

`async fn held_sessions`: The session ids the live keys hold right now.

`async fn sweep_sessions`: Nothing ends the row of a tab that vanished without stop: its key lapses, the
row stays open for good. Once a minute, end every open row that is older than
a key could survive without heartbeats and that no live key names any more.
A row whose name's key still holds its id is a stream whose heartbeat is coming.

`async fn sweep_once`: Ends open rows old enough that no honest heartbeat could still be coming, that no live
key names, and whose name video does not have connected: a key can lapse under a stream
that is really on (the api was down past the ttl, redis restarted), and video's word is
what tells that from a dead tab. Without it nothing is ended: a zombie row ended a minute
late costs nothing, a live stream ended costs the stream.

`fn new_session_token`: 53 random bits from the os. The page keeps the token as a js number, which is
exact up to 2^53, and sends it back in the heartbeat and stop query strings.

`const DEL_IF_HELD_BY`: Deletes the key only while it still holds the value we read, so a key that
changed hands between our GET and this call is left alone.

`async fn session_verified`: Was the name's open session started by its own account. False with no open session.

`pub`: Does this session own the live key for the name, and is it still open?

`struct VideoHealth`: What video's own GET /health says. Every field best-effort: during a deploy
the api can be new while video still answers the old plain `ok`.

`async fn video_health`: Some when video answered 2xx, whatever the body was.

`pub`: The optional dependencies (debug db, video, the bucket) get this long in /api/health,
so a sick one cannot push the answer past docker's 3s healthcheck.

`async fn health`: 200 when postgres and redis answer, 503 otherwise. The rest of the body is for
a monitor: the release deployed (`version`, release.rs) and when, video reachable,
rooms live, uptimes (they go backwards after a restart), the build, reports the
limits dropped. See docs/debugging.md.

`const MAX_BIO_CHARS`: The status, in characters. A row saved before this was 500 keeps its longer one until the
next save.

`fn clean_bio`: The status as kept: a chat line's cleaning (no control or invisible characters, no zalgo),
one line (any run of whitespace is a space). 400 past MAX_BIO_CHARS, not cut: the page's
box stops there, so only a script sends more.

`async fn last_live`: When the name's last stream ended, if one has: the person card's "last live". Whose streams
are the name's is `list_sessions`'s rule (an account's by `user_id`, a free name's by name).
One still open does not count; the word beside the name says that.

`struct RangeQuery`: `?from=&to=`, both rfc3339, for the calendar's range. Neither: the last 20, as before.

`const RANGE_MAX_DAYS`: The most one calendar request spans: a quarter. The page asks a week at a time.

`const RANGE_LIMIT`: The most rows one range answers. A person live every night for three years is a thousand.

`type SessionRow`: id, name, started_at, ended_at, last_beat_at, ended_by

`async fn list_sessions`: The name's sessions: the blocks of its calendar (docs/calendar.md). With a range, every row
overlapping `[from, to)`, oldest first, at most RANGE_LIMIT. A claimed name's are its
account's (`user_id`: a rename keeps them as one list, a stranger's anonymous stream under
the name before it was claimed is not on it); a free name's are the name's. Without a range,
the last 20 newest first, the shape the route has always had. Never the token.

`async fn card_of`: What a home card draws for a live name, as the `live` fact carries it (docs/status.md): the
session's ✓ (not the name's: an account that signs up while a stranger streams anonymously
under its name must not put a ✓ on that stream), the profile's picture and bio, and the
pictures the streamer put on the card. `GET /api/streams`, the home service's snapshot,
joins the same fields from postgres per answer.

`async fn attached`: Video has the publisher: the room is claimed and answered, so a watcher who connects now
is served. This is where `live` is published for the name's watchers, not at go-live: the
gateway pushes it the moment it lands, and the page that gets it connects first time. Video
calls it after its claim with the go-live grant, like `heartbeat` and `stop`. A key that
lapsed meanwhile is taken back, as the heartbeat would.

`struct ViewersQuery`: `?session=&token=&viewers=`: the stream's grant and how many are receiving it.

`async fn viewers`: How many different addresses are receiving the stream, from video, whenever the number
moves (docs/viewers.md: video counts once ICE and DTLS are done, and says so at most once a
second per stream). A fact for the name's watchers and for home (docs/status.md); the home
service keeps the latest in its table. Stored here: the stream's peak, when this is a new
one (docs/analytics.md); the count over time is the sampler's.

`struct StopQuery`: `stop`'s query: the grant, and who is saying it. `by=video` is video's call when the
publisher's peer went; anything else, or nothing, is the page. A word for the record
(`sessions.ended_by`, docs/calendar.md), not a right: the grant is what is checked.

## `api/src/models.rs`

The demo models (docs/vtuber.md): a few `.vrm` files anyone may wear on the go live page,
so a person with no model of their own can try one. They live in the bucket under
`models/`, and the page's picker is one fetch: `GET /api/models` is the list (a name, an
author, a licence, whether there is a thumbnail), `GET /api/models/<id>` the file and
`GET /api/models/<id>/thumb` its picture. Nothing here is anyone's upload: a streamer's own
model stays in their browser.

The files get into the bucket from a folder, `random-media/vrms` in the repo, with
`api models <dir>` (scripts/models.sh runs it in the api container, and deploy.sh runs that
when the folder changed). Each `<name>.vrm` there is a model, its id the file's name; a
picture beside it with the same name (`<name>.jpg`, `.png`, `.webp`) is its thumbnail, and
without one the model's own embedded thumbnail is used when it is small. The name, the
author and the licence are read from the file's own meta. The list is one object,
`models/index.json`, written last, so the page never lists a file that is not there; a
model taken out of the folder is taken out of the bucket.

A `.vrm` is a glb: a 12 byte header, a json chunk, a binary chunk. This reads the header and
the json chunk and nothing else: no mesh and no picture is decoded (the thumbnail's bytes
are copied out as they are).

`const FILE_CACHE`: A file's url carries `?v=`, the start of its hash, so the bytes behind one url never change.

`const MAX_MODEL_BYTES`: The folder is ours, so these are for mistakes, not for strangers: a file bigger than any
model, a thumbnail that is really a photo, a list nobody would scroll.

`const PACKED`: The gltf extensions that pack a file's meshes or pictures, and the word for each. The page draws none of them.

`const UPLOAD_TIMEOUT`: A model is tens of megabytes, and the bucket may be far away: the bucket client's usual
10 s is for pictures.

`pub`: One model of the list, as the page gets it.

`fn valid_id`: a-z 0-9 - _, 1 to 48: a file name's slug, and nothing a path could be made of.

`pub`: The three reads. They want the bucket and nothing else of the api's state, so they are
written against any state that can hand one over: the api's, and a test's bare bucket.

`async fn list`: The list. No object yet (nobody ran `api models`) is an empty list, not an error.

`fn picture_mime`: Png, jpeg or webp by the first bytes. Never svg: a script.

`struct VrmInfo`: What a `.vrm` says about itself.

`fn words`: A string kept to one line and `MAX_WORDS` characters.

`fn read_vrm`: The glb's header and json chunk: is it a vrm, what does it call itself, and where is its
thumbnail. `Err` says why not, for the person who put the file in the folder.

`fn slug`: A file's name as an id: lowercased, anything but a-z 0-9 - _ a dash, no dash doubled or at an end.

`fn mb`: A megabyte count for a person: `15.1 mb`.

`struct Local`: One model of the folder, read and ready to go up.

`fn sidecar`: The picture beside `<stem>.vrm`, when there is one: `<stem>.jpg`, `.jpeg`, `.png` or `.webp`.

`fn read_local`: One `.vrm` of the folder: read, checked, named. `Err` is the line to print for it.

`fn read_folder`: Every `.vrm` of `dir`, by name. The second list is the files refused, each with why.

`fn plan`: What a run has to do to the bucket: the ids whose bytes go up (new, or changed), and the
ids to take out (in the bucket's list, gone from the folder).

`pub`: `api models <dir> [--dry-run]`: the folder's models into the bucket, and the list after
them. `--dry-run` reads the folder, prints the list it would write and touches nothing (no
bucket needed, so it runs anywhere). The bucket only: no postgres, no redis.

## `api/src/profile.rs`

The profile picture, and the one html route: the watch document.

The picture is a small jpeg the browser makes from whatever file was picked
(256x256, see the live page) and is stored in the bucket at `avatars/<id>.jpg`,
keyed by the row's id (docs/ids.md), so a name can change and nothing moves.
The streamers row only keeps when it was saved. That time is the `?v=` of the
url, so it is cached for a day and still changes the moment a new one is saved.
A picture saved before ids sits at `avatars/<name>.jpg`, and one saved before the
bucket is bytes still in the row: either is served from where it is and copied to
the id's key on that read. Only the name's owner may change it, the same rule as
the bio.

Thumbnails are the pictures on that name's card on home: up to six, each a
960x540 jpeg the browser made, at `thumbs/<id>/<n>.jpg` (before ids:
`thumbs/<name>/<n>.jpg`, lifted the same way). The row is written first and
dropped again if the bucket does not take the bytes. None means home shows the
camera, the way it always has.

The offline picture is what the watch page shows where the player would be while the
name is not live: a 1920x1080 jpeg the browser made, at `offline/<id>.jpg`, its save time
in `offline_at` as the `?v=`. Newer than ids, so there is no name key to lift. With it
goes a line under the word, `offline_note`. Both through the bio's gate.

Socials are where else to find them (docs/socials.md): the `socials` tab under the player.
One jsonb document on the row, replaced whole like the bio: how the links sit (`row` or
`grid`), how big, and the links, each a kind from a fixed list (the icon the page draws),
an http(s) url and a label of theirs. Checked at the door, every field: a url that is not
http(s) with a host never reaches the row, so the page can draw what the row holds.

About me (docs/about.md) is the longer piece of words first on the `about` tab: a few
paragraphs, `about` on the row, replaced whole through the bio's gate like the rest. The
bio itself is the status, one line beside the name (main.rs `put_streamer`).

Assets are the pictures a streamer lays onto the scene (docs/screen.md): png, jpeg, gif or
webp, up as they are (a gif keeps its frames, a png its holes), so the api sniffs the first
bytes and never decodes. Up to 24 a name, 2 mb each, at `assets/<id>/<n>.<ext>`, listed by
name like the thumbnails; an id is never reused and the bytes never change, so the url
caches for good. The scene names them by id, and the watch page builds the url under the
stream's name: nobody can point a layer at somebody else's picture.

`GET /watch/<name>` exists for link previews. iMessage, Discord, Slack and X
make them with a bot that fetches the url once, reads `<title>` and the
`og:*` tags, and never runs js; the spa's index.html says "streams" for
every page. So caddy sends `/watch/*` here instead of to the files, and
this answers with the same index.html, read from the pages volume so the
hashed asset names are always the current ones, with a real head for this
one name. The profile card in its `<template id="watch-shell">` is filled
in and put inside `#root`, so the page shows the name, picture, the word and
the status line before react boots. React replaces the card when it renders.

`const MAX_AVATAR_BYTES`: The browser sends 256x256 at quality 0.85, a few tens of kb. This is the ceiling.
A thumbnail is 960x540 and shares it: the same body limit covers both routes, and the
page steps a busy photo down a notch to fit.

`const MAX_OFFLINE_BYTES`: The offline picture is 1920x1080 at quality 0.8, and a photo at that size runs far past
the avatar's ceiling. The page steps the quality down until it fits under this one.

`const MAX_NOTE_CHARS`: The line under the word while they are not live. One line; the page's box stops here too.

`const MAX_THUMBS`: How many pictures one name may put on its home card.

`const AVATAR_CACHE`: The url changes with every upload (`?v=`), so a day is safe.

`const MAX_ASSET_BYTES`: A scene's picture goes up as it is: no re-encode, so transparency and the frames of a gif
survive. Bigger than any picture the page makes itself, which is why its route has its own
read limit. And how many one name may keep.

`const ASSET_CACHE`: The id is the url and an id is never reused, so the bytes behind one never change.

`const AVATAR_IMG_CLASS`: The markup the api itself emits into the card. The classes are tailwind's, generated
because the same strings appear in the pages (`Avatar.tsx`, `WatchPage.tsx`).

`const STATUS_SPAN_CLASS`: The status line under the name (`WatchPage.tsx`, `#bio`): one line, the whole of it on hover.

`fn pages_dir`: Where the pages one-shot copies the vite build. The same volume caddy serves from.

`type ProfileRow`: bio, picture, account, offline picture, offline note, joined, socials, about, oauth verified, welcome on, welcome

`pub`: Bio, picture versions, account flag, oauth-verified flag, the offline line, when the account was made, the links and the about me, in one query. A name nobody saved anything for is all defaults.

`async fn row_id`: The id of the name's row, if it has one.

`async fn ensure_row`: The id of the name's row, made bare if it had none: a picture needs a key before the
bytes go up. The `DO UPDATE` is the idiom that makes `RETURNING` answer for a row already there.

`fn legacy_avatar_key`: Where a picture saved before ids sits. Read from, lifted out of, never written.

`async fn lift_object`: The bytes at `from`, if any, copied to `to` and gone from `from`. For the pictures saved
before ids: a read serves them from where they are and moves them, so the next read, and
a rename, find them under the id. The bucket has no copy, so this is a get and a put.

`async fn lift_legacy`: A picture from before the bucket. Copy it up and drop the postgres bytes. A miss
here still serves the row: the next read tries again.

`pub`: Before a rename (auth.rs): every picture of this name that still sits at a name key moves
to the id's, so nothing in the bucket says the name when it changes. Best effort: a miss
is logged, and the read path lifts what is left on its next look.

`pub`: Every key a row's pictures can sit under: for a rename that takes a free name's row away.
`assets` are the scene pictures' ids with their mime, as `stream_assets` keeps them.

`pub`: Objects nobody can reach any more, dropped. Best effort: a miss leaves an orphan, nothing worse.

`fn jpeg_body`: The body as the jpeg it has to be: not a form, under `max` (the route's read limit stopped
an oversized one already, and that reads as the same 413 here), and starting like a jpeg.
The page resizes before sending, so this is all the api ever checks of a picture.

`async fn put_avatar`: The route's body limit stops reading at the ceiling, so an oversized upload costs nothing past it.

`fn legacy_thumb_key`: Where a thumbnail saved before ids sits. Read from, lifted out of, never written.

`fn checked_name`: A name from a path that also carries an id. `Name` only fits a path with the one segment.

`fn new_thumb_id`: 53 bits, so the id survives a js number. Never 0.

`pub`: Ids for these names, oldest first. A name with none is absent.

`async fn put_thumb`: The row first, then the bytes. A bucket miss drops the row, so home never lists a
picture that is not there. A failed save of a later one does not touch the rest.
The cap is counted and the row written under a lock on the name, so two saves at
once cannot both land as the seventh.

`struct Kind`: One of the four kinds a scene's picture may be: what the first bytes say, what goes back on
the wire, and what the key ends in. No decode: the bytes are stored and served as they are.

`fn sniff`: What the first bytes say this is, or None. A gif is `GIF87a` or `GIF89a`; a webp is a riff
container, so the word is at byte 8, past the four-byte length. Never svg: a script.

`fn kind_of`: Back from what the row kept, for the read and the delete. An unknown string is no kind.

`fn asset_body`: The body as one of the four kinds, and which it is. Not a form, under `MAX_ASSET_BYTES`
(the route's read limit stopped an oversized one already, and that reads as the same 413
here), and starting like a picture. The bytes go up as they are, so this is all the api
ever looks at; the browser's own content-type is not trusted.

`pub`: Ids with their mime and size, oldest first: the order `thumb_ids` uses.

`async fn put_asset`: `put_thumb`'s shape: the row first, then the bytes, a bucket miss dropping the row so the
scene never lists a picture that is not there; the cap counted and the row written under a
lock on the name, so two saves at once cannot both land as the twenty-fifth.

`async fn put_offline`: The same shape as the avatar's save, with its own ceiling: the bucket first, then the version,
so a cached url never points at a picture that did not land.

`fn clean_note`: The note as it is kept: one line (any run of whitespace is a space), MAX_NOTE_CHARS at most.

`async fn put_offline_note`: `{ note }`: the line under the word while they are not live. Empty clears it. The bio's
upsert, so a name nobody saved anything for gets its row here too.

`const MAX_ABOUT_CHARS`: The about me as kept, at most. The page's box stops here too.

`fn clean_about`: The about me as it is kept: a chat line's cleaning (no control or invisible characters, no
zalgo, two newlines in a row at most), trimmed, MAX_ABOUT_CHARS at most. Paragraphs stay.

`async fn put_about`: `{ about }`: the words first on the about tab. Empty clears it. The bio's gate and the bio's
upsert, so a name nobody saved anything for gets its row here too. → `{ name, about }` as kept.

`const DEFAULT_WELCOME`: What `Eques` says until the streamer changes it: the column's default (0009-chat-welcome.sql).

`const MAX_WELCOME_CHARS`: The welcome as kept, at most. The page's box stops here too.

`fn clean_welcome`: The words as kept: a chat line's cleaning, trimmed, MAX_WELCOME_CHARS at most. Empty is the default.

`async fn put_welcome`: `{ on, message }`: whether `Eques` welcomes a viewer to the chat, and with what. Never a chat
line: the page draws it for the one viewer (ChatPanel.tsx). The bio's gate and upsert.
→ `{ name, welcome_on, welcome }` as kept.

`const MAX_LINKS`: How many links one name may put under its player.

`const MAX_URL_CHARS`: A link as kept, at most. The page's box stops here too.

`const MAX_LABEL_CHARS`: The words on a link, if they gave any. One line.

`const MAX_SOCIALS_BYTES`: The whole document, as a body: twenty links with the longest url and label each is under 12 kb.

`pub`: How the links sit on the page: in a line that wraps, or as squares with the words under each.

`pub`: How big the icons are drawn.

`pub`: The places a link can be of: the word the page picks its icon by. `web` is any other site.
A word is a label the owner picks, never a check on the host: a `youtube` link may be a
`youtu.be`, a redirector, a linktree. What is checked is the url, the same for every kind.

`const PLATFORMS`: Each kind and its word on the wire. One list, read both ways.

`impl`: A word the row holds that this build does not know (a kind taken off the list) reads as
`web`: the link stays, with the plain icon. The door (`clean_socials`) is where a word is refused.

`pub`: One link: where, the url, and the words on it ('' for the kind's own word).

`pub`: The document the row keeps and the page draws. Replaced whole, like the bio.

`struct SocialsBody`: The body as the page sends it: strings, checked below. `layout` and `size` may be left out.

`fn clean_url`: A link as kept: absolute, `http` or `https`, with a host and no credentials, MAX_URL_CHARS at
most, written back the way the parser has it (the scheme and host lowercased, a control
character escaped: nothing a browser would read differently, and nothing postgres refuses in
json). None for everything else: `javascript:`, `data:`, a path, a bare `twitch.tv/bob`. The
parser is the whatwg one, the browser's own `new URL`, so the api and the page agree.

`fn clean_label`: The words on a link as kept: a chat line's cleaning (no control or invisible characters),
one line, MAX_LABEL_CHARS at most. Empty for none: the page says the kind's word then.

`fn clean_socials`: The body as the document the row will hold, or the first thing wrong with it. Refused, not
trimmed: the bio loses its tail quietly, but a link dropped from the middle of a list is a save
the owner cannot see. A layout or size left out is the default; one given wrong is refused.

`async fn put_socials`: The document, replaced whole. The bio's gate and the bio's upsert, so a name nobody saved
anything for gets its row here too; an empty list clears it. → `{ name, socials }` as kept.

`fn escape`: Text into html: safe inside a tag and inside a double-quoted attribute.

`fn one_line`: A bio as one line for a preview card. Bots show about 200 characters.

`fn origin`: `https://<host>` as the browser sees it. Caddy keeps the Host header and sets the proto.

`enum Card`: What the picture in the card is: the stream itself while live and a thumbnail exists, else
the offline picture while not live, else the profile picture, else nothing. The two wide
ones show big (`summary_large_image`); the profile picture is a square beside the words.

`fn head_tags`: The title keeps `live|offline`: it is about the stream, and previews are cached for hours.
The description with no bio says the presence word too: a watcher deciding whether to wait.

`fn card_html`: The `<template id="watch-shell">` of index.html with the placeholders filled in.
None if the pages have no such template (an older build): the head alone still works.

`fn presence_tone`: The same colours the pages give the four words (`presence-atoms.ts`).

`fn render`: index.html with its head replaced for this name and the card inside `#root`.

`async fn watch_page`: Caddy sends every `/watch/*` here. The rest of the path is the name, with or without a
trailing slash. Anything else is still the spa, with a 404, so a mistyped link shows the
page's own "bad name" instead of json.

`async fn watch_nobody`: `/watch/` with nothing after it: the spa's own not-found page.

## `api/src/schema.rs`

The database is `api/schema.sql`, the baseline (the whole database as of 2026-11-19), plus
the migrations after it, `api/migrations/NNNN-*.sql`, listed in `MIGRATIONS`. At boot the api
applies the baseline to an empty database ("empty" is "no `streamers` table"), in one
transaction, then each listed migration that `schema_migrations` does not have yet, in order,
each in its own transaction with its row. A fresh database gets the baseline and every
migration; an existing one gets only the new ones. Never edit the baseline or a migration that
has shipped: a change is a new file (api/migrations/README.md).

`const MIGRATIONS`: The migrations after the baseline, in order: `("NNNN-what", include_str!("../migrations/NNNN-what.sql"))`.
Append only. A name is applied once, ever (`schema_migrations`).

`pub`: Apply `schema.sql` when the database has no tables yet. The chat process does not call this.

## `api/src/voice.rs`

Voice channels: the grant a page takes to the voice server, and the voice server's own
calls back here (docs/voice.md).

Joining is two steps. The page asks `POST /api/groups/:group/voice/:channel/join` with its
login; the api checks the person may be there and hands back a grant, 32 random bytes as hex,
kept in redis as `voicegrant:<hex>` for `GRANT_TTL` seconds. The page gives the grant to the
voice server (`/voice`), which redeems it here once (`POST /api/voice/redeem`, GETDEL) and
learns who it is talking to. The voice server never sees the cookie, and a grant is good for
one connection and half a minute.

Who is in a channel is `voice:<server>`, a hash of user id to `{name, channel, seat, since,
beat, session}`, and `voiceof:<user>` says `server/channel` for whoever is in one;
`voice:servers` is the set of servers with anyone in voice. The voice server writes them
through its own calls: `attached` once a person has a seat, `left` when the seat frees, and
one `beat` every 15s for everyone seated. Each stay is a `voice_sessions` row (its id is the
field's `session`), and each change is a group fact on `group:<server>`, `voice` and
`voice_left`, `{who, uid, channel}`. Join only reads them, for `already in voice` and
`channel full`.

A voice server that dies says nothing, so `sweep` drops every field whose beat is older than
`STALE_AFTER` the same way `left` does: its people are gone within a minute.

The internal routes answer only inside the compose network: a request caddy passed (it
always sets X-Forwarded-For) is a 404, and one without `X-Voice-Secret` equal to
VOICE_SECRET is a 403. With VOICE_SECRET unset or empty, voice is off and they are a 503.
Neither the secret nor a grant is ever logged.

`const GRANT_TTL`: How long a grant waits to be redeemed, in seconds.

`const DEFAULT_LIMIT`: How many fit in a voice channel whose `user_limit` is 0 (no limit set).

`const SWEEP_EVERY`: How often `sweep` looks, in milliseconds.

`const STALE_AFTER`: A field whose beat is older than this, in milliseconds, is a seat nobody holds any more: three
beats missed. Swept within `STALE_AFTER + SWEEP_EVERY`, a minute.

`const SERVERS_KEY`: The set of servers that have had anyone in voice, for `sweep`.

`const TAKE`: Takes field ARGV[1] out of hash KEYS[1] and → it, or nil when it is not there. With ARGV[2]
set, a field whose beat is at or past ARGV[2] stays (a beat came in after the sweep looked).

`const BEAT`: Sets `beat` to ARGV[2] in field ARGV[1] of hash KEYS[1], only while the field is there: a
beat never brings back someone who left. → 1 when it did.

`const MOVE_SEATS`: Seats everyone in channel ARGV[1] of hash KEYS[1] in channel ARGV[2] instead (a rename), in
one go so a beat cannot land between the read and the write and undo it. → their user ids.

`const SET_IF`: Sets KEYS[1] to ARGV[2] only while it still holds ARGV[1].

`const DEL_IF`: Deletes KEYS[1] only while it still holds ARGV[1].

`const FORGET_IF_EMPTY`: Forgets server ARGV[1] in set KEYS[2] only while its hash KEYS[1] is empty.

`pub`: The set of user ids a moderator muted in `server`'s voice (`server_mute`): their mic carries
nothing until a moderator lifts it, across leaving and coming back.

`struct Seated`: One person in voice: the value of their field in `voice:<server>`. `since` and `beat` are
unix milliseconds (as a chat line's `at`), `session` the `voice_sessions` row of this stay.

`fn beat_of`: The beat in a field of `voice:<server>`, None when it has none or is not json.

`fn stale`: Whether a field last beat at `beat` is a seat nobody holds at `now`: more than `STALE_AFTER`
seconds ago, or no beat at all.

`fn secret`: VOICE_SECRET, read once. None while it is unset or empty: voice is off.

`fn same`: Whether two strings are the same, in a time that says nothing about where they differ: both
are hashed first, and the digests compared byte by byte with no early way out.

`fn voice_on`: VOICE_SECRET as `secret`, or 503 `voice is off` while it is unset or empty.

`fn inside`: The gate on every internal route, with VOICE_SECRET as `secret`: 404 for anything caddy
passed, 503 `voice is off` without a secret, 403 `bad secret` for a wrong or missing header.

`async fn may_talk`: A voice channel this account may be in: a member of the server (403), who sees the channel
(404 `no such channel`, a hidden one and a missing one alike), and it is a voice one (400).
→ its `user_limit`. Join asks this, and redeem asks again: a grant is half a minute old.

`fn room_for`: How many fit: the channel's `user_limit`, `DEFAULT_LIMIT` when that is 0.

`fn others_in`: How many others are in `channel`, from the fields of `voice:<server>` (user id → json with a
`channel`). `user` is not counted: being in it already takes no second seat.

`fn voice_url`: VOICE_URL, the voice server inside the compose network (`http://voice:7881`). Its
`/internal/voice` is not behind caddy: caddy sends `/voice` alone there, as `/ws`.

`pub`: Takes `user` out of voice in `server` now, whatever voice server seats them: a kick, a ban,
a timeout (group_mod.rs), a moderator's disconnect. The voice server drops their peer, and
their seat leaves the room here at once rather than at its `left`. Never fails the caller:
a voice server that does not answer is a warning, and the seat goes from the room anyway.

`const VOICE_MOD`: The powers that moderate voice: kick (docs/groups.md) or the voice power, which says so.

`async fn server_mute`: `POST /api/groups/:group/voice-mute {name, muted}`: a moderator's mute on `name`'s mic in this
group's voice, or its lifting. The voice server stops carrying their audio (and starts again);
they cannot lift it themselves, and it stays across leaving and coming back. The kick or voice
power; not on yourself (400), an owner only by an owner (403), a member (404). A `voice_mute`
fact `{who, uid, muted}`. → `{muted}`.

`async fn disconnect`: `POST /api/groups/:group/voice-disconnect {name}`: `name` out of this group's voice now
(`drop_from_voice`); they may join again. The kick or voice power, and the rules of
`server_mute`. 204, also when they were not in voice.

`async fn leave`: Takes `user` out of voice in `server`: their field (with `older_than`, only while its beat is
older than that: the sweep's), their open `voice_sessions` rows, `voiceof` while it still
names this stay, then `voice_left` to the group. Row first, then the fact. → whether there
was a field to take.

`pub`: The voice channel `from` of `server` is called `to` now (groups.rs, `edit_channel`): whoever
sits in it keeps their seat under the new name, in `voice:<server>` and in their `voiceof`.
The voice server knows a seat by user and server only, so it carries on as it was; the room
follows the `channel_renamed` fact.

`async fn attached`: `POST /api/voice/attached {user_id, server, channel, seat}`: the voice server's, inside only,
once the person has a seat. Asks `may_talk` again, takes them out of wherever they were
(`leave`), opens a `voice_sessions` row, writes their field, `voiceof` and `voice:servers`,
then tells the group `voice {who, uid, channel, muted}`. → `{session}`.

`async fn left`: `POST /api/voice/left {user_id, server}`: the voice server's, inside only, when a seat
frees. `leave`, and → `{left}`, false when they were not in voice there (already swept, or
a second call).

`pub`: Every `SWEEP_EVERY`, takes out of voice everyone whose beat is older than
`STALE_AFTER` (`sweep_once`). Not at boot: after an api outage the voice server's next beat
brings its people's fields back to now, and it beats every 15s, so the first sweep waits a
full `STALE_AFTER`. Never runs while voice is off.

`async fn sweep_once`: One sweep over `voice:servers`: `leave` for each stale field (only while it is still stale,
so a beat that lands meanwhile wins), and a server whose hash is empty is forgotten. A field
whose key is not a user id is dropped outright. → how many it took out.
