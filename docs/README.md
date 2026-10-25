# docs

- `overview.md` — the short one. what this is, how to deploy, test, and work on it. read this first.
- `spec.md` — the long one. every port, route, env, timeout and rule, for a person or an llm building on it.
- `chat.md` — the text chat: why redis streams and a websocket, the protocol, the limits, the panel.
- `architecture.md` — background from before the build. the big picture of calls vs broadcasts, not the repo layout.
- `architecture-picture.md` — the repo as pictures. what runs, what talks to what, what builds into what. no new rules, just diagrams of what is already here.
- `accounts.md` — username + password, optional: argon2id on the api, hashed login tokens in a cookie, what an account protects, what a breach gets.
- `groups.md` — a login joins a group and its chat lines wear the group's badge, discord style. `bot` is built in and automatic (a socket says `bot: true`), and the chat panel can hide the bots' lines.
- `kubernetes.md` — a plan, not a build. what k8s would buy here, the video routing problem, the code to change first, the steps.
- `debugging.md` — how you find out something broke. the health answer, the pages reporting their own failures to `/api/errors`, the separate debug database, `/admin`, and the monitor box that polls every box.
- `metrics.md` — a plan, not a build. cpu, memory, disk and network per container and per box, in our own code: an `api agent` on every box, the monitor keeping and drawing it, alerts on the lines that matter. the questions to settle first.
- `status.md` — presence, built: `offline`, `online`, `do not disturb`, `streaming` next to a name. the chat service is also a gateway websocket, one per browser in a shared worker, open on every page; sorted sets in redis for "here", one stream for the facts, one column for the choice, `streaming` from what the api already knows. plus the messages inspector: the frames the browser gets, the last 1000 in a ring, in a panel over the page. every container's change, the tests, the questions still open.
- `transition.md` — a plan, not a build. the move from polling to the socket in `status.md`: why the first draft said no, every http loop the pages run today and which ones become pushes, what stays http and why, old pages against a new server during each step, the deploy order with its proof and its way back, the numbers to check before it goes out.
- `hover-preview.md` — a plan, not a build. hold the mouse on a card and it plays the stream; click and the page uses the connection the card made, so the first frame is instant. where a click's time goes today, why hover and not mousedown, the one refactor in `watch-atoms.ts`, and three answers: hovering is not backend spam with a 300ms dwell and one preview per tab; what the 300ms version looks like in time; why a lower-bitrate preview is not worth building at 1000 users.
