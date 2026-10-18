# streams

background from before the build. the real layout is in `new-plan-human.md` and `new-plan-llm.md`. the boxes below are the big-picture idea, not the repo.

upload once. a server copies it out.

two ways to copy.

```mermaid
flowchart TB
  you[you upload once]

  you --> call[call]
  you --> live[stream]

  call --> friends[a few friends get the packets]
  live --> cdn[a cdn serves the crowd]
```

| | call | stream |
|---|---|---|
| like | discord cam | twitch |
| sends | everyone | one person |
| watches | the room | the crowd |
| delay | ~0.2s | a few seconds |
| server | copies packets | makes files |

---

## call

each person uploads once. the server copies packets. it does not decode.

```mermaid
flowchart LR
  a[you] --> sfu[sfu]
  b[friend] --> sfu
  sfu --> c[friend]
  sfu --> d[friend]
  sfu --> e[friend]
```

a room stays on one machine.

bad wifi goes through a relay:

```mermaid
flowchart LR
  phone[phone on bad wifi] --> turn[turn relay]
  turn --> sfu[sfu]
```

boxes:

```mermaid
flowchart TB
  api[api]
  signal[signal]
  sfu[sfu]
  turn[turn]

  api -->|token| signal
  signal -->|who joined| sfu
  turn -->|backup path| sfu
```

- **api** — login, room, token
- **signal** — join, leave, mute
- **sfu** — copy the packets
- **turn** — backup for bad networks

---

## stream

one upload. a few sizes. files. the cdn copies those files to everyone.

```mermaid
flowchart LR
  cam[broadcaster] --> in[ingest]
  in --> tr[transcode]
  tr --> files[files]
  files --> cdn[cdn]
  cdn --> w1[watcher]
  cdn --> w2[watcher]
  cdn --> w3[lots more]
```

- **ingest** — take the one upload
- **transcode** — 1080, 720, 480
- **files** — short clips
- **cdn** — serve the crowd

6000 watchers is too big for your box. the cdn holds that.

---

## call and stream together

friends stay on the call. one extra watcher writes the public stream.

```mermaid
flowchart TB
  a[you] --> sfu[sfu]
  b[friend] --> sfu
  sfu --> c[friend]
  sfu --> d[friend]
  sfu --> eg[egress]
  eg --> tr[transcode]
  tr --> cdn[cdn]
  cdn --> crowd[crowd]
```

the crowd never connects to the sfu.

---

## one repo

same code. `.env` picks which program boots.

```mermaid
flowchart TB
  env[".env"] --> api
  env --> signal
  env --> sfu
  env --> turn
  env --> ingest
  env --> transcode
  env --> egress
```

```text
cmd/api
cmd/signal
cmd/sfu
cmd/ingest
cmd/transcode
cmd/egress
```

`.env` holds addresses, ports, keys, limits.

shared: users, rooms, tokens, the app.
split: anything holding live video.
