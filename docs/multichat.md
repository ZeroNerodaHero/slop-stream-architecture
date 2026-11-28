# twitch and kick chat in slop chat

while a streamer restreams, the api reads their twitch and kick chat and writes each line into the same
redis stream as slop chat (`chat:<name>`). it is read only: nothing is sent back to the platforms, and
there is no moderation there. youtube is not done yet.

## who sees it

`streamers.external_chat` (migration 0028) is `everyone`, `studio` or `off`. it starts as `everyone`, so
viewers of a streamer with twitch or kick switched on see those lines without the streamer doing anything.

- `everyone`: every viewer gets the lines
- `studio`: only the streamer, in the studio
- `off`: nothing is read at all

the gate runs on the server: the legacy `/chat/<name>` socket, the `rt` chat topic, history and the
since-replay all drop platform lines for someone who should not see them. the streamer flips it in the
studio's destinations fold (`platform chat`).

## where it comes from

- twitch: an eventsub websocket (`wss://eventsub.wss.twitch.tv/ws`) with one `channel.chat.message`
  subscription made with the streamer's own token (`user:read:chat`). keepalive timeouts, reconnect
  messages and revocations are handled, and a broken socket comes back after 1, 2, 4, 8, 16 then 30 s
- kick: the `chat.message.sent` webhook to `POST /api/hooks/kick`. the api makes the subscription with
  the streamer's token (`events:subscribe`) when restreaming starts and removes it when it stops

the kick webhook checks the `Kick-Event-Signature` header (rsa pkcs1 v1.5, sha256 over
`<message id>.<timestamp>.<body>`) against kick's public key from `https://api.kick.com/public/v1/public-key`.
the key is fetched, not pasted in, cached for an hour, and fetched again if a signature fails and the cached
one is older than five minutes. anything that does not check out is refused: no key means 503, a bad
signature 401, a missing header 400, a body over 64 kb 413. messages older than ten minutes are dropped with
a 200 so kick does not retry them.

## the background task

`relay::begin` wakes one task per restreaming streamer, and a sweep every 20 s picks up any that a restart
lost. the task takes `xchat:lock:<user>` in redis (45 s, renewed) so only one api replica reads a channel.
it stops two minutes after restreaming ends, then drops the kick subscription and its keys.

status per destination sits in `xchat:status:<user>` for a minute and shows up as `chat` on each row of
`GET /api/destinations`, and as `chat live` / `chat error: ...` in the studio fold.

## a line

platform lines are ordinary chat entries with `streamer=0`, `v=0` and extra fields: `src` (`twitch` or
`kick`), `xid` (the platform's message id), `xu` (its user id), `xc` (name colour), `xb` (badges) and `xp`
(text and emote parts). on the wire they carry `source: { platform, id, user, color, badges, parts }`.
emote images only come from `static-cdn.jtvnw.net/emoticons/` and `files.kick.com/emotes/`, checked on the
way in and again in the browser.

a message id is kept for 15 minutes (`xmsg:<platform>:<id>`, plus a small in-memory list), so a redelivered
webhook or a twitch reconnect never shows a line twice.

## in the browser

`GET /api/streamers/{name}/chat-sources` says which platforms a viewer may see. when there is at least one,
the chat header gets a picker: the slop logo (this site only), twitch and kick. it filters the lines to that
source and is saved in localStorage (`settings.chatSource`). with no platforms the picker is gone and nothing
is filtered. on phones and in the studio it sits in a thin bar over the lines.

platform users have no picture, so their avatar is the platform's icon, and each of their lines ends with the
platform's logo.

## routes

| route | what |
| --- | --- |
| `POST /api/hooks/kick` | kick's webhook. signed, no login. its own rate limit tier (6000 a minute per ip) |
| `GET /api/streamers/{name}/chat-sources` | `{ sources: ["twitch", "kick"], external_chat }`, the mode only for the owner |
| `PUT /api/destinations/external-chat` | `{ mode }`: `off`, `studio` or `everyone` |

## setting it up

the kick app's webhook url is `https://nodentity.xyz/api/hooks/kick` (`PUBLIC_URL` + `/api/hooks/kick`),
with webhooks switched on in kick's developer settings. caddy already sends `/api/*` to the api. nothing new
goes in `.env`: it uses the twitch and kick app keys the destinations already need. a streamer who connected
before `user:read:chat` / `events:subscribe` were asked for has to reconnect.
