# jannies

who may clean a stream's chat. chat only: no janny touches a stream's pictures (thumbnails, the offline picture, scene assets), its about page, socials or calendar, nor direct messages or a group's channels (a group's owners and roles have their own powers, `groups.md`). code: `api/src/janny.rs`, the tables in `api/migrations/0007-jannies.sql`.

## who

- **admin**: a login in `ADMIN_NAMES`. everything below, everywhere, and names the site jannies on `/admin`.
- **the streamer**: the account the stream's name is (or a line said with the go-live grant). everything in their own chat, and names its jannies on their own page's `mod` tab.
- **site janny**: added by an admin. may delete lines, time out and ban in every stream's chat.
- **stream janny**: added by the streamer (up to 20). the same, in that one stream's chat.

the order is the outranking: admin > streamer > site janny > stream janny > everyone else. one may act on someone only when one is a janny there at least and is above them (`may_act`): a janny never deletes the streamer's lines or bans them, nor anyone of their own rank or above (a stream janny never another stream janny or a site janny; a site janny never another site janny or an admin). a janny may delete their own line. stream and people are rows (`streamers.id`), never names, so a rename keeps the jannies, the bans and the log.

## what

- **delete a line**: `DELETE /api/streams/:name/chat/:id`. the line goes from redis (`XDEL chat:<name>`) and postgres (`chat_lines`, its `chat_reactions`); its pictures stay in the bucket. its json, as the chat had it, is the `mod_log` row's `snapshot`. every socket in the room gets `{"type":"delete","id"}` (through the room's reactions stream, `chatr:<name>`, as a `del` entry, so the readers tail no third stream), and the panels drop the line.
- **ban**: `POST /api/streams/:name/bans {name, reason?}`, lifted with `DELETE /api/streams/:name/bans/:user`. **timeout**: `POST /api/streams/:name/timeouts {name, seconds}` (10 s to a week; set again, the new end stands), lifted with `DELETE /api/streams/:name/timeouts/:user`. an account only: a nick's line can be deleted, a nick cannot be banned. the chat refuses a banned login's line and reaction with `you are banned from this chat`, a timed out one's with `timed out` and the ms left (the panel counts it down), read from postgres at each line (`chat.rs` `stream_refusal`; the database not answering is `chat is busy`, never a skipped ban). the sockets already open stay open: they read, they cannot speak.
- **lists**: `GET /api/streams/:name/bans` (`{bans, timeouts}`, the running timeouts only) and `GET /api/streams/:name/mod-log` (the last 100, newest first) for any janny of the stream; `GET|POST /api/streams/:name/jannies`, `DELETE /api/streams/:name/jannies/:user` for the streamer or an admin; `GET|POST /api/jannies`, `DELETE /api/jannies/:user` for an admin.
- the watch grant says `can_moderate` (the streamer, their jannies, a site janny, an admin): which buttons the page draws on the chat's lines. every action asks again.

## limits

the writes are the `moderate` tier (`rate-limits.md`, 120 per 10 minutes per login), and on top of it 30 deletes, bans, timeouts and lifts a minute per login (`rl:janny:<id>`), so a janny's stolen login cannot wipe a chat.

## pages

- the chat's lines (`ChatMod.tsx`, on the watch page and the go-live page): delete, and on a login's line time out (10 minutes) and ban, each after a yes. not on the streamer's lines or my own.
- the `mod` tab, right of `socials`, on my own page only (logged in as the name): add or remove my jannies by name, lift a ban or a timeout, the log.
- `/admin`: the site jannies, add by name, remove.
