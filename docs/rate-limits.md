# Rate limits

Every route has a limit (api/src/ratelimit.rs; video/src/limits.rs for the video box). Past
it the answer is `429` with `Retry-After` (seconds) and `{"error": "...", "retry_after": n}`.

- **Key.** "account / IP" means the login when the cookie is a real one, else the address
  Caddy saw (`X-Forwarded-For`). The handlers' own older limits (signup, login, DMs, follows,
  people search, chat images, error reports) still apply on top.
- **Not counted.** Requests with no `X-Forwarded-For` (they came from inside the compose
  network: video's publisher calls, the tests run inside, the dummy box) and reserved-name
  requests carrying the dummy password.
- **New names.** A write to `/api/streamers/{name}/...` (or go-live) on a name the caller has not
  written this hour counts toward 20 distinct names per hour per account/IP: this is what
  stops a logged-out script from creating unlimited names and filling the bucket with uploads.
- **Off switch.** `RATE_LIMITS=off` in `.env` turns the route limits off (load tests, seeding).
  `scripts/seed.sh` and `scripts/dummy-groups.sh` also clear `rl:route:*`.
- **Redis down.** Route limits let the request through and log a warning.

Expected usage is an estimate from reading the code and frontend (poll intervals, per page
load, per action), not a measurement.

| Changed | Endpoint (method + path) | What it does | Limit before | Limit now | Key | Window | Expected usage (estimate) |
|---|---|---|---|---|---|---|---|
| ✅ | `POST /api/signup` | Create an account | 20 / IP | 20 / IP **+ 30 / IP** (auth tier) | IP | 1 h; 1 min | rare (once per person) |
| ✅ | `POST /api/login` | Log in | 10 / name+IP, 100 / IP | same **+ 30 / IP**, now with Retry-After | name+IP, IP | 15 min; 1 min | low (per login) |
| ✅ | `GET /api/oauth/{provider}/start`, `GET /api/oauth/{provider}/callback`, `POST /api/oauth/signup`, `POST /api/oauth/{provider}/unlink` | Google / Discord login: start, the provider's redirect back, pick a name, unlink | `POST /api/oauth/signup` shares signup's 20 / IP / hour | **30 / IP** (oauth tier) | IP | 1 min; 1 h | low (once per login; a callback is two outbound https calls) |
| ✅ | `GET /api/oauth/providers`, `GET /api/oauth/identities`, `GET /api/oauth/signup` | Which providers are on; this login's linked ones; the pending name pick | none | **600** (read tier) | account / IP | 1 min | low (login form, security tab) |
| ✅ | `POST /api/logout`, `POST /api/logout-all` | End this / every login | none | **30 / IP** | IP | 1 min | rare |
| ✅ | `POST /api/password` | Change password | 10 tries / name+IP (shared with login) | same **+ 30 / IP** | name+IP, IP | 15 min; 1 min | rare |
| ✅ | `POST /api/name` | Rename account | 10 tries / name+IP (shared with login) | same **+ 30 / IP** | name+IP, IP | 15 min; 1 min | rare |
| ✅ | `GET /api/me` | Who am I | none | **600** (read tier) | account / IP | 1 min | high (every page load) |
| ✅ | `GET /api/health` | Box health (probes postgres, redis, video, S3) | none | **60 / IP** | IP | 1 min | low (monitor every 15 s) |
| ✅ | `GET /api/streamers/{name}` | Profile card | none | **600** | account / IP | 1 min | high (watch page, hover cards) |
| ✅ | `PUT /api/streamers/{name}` | Save status/bio | none | **120** + **20 new names** | account / IP | 1 min; 1 h | low (per edit) |
| ✅ | `GET /api/streamers/{name}/sessions` | Past streams | none | **600** | account / IP | 1 min | medium (profile page) |
| ✅ | `POST /api/streams/{name}/go-live` | Start a stream | none | **10** + **20 new names** | account / IP | 10 min; 1 h | rare (per stream) |
| ✅ | `POST /api/streams/{name}/heartbeat` | Publisher keepalive | none | **120** | name+IP | 1 min | high (every 15 s per live streamer) |
| ✅ | `POST /api/streams/{name}/attached`, `/viewers`, `/stop` | Publisher/video bookkeeping | none | **120** (video's own internal calls are not counted) | name+IP | 1 min | medium (per stream event, mostly internal) |
| ✅ | `POST /api/streams/{name}/watch` | Open a watch page | none | **120** (write tier) | account / IP | 1 min | high (per watch page load) |
| ✅ | `GET /api/streamers/{name}/avatar`, `/thumbs`, `/thumbs/{id}`, `/offline`, `/assets`, `/assets/{id}` | Read pictures & scene assets | none | **600** | account / IP | 1 min | very high (every card/image) |
| ✅ | `PUT /api/streamers/{name}/avatar`, `/thumbs`, `/offline`, `/assets` | Upload pictures & scene assets | none | **60** (upload tier) + **20 new names** | account / IP | 1 h | low (per upload) |
| ✅ | `DELETE /api/streamers/{name}/avatar`, `/thumbs/{id}`, `/offline`, `/assets/{id}` | Remove an upload | none | **120** + **20 new names** | account / IP | 1 min; 1 h | rare |
| ✅ | `PUT /api/streamers/{name}/offline-note`, `/about`, `/socials` | Edit profile text | none | **120** + **20 new names** | account / IP | 1 min; 1 h | low |
| ✅ | `PUT /api/streamers/{name}/presence` | Set presence status | none | **120** + **20 new names** | account / IP | 1 min; 1 h | low (per status change) |
| ✅ | `GET /api/streamers/{name}/about-page`, `GET /about-file/{id}` | Read the about page & its files | none | **600** | account / IP | 1 min | medium (profile page) |
| ✅ | `PUT /api/streamers/{name}/about-page`, `PUT /about-file` | Save about page / upload its file | none | **60** + **20 new names** | account / IP | 1 h | low |
| ✅ | `GET /watch/`, `GET /watch/{*rest}` | HTML watch page with preview tags | none | **120 / IP** | IP | 1 min | high (shared links, unfurl bots) |
| ✅ | `POST /api/streamers/{name}/follow`, `/unfollow` | Follow / unfollow | 120 / account | same **+ 120** (write tier) | account | 1 h; 1 min | low (per click) |
| ✅ | `GET /api/following`, `/api/people`, `/api/recent` | Sidebar lists | none | **600** | account / IP | 1 min | high (every page load) |
| ✅ | `GET /api/search` | People search (typed into) | 180 / IP | same **+ 600** | IP; account / IP | 1 min | medium (per keystroke pause) |
| ✅ | `GET /api/explore`, `GET /api/groups` | Browse / my groups | none | **600** | account / IP | 1 min | medium |
| ✅ | `POST /api/groups` | Create group | owner cap (2 groups) only | **120** + cap | account | 1 min | rare |
| ✅ | `GET /api/groups/{group}`, `/messages`, `/members`, `/roles`, `/bans`, `/icon`, `/banner` | Read a group room | none | **600** | account / IP | 1 min | high (room page) |
| ✅ | `DELETE /api/groups/{group}` | Delete group | none | **120** (moderate tier) | account | 10 min | rare (owner) |
| ✅ | `POST /api/groups/{group}/join`, `/leave` | Join / leave | members cap (8) only | **120** | account | 1 min | low |
| ✅ | `POST/PUT /api/groups/{group}/channels`, `PUT/DELETE /channels/{channel}`, `PUT /channels/{channel}/cooldown`, `PUT /channels/{channel}/roles` | Channel setup | channel cap (20) only | **120** (moderate) | account | 10 min | rare (owner/mod) |
| ✅ | `PUT/DELETE /api/groups/{group}/channels/{channel}/mute` | Mute a channel | none | **120** | account | 1 min | low |
| ✅ | `PUT /api/groups/{group}/channels/{channel}/read` | Read marker | none | **120** | account | 1 min | high (as messages are read) |
| ✅ | `PUT /api/groups/{group}/icon`, `/banner` | Upload group pictures | none | **60** (upload) | account | 1 h | rare (owner) |
| ✅ | `PUT /api/groups/{group}/about`, `/access`, `/order`, `/owner-role` | Group settings | none | **120** (moderate) | account | 10 min | rare (owner/mod) |
| ✅ | `POST /roles`, `PUT/DELETE /roles/{id}`, `POST /roles/{id}/members`, `DELETE /roles/{id}/members/{name}` | Roles | none | **120** (moderate) | account | 10 min | rare (owner/mod) |
| ✅ | `POST /owners`, `DELETE /owners/{name}`, `POST /transfer` | Ownership | none | **120** (moderate) | account | 10 min | rare (owner) |
| ✅ | `POST /kick`, `POST /timeout`, `DELETE /timeout/{name}`, `POST /ban`, `DELETE /bans/{name}` | Moderation actions | none | **120** (moderate) | account | 10 min | low (mods, spikes during raids) |
| ✅ | `GET /api/dms`, `GET /api/dm/{name}` | DM list / thread | none | **600** | account | 1 min | medium |
| ✅ | `POST /api/dm/{name}` | Send a DM | 60 / account | same (now with Retry-After) **+ 120** | account | 1 min | medium (per message) |
| ✅ | `PUT /api/dm/{name}/read` | DM read marker | none | **120** | account | 1 min | medium |
| ✅ | `GET /api/dm/{name}/search` | Search a DM thread | none | **60** (search tier) | account | 1 min | low |
| ✅ | `POST /api/chat-images` | Upload a chat image | 30 / account | same (Retry-After) **+ 60** (upload) | account | 10 min; 1 h | low (per pasted image) |
| ✅ | `GET /api/chat-images/{id}` | Show a chat image | none | **600** | account / IP | 1 min | high (images in chat) |
| ✅ | `GET /api/models`, `/models/{id}`, `/models/{id}/thumb` | Demo VRM models | none | **600** | account / IP | 1 min | low (go-live page) |
| ✅ | `GET /api/notifications` | Inbox | none | **600** | account | 1 min | medium (per open) |
| ✅ | `PUT /api/notifications/read`, `/settings` | Mark read / settings | none | **120** | account | 1 min | low |
| ✅ | `POST /api/errors` | Page error reports | 60 / IP + global cap | same **+ 120 / IP** | IP | 10 min; 1 min | low (on page errors) |
| ✅ | `GET /api/errors` | Read error reports | admin / ops token only | **600** | account / IP | 1 min | rare (admin) |
| ✅ | `GET /api/streams` (home service) | Live list for the home page | none | **300 / IP** | IP | 1 min | high (every home load) |
| ✅ | `GET /chat/{name}`, `GET /chat/{server}/{channel}` (WebSocket) | Open a chat room socket | 8 sockets / IP / room; lines: 2/60 s anon, 3/10 s logged in | same **+ 60 opens / IP** | IP | 1 min | medium (per watch/room page) |
| ✅ | `GET /chat/{name}/before`, `/by/{speaker}`, `/around/{id}` (+ `{server}/{channel}` forms) | Chat history | none | **300 / IP** | IP | 1 min | medium (scrollback) |
| ✅ | `GET /chat/{name}/search`, `/chat/{server}/{channel}/search` | Search chat history | none | **60 / IP** | IP | 1 min | low |
| ✅ | `GET /events` (WebSocket) | Presence & push socket | none | **60 opens / IP** and **20 open at once / IP** | IP | 1 min | medium (one per browser, reconnects) |
| ✅ | events socket `watch` / `unwatch` frames | Subscribe to names/topics | none | **1000 watched at once / socket**, **2000 frames / socket** | socket | 1 min | high on page load (sidebar follows) |
| ✅ | `GET /`, `/health`, `/api/monitor` (monitor box) | Uptime dashboard | none | **120 / IP** (in memory) | IP | 1 min | low (ops only) |
| ✅ | `GET /ws` (video SFU signaling WebSocket) | Publish / watch handshake | peers: 4 / IP / room, 16 / IP, 12 previews / IP | same **+ 60 opens / IP** | IP | 1 min | medium (per watch page, reconnects) |
| ✅ | `GET /thumb/{file}` (video) | Live stream still | none | **3000 / IP** | IP | 1 min | very high (every home card every 5 s) |
| ✅ | `GET /live`, `/viewers`, `/health` (video), `/online` (events), `/health` (chat/events/home) | Internal probes | none | **600 / IP** when reached through Caddy; internal calls not counted | IP | 1 min | high but internal only |
