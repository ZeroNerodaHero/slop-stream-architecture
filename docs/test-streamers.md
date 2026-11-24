# test streamers

built, backend only. the fake streams the dummy box plays (`video dummy`, `video/src/dummy.rs`, `spec.md`) are rows in `streamers` like anyone's, flagged `is_test`. the pages draw them like any stream today; the flag is there so they can later be treated as normal streams while still told apart, and so a box can hide them altogether.

the code: `api/src/test_streamers.rs` (the flag, the secret, the hiding), `may_write` and `go_live` in `api/src/main.rs`, `api/src/ratelimit.rs` (the skip), `api/migrations/0017-test-streamers.sql`.

## the flag

- **one column**, `is_test boolean NOT NULL DEFAULT false` on `streamers` (`api/migrations/0017-test-streamers.sql`). the migration backfills `is_test = true` for every row named `dummy-%`, the default prefix. a box run with another `DUMMY_PREFIX` needs its own backfill once: `UPDATE streamers SET is_test = true WHERE name LIKE '<prefix>%'`. the dummy box's next write marks its names anyway (below), so the backfill only matters for names the box no longer plays.
- **set only by the dummy password.** `may_write` (the gate every `/api/streamers/:name/...` write and go-live go through) takes a name under `DUMMY_PREFIX` only with the right dummy password, and when it does, it upserts the row with `is_test = true` (`test_streamers::mark`: `INSERT ... ON CONFLICT (name) DO UPDATE SET is_test = true WHERE NOT is_test`). idempotent, and it never touches `password_hash` or any other field.
- **no human path writes it.** no route takes it in a body, and no route clears it. a human cannot get a test row either: signup and oauth signup claim a free row only when it is not a test row (`WHERE password_hash IS NULL AND NOT is_test`, else `name taken`), and a rename onto a test row's name is `name taken`. (names under the prefix were already refused on all of those, with the words they had: `reserved name`, and `that nick belongs to the fake streams. pick another` for chat and guest nicks.) `api passwd`, the box owner's own tool, is left as it was.

## the secret

- **`X-Dummy-Password: <DUMMY_PASSWORD>`**, a request header, is how the dummy box sends it now. **`?password=`** in the query still counts, so the api and the dummy box can be deployed in either order; the header wins when both are there. every `[?password=]` in `spec.md`'s route table takes either.
- compared in constant time (`test_streamers::secret_ok`: every byte of the longer of the two is looked at whatever matches), never logged.
- `PUT /api/streamers/:name/about-file` reads it the same way, beside its `type`.
- video's publish frame is unchanged: the dummy box still puts `password` in the websocket's first frame, and video checks it there (`video/src/main.rs`).

## rate limits

the route limits (`rate-limits.md`) skip a request only when all three hold: the secret is right (header or query), the route is a name's own (`/api/streamers/{name}`, `/api/streamers/{name}/...` or `/api/streams/{name}/...`), and that name starts with `DUMMY_PREFIX`. anything else carrying the secret (a login, a group, a dm, another name) is counted like everyone's. before this the right `?password=` skipped the limits on any route. `test_streamers::skips_limits`, tested in `test_streamers.rs` and `ratelimit.rs`.

## hiding them: `HIDE_TEST_STREAMERS`

off by default. `1` or `true` (any case) turns it on; anything else, or unset, is off. read once at boot by the api process (`AppState.hide_test`) and by the home process (`api home`, its own state). off, every answer is what it was before this: the hide checks do not touch the database, and the list queries bind `false` into `NOT ($n AND s.is_test)`.

on, a test streamer is left out of:

| where | what it does |
|---|---|
| `GET /api/streams` (the home process) | the live list drops every live name whose row is a test row |
| `GET /api/following` | the login's follow list drops test rows (and so their words: the sidebar's presence rows) |
| `GET /api/search` | people search drops test rows |
| `GET /api/people` | home's people drops test rows |
| `GET /api/recent` | recently offline drops test rows |
| `GET /api/notifications` | a row whose actor is a test streamer (a go-live) is not listed |
| `GET /api/streamers/:name` | 404 `no such streamer` |
| `POST /api/streams/:name/watch` | 404 `no such streamer` (after the held-name redirect, so a held name is looked up as its account) |
| `GET /watch/:name` | the page shell with a 404, and none of the name's card in it |
| `POST /api/streams/:name/go-live` | 403 `test streamers are hidden here`, after the dummy password is checked, so the dummy box cannot put one on air |

with go-live refused nothing new of a test streamer reaches the events stream (no `live` event, no go-live notification, nothing in `GET /api/explore`'s `live`). a session already on air when the api restarted with hiding on plays to its end; home leaves it out meanwhile, and the dummy's next go-live is refused.

not filtered, and why:

- **groups** (members, roles, badges, bans, timeouts, explore's live members, the room): a membership needs a login, and a test row never has a password.
- **dms, jannies, `/api/errors`, analytics**: logins only, or the login's own.
- **follower counts** (`followers` on a profile): they count who follows, and followers are logins.
- **a name's own sub-resources** (`/avatar`, `/thumbs`, `/assets`, `/offline`, `/about-page`, `/about-file`, `/sessions`) and **the chat** (`/chat/:name`, its history): only reachable by the name, which no list hands out while hiding is on.
- **the events socket's `/online`**: who has the site open, by login or guest nick, and those refuse the prefix.

the switch is read by two processes, `api` and `home`. `docker-compose.yml` passes `HIDE_TEST_STREAMERS` from `.env` to both; unset (the default) means off.

## the dummy box

`video/src/dummy.rs`, on every try before go-live (`dress`):

- **the bio**, as before: written when `GET /api/streamers/:name` has none.
- **the avatar**, when that read answered and its `avatar` is null: a 256×256 jpeg made by the box's ffmpeg, the stream's colour from `COLORS` with the first letter of the name past the prefix drawn in white in the stream's font (`DUMMY_FONT`), `PUT /api/streamers/:name/avatar`.
- **the about page**, when `GET /api/streamers/:name/about-page` answers with no blocks: one text block of three short paragraphs saying it is a fake test stream for styling and debugging and not a real person, worded a little differently per stream (`ABOUT_OPENERS`, `ABOUT_MIDDLES`), `PUT /api/streamers/:name/about-page`.
- every write carries `X-Dummy-Password`. a failure in the avatar or the about page is a warn line in the box's log and nothing more: the stream goes on. a read that failed writes nothing, so a box whose streams are hidden does not upload a picture on every try.
- **go-live refused with a 403** (a wrong password, or hiding on) waits 60s before the next try instead of 5s (`REFUSED_RETRY`).
