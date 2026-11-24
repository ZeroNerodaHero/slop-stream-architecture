# /rt: one always-on socket for chat and events

built, server side. one websocket per browser carries every chat topic a page shows and every events topic (presence, the home feed, a group's room), so a page change is a frame, not a new socket. it lives in the chat process (`api chat`, the `chat` container, `api/src/rt.rs`), which also runs an `events::Gateway` of its own: the `events` stream is read without a group, so a second reader is safe, and a chat room is a redis stream any process can tail. video `/ws` and `/voice` are their own sockets and stay so. the legacy `/chat/...` and `/events` sockets keep working beside it.

the words: a **topic** is anything a socket can subscribe to. never a "room" on the wire (a room is the chat's own word for a stream's or a channel's line store).

## topics

| topic | what it carries |
| --- | --- |
| `chat:<name>` | a stream's chat: `message`, `count`, `react`, `delete` |
| `chat:<server>/<channel>` | one channel of a group |
| `chat:<server>/*` | every text channel of a group the socket may see (at most 64), each frame naming its own `chat:<server>/<channel>` |
| `presence:<name>` | `presence`, `live`, `ended`, `viewers`, `renamed` for that name |
| `streams:*` | every name's `live`, `ended`, `viewers`: the home feed |
| `group:<name>` | every `group` fact of that group and `live` / `ended` of its members |

events frames are the same bytes `/events` sends (`me`, `dm`, `notification`, …): they name what they are about, so they carry no topic. the socket's own identity (`me`, dms, the inbox) needs no topic.

## frames

browser to server:

- `{"type":"hello","nick"?,"session"?,"token"?,"bot"?,"v":1}` first, within 10s. the login is the cookie on the upgrade.
- `{"type":"sub","rev":N,"topics":[…],"since"?:{"chat:x":"<id>"}}` the **whole** set the browser wants, never a delta. `rev` rises with every frame; a frame whose `rev` is not above the last one applied is a duplicate or arrived late and is dropped. the server diffs the set against what it holds, so a lost frame can never leak a subscription: the next set says it all. `since` replays the lines after that id for each chat topic named (up to 100; a `gap` with no `missed` when there may be more, so the page asks `GET /chat/.../before` or its history route). `fresh`, a list of `chat:<server>/*` topics held, has those wildcards look up their channels again now (a channel was made or opened to this viewer); without it a wildcard is looked up again at most once a minute, on the next set. `peek`, a list of chat topics in the set, holds those topics as peeks: the socket joins them (lines, counts, `since` replay, a per-ip slot, a topic slot) but is not a viewer, so the room's count does not move. a room is counted when any topic in the set that is not a peek covers it (a peeked channel under a held wildcard counts). the next set without the topic in `peek` takes it over and counts it.
- `{"type":"say","rid":"r1","topic":"chat:x","text":…,"images"?,"video"?,"reply"?}` and `{"type":"react","rid":"r2","topic":"chat:x","id":"<line>","emoji":…,"on":true}`. the topic must be subscribed. answered by `{"type":"ack","rid":"r1","id"?:"<line id>"}` or `{"type":"nack","rid":"r1","error":…,"wait"?:ms}`.
- `{"type":"auth","ticket":"<32 hex>","nick"?}` changes who the socket is without a reconnect (below).

server to browser:

- `{"type":"ready","v":1,"beat":20000}` after the hello.
- `{"type":"subbed","rev":N,"topics":[…],"refused":[{"topic","error"}],"evicted":[…]}` after every applied `sub` (and after an `auth`): the authoritative set. the browser compares it with what it asked for at that `rev`; a topic missing that is neither refused nor evicted is a mismatch, and the browser sends its set again with a new `rev`.
- chat frames, each with its `topic`: `message` (the line, flattened), `count`, `react`, `delete`.
- `{"type":"gap","topic":…,"missed"?:n}`: this socket's reader fell behind that topic's fan-out, or a `since` had more than it replays. the page fills it over http.
- `{"type":"behind"}`: the socket's outbound queue (1024 frames) filled; what was queued is dropped. the page sends its set again with `since` for every chat topic; the server tells it every watched name's word again and every room's count.
- `{"type":"beat","at":ms}` every 20s, beside a websocket ping: the ping keeps the server's 45s cut away, the beat is what the page's own 45s watchdog sees (a page cannot see pings).
- a close with 1001 when the process restarts.

## caps, per socket

- 16 chat topics. a wildcard counts as one. a new topic past 16 evicts the oldest-joined one (`evicted`); an evicted topic stays out while it is still wanted and there is no room, and comes back by itself when a slot frees. a topic the set drops is forgotten.
- 64 channels per wildcard.
- 1000 presence topics. the rest are refused `too many topics`.
- 60 new topics a minute, for chat and group and `streams:*` topics (each costs a database read or a reader). presence topics are bounded by their count, not by rate: a sidebar asks for every follow at once. refused `slow down`; the next set (the browser resends every 60s) takes them.
- 120 `sub` frames a minute. past that a frame is held, and a newer one replaces it: the last set wins, applied when the minute turns.
- 64 KiB a frame (a set of 1000 names fits).
- 20 `/rt` sockets per ip in a process; the per-room 8 per ip of the legacy chat applies too.

## who the socket is

the cookie at the upgrade decides who it is at first. a login or a logout in that browser does not reconnect: the page asks `POST /rt/ticket` (the chat process, the current cookie), gets `{"ticket","ttl":30}`, and sends `auth` with it. a ticket is a redis key `rtticket:<32 hex>` holding the account id (empty for nobody), set with `EX 30 NX` and taken with `GETDEL`, so it works once, for 30 seconds, on any chat process. on `auth` the socket's identity becomes the ticket's: its events seat moves to the new name (`LAST_OUT` for the old one, `FIRST_IN` for the new, a fresh `me`), every group topic is checked again, every channel and wildcard topic is resolved again with the new viewer, and the ones it may no longer see are dropped and listed in `refused`. the per-room speaker is worked out again on the next line.

## what holds a subscription

every chat room a socket follows is a `Lease` in the room's set plus a forwarder task, kept together in one value; dropping it (a topic leaves the set, the socket closes, the task panics or is aborted) gives the room back and stops the forwarder. the events side is the socket's `Seat`. counts are read off the sets. each line is serialized once, by the room's reader, and the same bytes go to every `/rt` subscriber; each events fact is serialized once for all its sockets.

## the browser side

off by default for now. `?rt=1` on any page turns it on and keeps it on in `localStorage` (`rt`), `?rt=0` turns it off. with it off the page uses `/chat/...` and `/events` as before.

- **topics a page holds.** `useTopic(topic)` (`frontend/src/infra/use-topic.ts`) holds a topic while the component is mounted. underneath is a refcount (`frontend/src/infra/rt/refs.ts`): `acquire` returns a release that works once, however often it is called, so a StrictMode double mount nets zero. changes in one task are coalesced into one set, and only a set that changed is sent. a chat room (`ChatRoom` in `chat-atoms.ts`) holds `chat:<name>` or `chat:<server>/*`; the events link holds `presence:<name>`, `streams:*` and `group:<name>` for what it watches.
- **one socket for every tab.** a SharedWorker (`frontend/src/infra/rt.worker.ts`, named `rt-<build>`) owns the socket; the logic is `RtCore` in `frontend/src/infra/rt/core.ts`, plain code with the clock and the socket passed in. each tab sends its whole set; the worker sends the union, and only when the union changes. a tab pings every 15s; one silent for 60s is dropped, and `pagehide` says bye at once. with no tab left the socket stays 5s, for a reload. a tab that joins a set already held gets the last `subbed` straight away.
- **version check.** a tab attaches with its build; a worker of another build answers `stale` and the tab runs its own socket instead (a deploy while old tabs are open).
- **fallback.** no SharedWorker, a worker error, or no answer within 2s: the tab runs the same `RtCore` in the page, on a socket of its own.
- **keeping the set right.** the set goes again on every reconnect, every 60s, and when the tab gets focus; a `subbed` that is missing a topic it was not refused or evicted is a mismatch, and the set goes again 1s later.
- **watchdog and backoff.** 45s with no frame (beats come every 20s) and the socket is cut. a reconnect waits 250ms, doubling up to 30s, plus up to half again at random; a 1001 close (a restart) waits a random 0 to 1.5s instead and does not count as a failure.
- **history.** a room subscribes first, then loads its history over http, then merges, deduplicating by id; the set it sends after carries `since` with the newest id it has, and every reconnect does the same, so the server replays the gap. a `gap` is filled over http (the room's newest lines, or the group's).
- **say and react.** both are asks with a `rid`; the `ack` or `nack` comes back to the tab that asked. 10s with no answer, or a socket that closes first, is a `nack` (`chat is down`). a nack fails that one pending line and puts the text back.
- **press.** a plain press (`pointerdown`, so mouse down and touch start) on a link to a watch page or a group calls `pressTopic` with that page's chat topic (`warmChat`, `warmServerChat` from `infra/prefetch.ts`). it is a peek in the refcount: held for 5s (`PEEK_TTL_MS`), and a second press restarts the 5s. if the page mounts in that time, its `acquire` takes the peek over: the topic never leaves the set, the server is told it is no longer a peek, and the room is already live, its lines already in. if not, the peek ends and the topic leaves the set. a topic already held is not peeked. the worker sends a topic as a peek only when every tab that holds it is only peeking.
- **who.** a login, a logout, or a new guest nick sends `identify`: the worker gets a ticket and sends `auth`, and the socket stays up. if the ticket fails the socket reconnects with the new hello.

perfdebug: with `?perfdebug=1` (or `localStorage.perfdebug = '1'`) a room prints `[rt perf] chat:<name> press 0 · mount … · subbed … · history … ms` once it is subscribed and its history is in, and every say prints the time to its `ack` or `nack`. without the flag the same points are `performance` marks and measures named `rt:<topic>:<phase>` and `rt:ack:<key>`.

tests: `npm test` in `frontend` runs `frontend/tests/rt-*.test.ts` with node (the refcount, the worker's union, dead tabs, stale builds, mismatches, backoff, restarts, the watchdog, since and behind, asks, flapping a topic 1000 times, peeks: the ttl, a takeover, a press in StrictMode, the worker's peek union). the rust tests hold that a peek is not counted, that a takeover counts it, that a peek takes an ip slot, and which rooms a set counts. `tests/rt-live.test.ts` runs only with `RT_URL` set to a running `/rt`; it also checks, on a real server, that a peek leaves the count alone until it is taken over. `test/rt-page.js` (in `scripts/test.sh`) uses real browsers: two tabs and a second browser in one room, lines between them, one socket per browser, a closed tab, a page without SharedWorker, and a press on a link that leaves the count alone until the page opens, live on its mount. with `LOCAL=1 RT_SOCKETS=<chat port>` it also counts the sockets with `ss`.

## deploy

the `chat` container (api image) serves `/rt` and `/rt/ticket`; caddy routes `/rt` and `/rt/*` to `chat:4100` (`frontend/Caddyfile`), rate limited as `rt-socket` (60/min/ip) and `rt-ticket` (30/min/ip) in `api/src/ratelimit.rs`.
