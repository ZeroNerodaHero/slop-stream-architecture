# docs

- `overview.md` — the short one. what this is, how to deploy, test, and work on it. read this first.
- `spec.md` — the long one. every port, route, env, timeout and rule, for a person or an llm building on it.
- `chat.md` — the text chat: why redis streams and a websocket, the protocol, the limits, the panel.
- `architecture.md` — background from before the build. the big picture of calls vs broadcasts, not the repo layout.
- `architecture-picture.md` — the repo as pictures. what runs, what talks to what, what builds into what. no new rules, just diagrams of what is already here.
- `accounts.md` — username + password, optional: argon2id on the api, hashed login tokens in a cookie, what an account protects, what a breach gets.
- `kubernetes.md` — a plan, not a build. what k8s would buy here, the video routing problem, the code to change first, the steps.
- `debugging.md` — how you find out something broke. the health answer, the pages reporting their own failures to `/api/errors`, the separate debug database, `/admin`, and the monitor box that polls every box.
- `metrics.md` — a plan, not a build. cpu, memory, disk and network per container and per box, in our own code: an `api agent` on every box, the monitor keeping and drawing it, alerts on the lines that matter. the questions to settle first.
