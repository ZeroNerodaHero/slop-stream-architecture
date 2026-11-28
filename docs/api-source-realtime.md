# api/ source: realtime and social

the header comment of each file below and the doc comment of each top-level item, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a piece was written for at the time of the move, so check a detail against the code before trusting it. accounts, storage, limits and ops are in `api-source-core.md`. chat, groups, profiles, media, voice and boot are in `api-source-chat-groups.md`.

## `api/src/events.rs`

`/events`: the gateway. One websocket per browser, open on every page. A process of its
own, `api events` on :4100, the `events` container: the chat is a different socket in a
different container, and the two share only the plumbing in socket.rs. See docs/status.md.

A socket says hello as a name (the cookie's login, else the nick lowercased when nobody
owns that name, else nobody) and from then on the name is *here*: a member of the sorted
set `seen:<name>` scored by the time this socket last refreshed it, which it does on its own
20s ping. The first socket in and the last one out of a name are atomic EVALs that also put
a `seen` fact on the `events` stream. A socket may `watch` names: it is told their word
(`presence`) when it changes, and `live` / `ended` as they happen. Every socket watches its
own name without asking: `me` carries the word and the choice.

Facts come from one redis stream, `events`, written by the api (`live`, `ended`, `viewers`,
`status`, `renamed`, and `dm` / `dm_react` / `dm_read` for the direct messages of docs/dms.md and
`notify` / `notify_read` / `notify_removed` / `chat_read` for the inbox of docs/notifications.md, which go to
the sockets that *are* a name rather than to its watchers; the chat process writes `notify`
too, for a line in a channel) and by this module (`seen`).
One task per process tails it and routes
each entry to the sockets that care; the word is derived here, on delivery, from the inputs
(the `live:` key, the set, the column), never carried in a fact, so two writers cannot race
a stale word past a fresh one. The pages never write through this socket: the choice is an
http PUT. A socket may also `watch` `*`: every name's `live`, `ended` and `viewers`, the
home page's feed behind its one `GET /api/streams` (home.rs). And it may `watch`
`group:<name>`: every change to that group (`group` facts from groups.rs, forwarded whole),
plus `live` and `ended` for its members, so a room on screen follows without asking again.

A `renamed` fact (docs/ids.md) re-keys the sockets of the old name to the new one: they
leave `seen:<old>` at once and enter `seen:<new>`, and they, and the old name's watchers,
get a `renamed` frame. A socket's name lives in the registry, not in its task, so the
ping that keeps it here reads the current one.

`const REPLAY_MS`: How far back the tail starts after a (re)start: the gap of a deploy, replayed. Deliveries
are idempotent (the word is recomputed from the truth; `live` and `ended` make the page ask
`watch` again), so a replayed entry costs nothing.

`const RECHECK_EVERY`: Every watched name's word again, pushed on change: notices a gateway that died without its
drain (its members go stale and nobody published `seen 0`) and heals an entry a watcher missed.

`const EVERYONE`: The `watch` that means every name: the home page's. Not a name (names are letters, digits, `_ -`).

`const MAX_SOCKETS_PER_IP`: Events sockets one address may hold open at once in this process. The page keeps one per
browser (a shared worker carries every tab), so this is a household's worth of browsers.

`const MAX_WATCHES`: Names and topics one socket may watch at once. The sidebar watches every follow (500 at
most, follows.rs) plus the people on screen; past this a `watch` is dropped.

`const MAX_WATCH_FRAMES_PER_MIN`: `watch` and `unwatch` frames one socket may send in a minute; past it they are dropped
until the minute is over. Each watch of a name costs a lookup of its word.

`const GROUP_TOPIC`: The `watch` that means one group's room: `group:<name>`. Not a name either (the colon).

`fn group_topic`: `group:<name>` → the group, when the rest is a name. None for anything else.

`fn is_topic`: A `watch` that is a topic, not a name: no word to compute or recheck for it.

`const FIRST_IN`: The first socket of a name: trim the stale, add mine, keep the set alive, and say `seen 1`
if the set was empty. One EVAL, so two gateways cannot race a last-out against a first-in.
KEYS: seen:<name>, events. ARGV: socket id, now ms, name, window ms, ttl secs, maxlen.

`const LAST_OUT`: The mirror: remove mine, trim the stale, and say `seen 0` if nobody is left.

`Seat`: a socket's place in the registry. Made the moment it is inserted; dropping it removes the socket
from every index and, unless the process is restarting (`going`), queues its `LAST_OUT` on `leaves`, which
one task (`unmark`) runs. A handler that panics or is aborted is unseated like one that returned.

`const OUT_QUEUE`: frames waiting for one socket (1024). A socket that falls this far behind is not
buffered further: it is closed with 1013 `behind` and the page reconnects and asks for its whole set again.

`pub`: Every open socket of this process, and two indexes over them: which sockets are a name,
which sockets watch it. Behind one lock; nothing in here waits on the network.

`struct Refused`: A hello that can never do. Said once, and the socket is closed, as in the chat.

`pub`: `api events`: the gateway on a listener of its own. `GET /health` for the container's
check, `/events` for the browsers, `/online` for the tests inside the network. On SIGTERM
every socket gets a close frame and up to DRAIN_LIMIT to leave, like the chat's rooms.

`async fn ws`: The login cookie came with the handshake; `handle` reads it. Not the `Me` extractor: a
database error would be a 500 before the upgrade, and a nameless socket may still watch.

`async fn online`: `{ "<name>": <open sockets in this process> }`, like video's `GET /live`. Inside the compose
network only (no caddy route); the tests read it locally, the truth for everyone else is
`presence` on `GET /api/streamers/:name`.

`fn guest_name`: A guest's nick to the name it would be, the chat's way: cut to 24, letters digits `_` `-`,
then lowercased, so the two sockets of one browser land on the same name. No nick, or a
blank one, is nobody. Pure: `identify` adds the one check that needs the database.

`async fn identify`: Who the socket is: the cookie's login; else the nick cleaned the chat's way and lowercased,
when it is a name nobody owns; else nobody (a hello with neither, or a database that did not
answer: admitted, it may still watch, it marks nothing). A claimed or reserved nick is
refused outright, in the chat's words: wearing somebody's name would be a lie.

`async fn tail`: One tail of `events` per process, on its own connection. Starts REPLAY_MS back, continues
from the last id across redis blips, and when redis is back tells every socket to re-mark.

`async fn recheck`: Every RECHECK_EVERY, the word of every name somebody here is or watches, pushed on change.

## `api/src/follows.rs`

Follows: a login follows a name, and the panel in the corner says which of them are
streaming, and how the rest are. See docs/follows.md.

One table of edges, `follows (follower_id, followed_id)`, both row ids (docs/ids.md): a
renamed name keeps its followers, and the routes still speak names like everything else.
The follower is a login (an edge needs an id with a person behind it); the followed is
any valid name, claimed or free, and a name with no row gets a bare one so there is an
id to point at, the way a bio does. Counts are public, the list is the login's own.

`GET /api/search?q=` finds names to follow: every streamers row whose name starts with the
letters (under three of them) or holds them anywhere (from three), the exact one first,
then the ones that start with them. A trigram index on the name (schema.sql) serves
both shapes once the table outgrows a read of the whole of it.

`const FOLLOWS_PER_LOGIN`: Names one login may follow. More than anyone watches.

`const CHURN_PER_HOUR`: Follows and unfollows per login per hour: a loop on one button must not write a row a second.

`const SEARCH_LIMIT`: Search answers this many at most: the box is for finding one person, not listing everyone.
The box knows the number (`SEARCH_LIMIT` in api.ts): an answer short of it is every name
the letters find, and more letters are cut from it without asking.

`const SEARCH_ANYWHERE_FROM`: Letters fewer than this find names that start with them; from this many, names holding
them anywhere. A trigram is three letters, so the index serves both; and `a` alone naming
every row with an a in it was never an answer anyone wanted.

`const SEARCH_PER_MINUTE`: Searches per ip per minute. The box asks once a pause in the typing and keeps what it
heard for half a minute, so a person makes a few dozen; a script walking the names is not
the box.

`const PEOPLE_SCAN`: `/people`: this many rows looked at (accounts first, newest change first), this many shown
after the live ones are taken out and the rest sorted online first.

`const RECENT_SCAN`: Home's recently offline: this many of the names whose last stream ended most recently looked
at, this many shown after the ones live again are taken out.

`pub`: Do `a` and `b` follow each other: friends, in the sidebar's word. What a direct message
(dms.rs) asks before a line is kept. One probe of each index.

`pub`: The follow facts of one name as a reader sees them: `stats`'s answer.

`pub`: How many follow `name`, does `me` (a login's row id, or nobody) follow it, and does it
follow `me`: what every profile read carries. One round trip.

`pub`: `live` and the presence word of every name in one go. Each name comes with the choice its
row holds, read by the caller's own query (the list already joins `streamers`; nothing reads
it twice). Then the live set (`live_set`: video's once, else the keys, kept a second across
the lists) and one pipelined `ZCOUNT` per name, the two asked at the same time. The rule is
presence.rs's; this is the same answer `GET /api/streamers/:name` gives, n times for the
price of one round trip. The list of direct message threads (dms.rs) draws its faces with
the same call.

`pub`: A row's status column as the choice it names: `online` for a row older than the column (its
default), `status_of`'s rule. With the name, what `words` wants.

`fn rank`: Streaming first, then online, do not disturb, offline; inside a word, as the rows came.

`type FollowedRow`: name, verified, avatar, bio, followed_at, mutual (that name follows this login back: a friend), status, oauth_verified

`async fn follow`: `POST /api/streamers/:name/follow`: 204, also when already. A name held after a rename is
followed as the account that holds it. The followed name's row is made bare when it has
none, in the one statement with the edge.

`async fn follow_as`: The follow itself, for the login `me_id` named `me_name`: all of it but the churn limit,
which needs redis. On the pool alone so a test can run it. The followed row's id and the
name it has now when the edge is new; None when it was there already.

`async fn unfollow`: `POST /api/streamers/:name/unfollow`: 204, also when not following.

`async fn following`: `GET /api/following`: the login's, streaming first, then by how they are, then newest follow first.
`mutual` is the other edge: they follow this login too. Nothing stores "friends"; the join is the list.

`fn clean_query`: The letters a search may hold: the name rule's, lowercased. Anything else is dropped, so
`Alice!` finds `alice`, and `%` and `\` never reach the pattern (`search_pattern`).

`fn search_pattern`: The `LIKE` pattern for a cleaned query: the letters at the start of a name, or anywhere in
it from `SEARCH_ANYWHERE_FROM` letters. `_` is a letter in a name and a wildcard to `LIKE`,
so it is escaped; the trigram index reads both shapes (schema.sql). The query is ascii
(`clean_query`), so its bytes are its letters.

`type HitRow`: name, verified, avatar, bio, following, status, oauth_verified

`async fn search`: `GET /api/search?q=ali`: names holding the letters (starting with them, under three), the
exact name first, then the ones that start with them, accounts before free names, 20 at
most. `following` is for the login. 429 past `SEARCH_PER_MINUTE` from one ip.

`async fn people`: `GET /api/people`: everyone with a row who is not live right now, as the `/people` page
(the live ones are its cards). Online first, then do not disturb, then offline; inside a
word, accounts before free names, the newest change first. The fake streams are people
too, when they are not live. 100 at most. `following` is for the login.

`type RecentRow`: name, verified, avatar, bio, following, status, ended_at, oauth_verified

`async fn recent`: `GET /api/recent`: the names whose last stream ended most recently, as home's recently
offline (under the live cards, before the people), newest end first, 12 at most. A row's
streams are its account's (`user_id`, so a rename keeps them under the name it has now) or,
for a free name, the name's; a stranger's stream under a name an account took later is
nobody's, `list_sessions`'s rule. One live again is not offline and is left out. `ended_at`
is when the last stream ended; `following` is for the login.

## `api/src/history.rs`

Durable chat lines. The chat process, and only when `CHAT_PERSIST` is on.

Redis stays the live tail: the last 500, the join history, the fan-out. Postgres
(`chat_lines`, created by the api process with the other tables) is the record you
scroll into and search. A line is written to redis first and inserted here after,
so a slow database never holds up the room.

Reads take one side or the other. Anything still inside the redis window comes from
redis. A request older than the oldest id redis still has comes from postgres, strictly
older than the id the client sent, so a line kept in both is not returned twice.

`GET /chat/<name>/before?id=`  older lines, oldest first. redis, then postgres.
`GET /chat/<name>/search?q=`   matching lines in this room, newest first. off: history is not kept.
                                the box takes filters among the words (`parse_search`): `from:<name>`,
                                `has:image`, `has:link`, `has:video`, `before:<day>`, `after:<day>`.
`GET /chat/<name>/by/<name>`   that account's verified lines in this room, newest first.
`GET /chat/<name>/around/<id>` a window around one line. redis when the id is still in
the stream, otherwise postgres. the panel scrolls to that id.

A server channel is the same four reads with the room `server/channel`:
`/chat/<server>/<channel>/before`, `search`, `by/<account>`, `around/<id>`. Its search is
the server's: every text channel the caller sees at once (groups.rs `visible_text_channels`),
each hit saying which channel it is in, unless `channel:<name>` among the words names one.

`const PAGE`: How many older lines one scroll asks for. The panel treats a short page as the end.

`const WINDOW`: Lines on each side of the one a search hit opens on.

`pub`: A search's box, in unicode scalars: filters and words together.

`pub`: A link, for `has:link`, as the panel draws one (LinkedText.tsx): `http(s)://` or `www.` at the
start of a word. The rooms keep it as a column (`has_link`, schema.sql, this same regex);
a direct message thread, too small for a column of its own, reads it over the text (dms.rs).

`pub`: A link to a video, for `has:video`: a postgres regex (case-insensitive) over the text of the
lines that have a link (`has_link`, schema.sql). The host or the file type has to sit
inside a link of that same shape, so a video-looking word beside an unrelated link
(`a.mov … https://example.com`) is not one. A file link may end a sentence: the punctuation
the panel leaves out of a link (`LinkedText.tsx`) is allowed before a space or the end, so
`clip.mp4.` and `(…/clip.mp4)` are videos and `x.movie` and `clip.mp4.example.com/a` are not.
This is the pasted kind: the hosts people paste, and the file types a browser plays. A video
uploaded to the chat (`video` on the row) matches `has:video` too, apart from this. Not the
schema's: a host is added here. The same providers the panel draws a player for
(`ChatEmbeds.tsx`: youtube, vimeo, a twitch channel, vod or clip, streamable, dailymotion,
tiktok, a file), and kick's clips and `.m3u8`, which it draws none for.

`const LINE_COLUMNS`: A line's columns, with its speaker's picture as it is now (`LineRow`), and its room last (a
server's search spans channels, and says which one a hit is in). The row keeps no picture:
a read joins `streamers` for it, by account for a verified line (so a rename keeps it for
the hold's length; after it, the letter: the name the page fetches by leads elsewhere) and
by name for the streamer's. A nick's line joins nothing: it is nobody's picture, whoever
holds that name later. A line out of redis gets the same from `chat::with_faces`, so the
two sides of the window agree.

`async fn viewer`: Who is reading: the login the cookie names (or nobody), and whether they are a site admin,
who sees every channel.

`async fn seen_room`: The room key of a server's channel, once it is there and this viewer sees it (groups.rs
`may_see_text`: a voice channel, or one kept to roles they do not hold, reads `no such
channel`, like one that is not there). `server` and `channel` as the url has them; the
clean server name comes back with the room.

`async fn room_of_channel`: The room key of a server's channel for the login the cookie names (`seen_room`).
With the viewer's account, for the lines' reactions (`reactions::Reaction::me`).

`async fn reader`: Who reads a stream's room, for the lines' reactions (`reactions::Reaction::me`) alone: anyone
may read one, so a cookie that does not read is a nick, not a refusal.

`async fn search_channel`: A server's search, from the channel on screen: every channel this viewer sees, or the one
`channel:<name>` names (`no such channel` for one they do not see, like one that is not
there). The channel in the path must be one they see, as for every read of it.

`pub`: `CHAT_PERSIST=1` (also true, on, yes). Anything else, including unset, is off.
Read from `chat::run` only, so the api process never turns this on.

`pub`: One accepted line, after its XADD. A conflict (the same id twice) is fine.
The caller logs a failure and does not tell the sender: the line is already in the room.

`pub`: The box as a search: trimmed, at most `SEARCH_CHARS`, its filters taken out from among the
words (`parse_search`), and asking for something. 400 `too long`, `say what to look for`,
or a filter's own words when its value will not read. A room's box and a direct message
thread's (dms.rs) are read the same way.

`async fn search_room`: A stream's room: one room, and `channel:` has nothing to name.

`async fn search_rooms`: The lines of `rooms` that match, newest first, 50 at most. `server`: the rooms are its
channels, and each hit says which (`Hit::channel`); a stream's room says none.

`struct Hit`: A search hit: the line, and for a server's search the channel it is in, so the page can
open it there. A stream's hits say no channel.

`fn hit_of`: The row as a hit: its room's channel when the search is a server's (the room is `server/channel`).

`pub`: What the one box asked for: the words looked for, and the filters taken out from among them.

`pub`: The box's text apart: a `key:value` word with a key this knows is a filter; the rest are the
words, kept in their order. Inside a quoted phrase nothing is a filter, so `"from: the top"`
is still a phrase; the phrase ends at its closing `"` even mid-word (`world",`), as
`websearch_to_tsquery` reads it. A known key with nothing after the colon, or a value it
cannot read, is a 400 that says what the key wants.

`pub`: A value the search binds after the room ($1), in the order `search_sql` named them. A thread's
search (dms.rs) binds the same three kinds after its pair.

`fn placeholder`: The next placeholder: the room is $1, so a bind pushed here is $(its count + 1).

`fn search_sql`: The query for a search: the rooms (one, or a server's channels, as a text array), then one
clause per thing asked, each bound in the order returned, and the limit last. `simple`: the
words as written, not stems; websearch so a quoted phrase stays a phrase. `has:image` and
`has:link` are the partial indexes of schema.sql; `has:video` is a regex over the linked
lines; the dates are the room index.

`async fn older`: Lines strictly older than `id`, oldest first, one page.
A full page from redis is still inside the window, and postgres is not asked.
A short page is the end of redis: the rest, older than the oldest redis line
returned (or older than `id` when redis had none), comes from postgres.

`async fn redis_older`: Newest first, strictly older than `id`, at most `limit`. Empty when redis has none
(the id is already past the window, or the room's stream does not have it).

`async fn redis_window`: The window from redis when `id` is still in the stream. None when it has been trimmed.

`pub`: One line of `room` by its id: from redis while the stream has it, else from `chat_lines`
(asked whatever this process's `CHAT_PERSIST`: the chat process is the one that writes it).
None when neither has it (never said here, or trimmed with nothing kept). Not faced: the
caller keeps it as said (a channel's pins, pins.rs). 400 `bad id` for a junk id.

`pub`: One account's verified lines in any of `rooms`, newest first, `limit` at most, from the kept
rows: strictly before `before` (`(ms, seq, room)`, the order they come in) when given. → each
with its room. A group's member log (group_mod.rs `member_messages`) adds what redis has.

`type LineRow`: `LINE_COLUMNS`, in order: `image` is the picture ids on the line (one, or several joined by
commas), then the speaker's face the join found, the room, and the oauth mark of the row the
join found (false when it found none: `u.id` and `r.id` are null, and so is no EXISTS), and
what the line answers (`chat::Reply` as json, null for nothing), and its video (`<video>,<poster>`,
`chat::Video`, null for none).

`async fn json_lines`: Lines of `room` as the reads answer them, with their reactions as they are now, `viewer`'s own marked.

`pub`: A redis stream id, `milliseconds-sequence`. Anything else is a 400, so a junk
id cannot become (0, 0) and read the whole table.

## `api/src/home.rs`

`api home`: the home page's list. One process that holds, in memory, every stream that is
live and how many are watching it, fed by the facts on the `events` stream (`live`,
`viewers`, `ended`), and answers `GET /api/streams` from that table: a snapshot, in the
order the streams came (first on, first shown). The pages take the snapshot once and then
the same facts over the events socket (`watch *`), so nothing polls. The ranking of the
home page, when there is one, lives here: this is the one place that sees every stream
and every count at once, and the pages already take their order from it. See docs/status.md.

The table is honest without trusting every fact to arrive: it is built from video's own
word at boot (`GET /viewers`, with postgres for `since` and the ✓) and reconciled against
it every HEAL_EVERY, so a fact missed, a video restart, or a stream the sweeper has not
ended yet is put right within that. What the streamer edits (bio, picture, the pictures
on the card) is not held here: joined from postgres per answer, so an edit mid-stream is
on the next load. This process reads redis and the database and asks video; it writes
nothing anywhere, and keeps no state a restart cannot rebuild in one `GET /viewers`.

`const REPLAY_MS`: How far back the tail starts after a (re)start: the facts of the gap, replayed onto a table
that was just rebuilt from video, so a stream that started as the process did is not missed.
Every fact applies the same way twice.

`const HEAL_EVERY`: Video's word against the table, this often. The facts are the fast lane; this is what makes them true.

`struct Live`: One live stream as the facts describe it. The card's editable parts are not here.

`pub`: `api home`: the table from video's word, the tail, the heal, and the listener.

`async fn list`: The snapshot: every live stream, first on first, with what the streamer put on the card.
`viewers` is null until video has said (a stream seconds old), as the pages expect.
Cloudflare and the browser may keep it 5s (docs/cloudflare-cache-rules.md): the facts on the
events socket carry everything after.

`async fn cards_of`: The editable half of a card, per name: bio and the picture's version. A name with no row has neither.

`async fn open_sessions`: The open session of each name, newest where there are two: its id, start and ✓.

`async fn tail`: One tail of `events`, on its own connection. Starts REPLAY_MS back and continues from the
last id across redis blips, the gateway's shape (events.rs).

## `api/src/janny.rs`

Jannies: who may clean a stream's chat (docs/jannies.md).

A site janny (added by an admin on /admin) may delete lines, ban and time out in every
stream's chat. A stream janny (added by the streamer on their own page's mod tab) may do the
same in that one stream's chat. Chat only: no janny touches a stream's pictures, its about
page, socials or calendar, nor dms or group channels (a group's owners have their own powers,
group_mod.rs).

Who outranks whom, on one stream (`Rank`): an admin (ADMIN_NAMES) over the streamer over a
site janny over a stream janny over everybody else. One may act on someone only when one is a
janny there at least and outranks them (`may_act`): a janny never touches the streamer's lines
or the streamer, nor anyone of their own rank or above. The streamer is a janny of their own
stream with every power, the only one besides an admin who names its jannies.

A stream is its `streamers` row, people are accounts: a rename keeps the jannies, the bans
and the log (0007-jannies.sql). Only a login can be banned or timed out; a nick's line can be
deleted. The chat (chat.rs `stream_refusal`) refuses a line or a reaction from someone banned
or timed out; a deleted line goes from redis and postgres, its copy into `mod_log`, and every
socket in the room hears a `delete` frame (through the room's reactions stream, chat.rs).

`const MAX_STREAM_JANNIES`: Stream jannies one stream may have.

`const MAX_SITE_JANNIES`: Site jannies the site may have.

`const ACTIONS_PER_MINUTE`: Moderation actions one login may take a minute (delete, ban, timeout, and their undoing), on
top of the route's tier (ratelimit.rs `MODERATE`): a janny's hijacked login cannot wipe a chat.

`const LOG_ROWS`: The log's page, newest first.

`pub`: Someone's standing in one stream's chat, lowest first: the order is the outranking.

`pub`: May `actor` delete a line of `target`'s, ban or time them out: a janny here at least, and
above them. Nobody acts on their own rank, so a stream janny never on another, a site janny
never on another, and nobody but an admin on the streamer.

`pub`: A stream by its name now: its row, and the account it is when the name is claimed.

`pub`: `user`'s rank on `stream`. `admins` are the ADMIN_NAMES accounts.

`pub`: For the watch grant's `can_moderate`: may this login clean `name`'s chat. A hint for the page
(which buttons to draw); every action asks again.

`async fn the_stream`: The stream in the path, 404 when no row has that name.

`async fn moderator`: A login, and its rank on the stream: one that moderates it, or 401 / 403.

`async fn owner_or_admin`: The streamer or an admin: who names a stream's jannies.

`async fn account`: An account by its name now: 404 for a free name or a dummy's.

`async fn delete_line`: `DELETE /api/streams/:name/chat/:id`: the line goes, from redis and postgres, with its
reactions; its pictures stay in the bucket. Its copy is the log's. Every socket in the room
hears `{"type":"delete","id"}`. The streamer's lines stay (`may_act`), but for the streamer
themselves (and an admin); a janny may delete their own. 204.

`async fn target`: The target of a ban or a timeout: an account, not the actor, outranked by them.

`async fn ban`: `POST /api/streams/:name/bans` `{ name, reason? }`: no line or reaction of theirs in the
stream's chat until lifted. 204.

`async fn unban`: `DELETE /api/streams/:name/bans/:user`: lifted. Any janny of the stream. 204, also when there was none.

`async fn timeout`: `POST /api/streams/:name/timeouts` `{ name, seconds }`: ten seconds to a week. Set again, the
new end stands. The chat refuses them with `timed out` and the wait. 204.

`async fn lift_timeout`: `DELETE /api/streams/:name/timeouts/:user`: lifted early. 204, also when there was none.

`async fn list_bans`: `GET /api/streams/:name/bans`: `{ bans: [{ name, by, reason, at }], timeouts: [{ name, by, until }] }`,
the running timeouts only, newest first. Any janny of the stream.

`async fn mod_log`: `GET /api/streams/:name/mod-log`: the last 100 things done in the stream's chat, newest first:
`[{ at, actor, action, target, line_id, snapshot }]`. Any janny of the stream.

`async fn list_stream_jannies`: `GET /api/streams/:name/jannies`: `[{ name, added_at }]`. The streamer or an admin.

`async fn add_stream_janny`: `POST /api/streams/:name/jannies` `{ name }`: one more stream janny, an account. Not the
streamer, not a dummy, twenty at most. 204, also when they were one already.

`async fn remove_stream_janny`: `DELETE /api/streams/:name/jannies/:user`: one fewer. 204, also when they were not one.

`async fn list_site_jannies`: `GET /api/jannies`: the site jannies, `[{ name, added_at }]`. Admins only.

`async fn add_site_janny`: `POST /api/jannies` `{ name }`: one more site janny. Admins only. 204, also when they were one.

`async fn remove_site_janny`: `DELETE /api/jannies/:user`: one fewer site janny. Admins only. 204.

## `api/src/notify.rs`

Notifications: a login's inbox of the last 30 things that happened to them. See
docs/notifications.md.

Four kinds. `live`: someone they follow went live (one row per session: video retries
`attached`, and a heartbeat that takes a lapsed key back is the same stream). `follow`:
someone followed them (one row per follower among the rows kept: a follow, unfollow,
follow loop is one line). `dm`: a friend wrote (the newest line from them is the one
unread row; reading the thread reads it). `chat`: someone wrote in a channel of a group
they are in (the newest line in the channel is the one unread row for it; opening the
channel reads it; a channel can be muted, `channel_mutes`, and then writes none). Which
kinds are kept is the login's own, `streamers.notify`, a json document of the kinds
turned off; a kind not in it is on.

One table of rows, `notifications (user_id, kind, actor_id, ...)`, both ids (docs/ids.md),
so a rename keeps the inbox and the actor shows under the name they have now. The api is
the writer of three kinds and the chat process (chat.rs, the same binary) of `chat`: a
row, then a `notify` fact on the `events` stream naming every login it reached and their
row ids, and the gateway (events.rs) pushes the same row to each one's own sockets, the way
a direct message reaches every device of its reader. Reading is http. Every write clips
the login's rows to the last KEEP: an inbox is a short memory, not a log.

`pub`: Rows kept per login. Older ones go with every write.

`const TEXT_CHARS`: A direct message's, or a channel line's, words in its row: one line of the list, not the whole message.

`pub`: What can happen to a login: the `kind` column, the settings' keys, the frame's `kind`.

`pub`: Which kinds a login keeps, as the row's `notify` document reads: every kind on unless the
document says `false` for it. The settings tab's four switches, and the json of the api.

`struct Actor`: Who did it, as the row is drawn: the name now, the ✓, the picture.

`struct Made`: What one write made: a row per login reached, and when. The fact carries all of it.

`async fn clip`: Every login's rows past the newest KEEP go. One statement for any number of logins.

`async fn tell`: The fact, once per write: the gateway pushes a frame per login named in `to`. The redis
handle, not the api's state: the chat process writes a kind of its own (`channel_line`).

`type LiveRow`: id, login name, user id, at (ms)

`pub`: Someone went live (`attached`, main.rs): a row for every login that follows the name and
keeps `live`, unless this session already made theirs. Then the one fact for all of them.
Never fails the call it rides on: a miss is logged, the stream is live all the same.

`pub`: `follower` followed the login `followed` (follows.rs, once the edge is new): one row, if they
are a login who keeps `follow` and have none from this follower among the rows kept.

`pub`: `from` wrote `text` to `to` (dms.rs, once the line is kept): the newest line from a friend
is the one unread row from them, so a conversation is one line of the list that says what
they said last, not thirty. An unread row from them goes as the new one comes, including
when two messages land at once; a read one stays, it is history.

`pub`: `reader` read their thread with `peer` (dms.rs `mark_read`): what `peer` wrote is not news
any more. The `dm_read` fact that follows the mark tells the reader's other devices.

`pub`: The chat's room key for a channel, the one on the row and in the fact (chat.rs `room_key`
without the prefix): `<server>/<channel>`.

`pub`: `actor` said `text` in `channel` of `server` (chat.rs `accept`, once redis has the line, on
a task of its own so the socket does not wait): a row for every member of the server but the
speaker who keeps `chat` and has not muted that channel. The newest line in a channel is the
one unread row for it, the dm rule per room rather than per writer: a busy channel is one
line of the list that says who spoke last and what they said, not thirty; the unread row for
the room goes as the new one comes, a read one stays. A channel kept to roles (groups.rs
`sees_sql`) is news only to the members who see it; `admins` are the site admins, who see
every channel. Never fails the line: it is in the room already; a miss is logged. The chat
process has no `AppState`, so this takes the handles.

`pub`: `reader` has `room` (`<server>/<channel>`) on screen (`PUT /api/groups/:group/channels/:channel/read`):
what was said there is not news any more. True when a row was still unread; the `chat_read`
fact the caller publishes then tells the reader's other devices.

`type ItemRow`: id, kind, actor name, actor verified, actor avatar, at (ms), read, text, session, actor id, room

`async fn list`: `GET /api/notifications`: `{ settings, items }`. The login's rows, newest first, the last
KEEP, each with who did it as they are now (`name`, and `actor`, the id), whether it has
been read, and a `chat` row's `room` and its group's `badge` (null once the group is gone); and which kinds are kept. 401 for nobody.

`async fn read`: `PUT /api/notifications/read` with `{ id }`: the login has seen everything up to that row,
on this device. 204. A `notify_read` fact tells the login's other devices, when anything
was still unread.

`async fn remove`: One of `user`'s rows goes. True when there was one: another login's row is never touched,
however its id is asked for.

`async fn dismiss`: `DELETE /api/notifications/:id`: the login dismissed a row by hand (the × on it). 204, and a
`notify_removed` fact tells the login's other devices to drop it too. 404 for a row that is
not theirs or is gone already (the same answer: whose a row is never leaks). 401 for nobody.

`struct SettingsBody`: The body of a settings save: a kind left out stays on.

`async fn settings`: `PUT /api/notifications/settings` with `{ live, follow, dm, chat }`: which kinds the login
keeps from now on, replaced whole. 200 with the settings as kept. What is already in the
inbox stays. 401 for nobody.

## `api/src/pins.rs`

A group channel's pinned lines (docs/groups.md "pins"). Group channels only: a stream's chat
and a dm have none. A pin is (channel, line, who pinned it, when), at most `MAX_PINS` a
channel, and keeps the line as it was said (`channel_pins.line`), so a pin outlives the
room's stream trimming the line. The channels power pins and unpins (an owner and a site
admin always may: `group_mod::allows`); whoever sees the channel reads its pins. Each change is
a `pin` or `unpin` fact on the group's topic, with the channel and the line's id alone: the
topic is everyone's, and a channel kept to roles keeps its words to them.

`pub`: How many lines one channel keeps pinned. One more is a 400 until one is unpinned.

`async fn seen`: The server, the channel and its room key, once the channel is there and this viewer sees it
(`groups::may_see_text`): a voice channel, or one kept to roles they do not hold, reads
`no such channel`.

`pub`: The ids pinned in each of `channels` of `server`, newest pin first: the room's answer
carries them (`pins`), so the header's count and the lines' marks need no request.

`type PinRow`: line, speaker_id, pinned_by (their name now), pinned_at (unix ms)

`async fn pins_json`: The lines as kept, faced as they are now (`with_faces`), each with who pinned it and when.

`async fn list`: `GET /api/groups/:group/channels/:channel/pins`: the channel's pinned lines, newest pin
first, each a chat line as the messages have it plus `pinned_by` (a name, null for an
account since gone) and `pinned_at` (unix ms): `{ pins: [...] }`. Whoever sees the channel,
logged in or not; 404 `no such channel` for one they do not (or that is not there).

`async fn pin`: `POST /api/groups/:group/channels/:channel/pins/:message`: pin the line with that id. The
channels power (an owner, a site admin). → the pin, as the list has it; the same when it was
pinned already. 401 nobody, 404 `no such channel` (or one this login does not see), 403
without the power, 400 `bad id`, 404 `no such line` (not this channel's, or long gone),
400 at `MAX_PINS`. A `pin` fact (`channel`, `id`) to every room open.

`async fn unpin`: `DELETE /api/groups/:group/channels/:channel/pins/:message`: unpin it. 204, also when it was
not pinned. The channels power; 401, 403, 404 and 400 `bad id` as for a pin. An `unpin`
fact (`channel`, `id`) when one went.

## `api/src/presence.rs`

Presence: the word next to a name (`offline`, `online`, `dnd`, `streaming`), the choice
behind it (`streamers.status`: `online`, `dnd`, `invisible`), and the redis stream every
fact about a name goes through (`events`). See docs/status.md.

The word is derived, never stored: live (video's answer, else the `live:` key) wins; else
a socket for the name is open on the gateway (`seen:<name>`, a sorted set of socket ids
scored by the time they were last refreshed) and the choice says which word; else offline.
The gateway (events.rs) derives it the same way when it pushes; this file is the one place
the rule lives, so the two cannot drift.

`pub`: The stream every fact goes through: `live`, `ended`, `status` from the api, `seen` from the
gateway. One structure that is both the history and the live tail, with ids, so a gateway
that restarts resumes from where it was (docs/chat.md makes the same argument for the rooms).

`pub`: Entries kept. Mirrors the pages' ring; `redis-cli XRANGE events - +` is the server-side inspector.

`pub`: A socket's member in `seen:<name>` counts while its score is this fresh. The gateway refreshes
every 30s, so a member nobody refreshes (a gateway that died without its drain) lapses on its own.

`pub`: The set itself goes when nothing writes it for this long.

`pub`: The word next to a name. Read, never chosen.

`pub`: The one you pick. A column and a json field; it reaches nobody else: watchers only ever get the derived word.

`pub`: Unix milliseconds: the scores in `seen:<name>` and the `since` of a `live` entry.

`pub`: The rule, in one place: live wins; a socket open and the choice decides; nothing, offline.

`pub`: Is a socket for the name open on some gateway: a member of `seen:<name>` scored within the
window. `ZCOUNT` with the floor, not `ZCARD`: a stale member is not here even before the
gateway's next lazy trim removes it.

`pub`: The choice. `online` for a name with no row, and for a row older than the column (its default).

`pub`: The word, `live` already known by the caller (video's answer, else the key: `is_live`).

`pub`: The word, asking video first like `watch` does.

`pub`: One fact onto the stream. It never fails the request it rides on: a stream that cannot be
written is logged, and the gateway's 30s recheck heals what a watcher missed.

`pub`: A stream started: video has the publisher (`attached`), or a heartbeat took a lapsed key
back. `card` is what a home card draws without asking anything (`verified`, `avatar`, `bio`,
`thumbs`), carried in the fact so a thousand home pages do not each ask the api when
someone goes live. The gateway forwards it as it is; the home service reads the ✓ off it.

`pub`: How many different addresses are receiving a stream, as video counts them (docs/viewers.md),
whenever it moves: video says so at most once a second per stream. To the name's watchers
and to every home page, through the gateway, and into the home service's table.

`pub`: A stream ended. `by`: `stop` (the page, or video on the publisher's behalf), `sweep` (a tab that vanished).

`pub`: The choice changed.

`pub`: An account changed its name (docs/ids.md). The gateway re-keys its sockets of the old
name and tells them, and the old name's watchers, where it went.

`pub`: A direct message (docs/dms.md), its row written. `name` is who it is to, the gateway's
key; it goes to the sockets of both names, so the writer's other devices see it too.
`from_id` is the writer's account, so the open thread still matches after a rename.
The text rides in the fact: the stream is the one road to every gateway, and a thousand
entries deep it is gone. So do the pictures' ids (`images`, joined by commas, left out when
there are none): the bytes stay in the bucket, the page fetches them by id.
`reply` is the quote of the line it answers (dms.rs `quote_json`), json in the fact. `video` is
the line's video and its poster (`<video>,<poster>`, left out for none).

`pub`: A login's emoji on a direct message, or off it (docs/dms.md "reactions"), its row written. `name`
is the other side, the gateway's key; it goes to the sockets of both names, as the line did.

`pub`: A login read a thread up to a line, on one device: its other devices drop their count.
`peer_id` is the account they read, so a rename still matches the inbox row.

`pub`: A notification (docs/notifications.md), its rows written: `name` is who did it (the
actor, with the ✓ and the picture the row is drawn with), `actor` that account's id,
`to` a json object of login name → that login's row id. One fact for a go-live with a
hundred followers, or a line in a channel with a hundred members; the gateway pushes one
frame per name in `to`, to that name's own sockets. The words of a direct message or a
channel line ride in it like a `dm`'s do; `room` is a `chat` row's `<server>/<channel>`.

`pub`: A login saw its notifications up to a row, on one device: its other devices drop their count.

`pub`: A login dismissed one of its notifications by hand, on one device: its other devices drop the row.

`pub`: A login had a channel on screen, on one device (`room` is `<server>/<channel>`): the `chat`
rows for it are read, and its other devices drop their count, the way a `dm_read` does.

`pub`: A group changed (docs/groups.md): `name` is the group, `what` says how (`joined`, `left`,
`channel`, `role`, `about`, `deleted`, …) and `data` is the change as json, carried whole so
the gateway forwards it without knowing its shape. To the sockets watching `group:<name>`:
a room on screen follows every change without asking the api again.

`async fn put_presence`: `PUT /api/streamers/:name/presence` with `{ status }`: the choice, through the bio's gate (a
free name is anyone's, a claimed name its login's, a reserved name the dummy box's). The api
is the one writer of the column; the gateway reads it and tells every socket of the name.

## `api/src/reactions.rs`

Reactions: an emoji from a short list on a line, discord's (docs/chat.md "reactions", docs/dms.md),
or a group's custom emote (emotes.rs) by its id, for a reactor in that group.

The same everywhere a line is drawn: a stream's chat and a group's channel (chat.rs, a `react`
frame on the room's socket) and a direct message thread (dms.rs, `PUT /api/dm/:name/react`).
One row is one login's one emoji on one line (`chat_reactions`, `dm_reactions`): the key is
the "once per emoji per person" rule, so a second `on` is no change. A line holds
`MAX_KINDS` different emoji at most; a new one past that is `too many reactions`, and one
already there may still be added to. Only a login reacts: the row is an account, read back
under the name it has now, so a rename keeps every reaction.

The reactions are never kept with a line: every read of lines asks for them (`with_reactions`
for a room's, the join in dms.rs `LINE_SELECT` for a thread's), and a change goes out as a
frame of its own (`react`, `dm_react`) that the pages apply to the line they hold.

`pub`: The emoji a line may wear: a curated grid, no free text, so a reaction is never a way to say
what the box would refuse. The pages draw the same list in this order (frontend
`shared-components/reaction-list.ts`), the first six as the picker's quick row.

`pub`: Different emoji on one line, at most.

`pub`: The names a reaction carries, the first to react first: the chip's tooltip lists them, and says
how many more past these.

`pub`: The words for an emoji not on the list.

`pub`: The words for a new emoji on a line that has `MAX_KINDS` already.

`pub`: The words for a socket with no login behind it.

`pub`: One emoji on a line: how many reacted with it and the first of them by name (`NAMES_SHOWN`),
in the order they reacted. A line's reactions are in the order each emoji first came.

`pub`: The words for a custom emote the reactor is not in the group of.

`pub`: A custom emote's id, when the reaction is one: the id as the api writes it (lowercase, with its
dashes), so one emote is one reaction however it was typed.

`pub`: A reaction as it is kept: one off the list as it is, an emote by its id written the api's
way. None for anything else (`NOT_A_REACTION`). The shape alone: whether the reactor may use
the emote is `may_put`'s.

`pub`: Whether `user` may put `emoji` (already `shaped`) on a line: anyone may, one off the list; a
custom emote only a member of its group (emotes.rs `usable`). Taking one off asks nothing: an
emote's group left, or the emote deleted, a reaction still comes off.

`pub`: An emote deleted (emotes.rs `remove`): its reactions go with it, everywhere.

`pub`: What a reaction asked for came to.

`const LOCK_CLASS`: The class of the advisory locks a line's new reactions take (`lock_line`): a number of its own,
apart from the schema's lock.

`async fn lock_line`: Holds the line until the transaction ends, so two new emoji at once read the cap one after the
other and the line never passes `MAX_KINDS`. `line` is a key of its own per line: the room and
the id, or the thread's line id.

`pub`: One login's `emoji` on a room's line on or off. The line is the caller's to have found in the
room. The cap is read in the insert itself, under the line's lock (`lock_line`).

`pub`: `set_line` for a direct message: the line is the caller's to have found in the thread. The same
lock, keyed `dm <id>`, which no room's `<room> <id>` is (a room's name has no space).

`type ReactionRow`: room, line id, emoji, how many, the first names, whether the viewer is one

`pub`: The reactions on room lines, each line with its room (a server's search spans channels): one
query for the batch. Like the faces (chat.rs `with_faces`), a database that does not answer,
or not in 2 s, leaves the lines without: they still go out, a little behind. `viewer` is who
the lines go to (`Reaction::me`); none for a nick.
