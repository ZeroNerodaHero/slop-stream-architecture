# api/ source: accounts, storage, limits, ops

the header comment of each file below and the doc comment of each top-level item, plus the notes from `api/Cargo.toml`, `api/Dockerfile`, `api/schema.sql` and `api/src/monitor.html`, moved here when the source lost its comments (`.cursor/rules/no-comments.mdc`). the code is the truth; these say what a piece was written for at the time of the move, so check a detail against the code before trusting it. the realtime and social modules are in `api-source-realtime.md`. the files #180 and #182 touch still carry their own comments.

## `api/src/analytics.rs`

Stream analytics, the first version (docs/analytics.md): what a streamer's streams did, for
that streamer's eyes alone. Three tables (migration 0014): `stream_sessions` (one per stream
an account made, the `sessions` row's id), `viewer_samples` (the viewer count once a minute)
and `watch_sessions` (one stretch of one viewer watching). Nothing here deletes.

Writes:
- go-live opens the stream's row (`open`); every way a stream ends reaches it through the
  `sessions` row (`sync`, each minute and at boot, and `ended` from stop at once).
- `sampler`: once a minute, on the minute, video's `/viewers` (the same call home.rs heals its
  table from) is written for every open stream. Two api processes write the same minute once.
- video's `POST /api/streams/:name/viewers` raises `peak_viewers` (`peak`): finer than a sample.
- `POST /api/streams/:name/watching`: the watch page's beat, every minute while the video
  plays and once on leaving. A login counts as its id, anyone else as the random id their
  browser keeps (`?anon=`). Nothing checks that id yet: a script can make up viewers here,
  it cannot touch the viewer counts, which are video's.

Reads: `GET /api/stats?days=7|30` and `GET /api/stats/streams/:id`, the logged-in account's
own streams and nobody else's. Nobody logged in gets a 401: a stream with no account is not
recorded at all, so there is nothing to show and nobody it could be shown to.

`const WATCH_GAP_SECS`: A watch stretch whose last beat is older than this is over: the next beat starts a new one.
The page beats every 60s, so two missed beats and a little.

`const LIST_LIMIT`: The most streams the list of a range answers, newest first.

`const DAYS`: The ranges a summary is asked for.

`pub`: The stream's row, at go-live, when an account went live (a free name's stream is nobody's to read).

`pub`: The stream ended (stop): its end, from its `sessions` row, at once rather than at the next sync.

`pub`: Video's count moved: the peak, when it is a new one. A write only then.

`pub`: The rows put right with `sessions`, which is the truth for when a stream ran: an account's
open stream with no row yet gets one (a go-live an older api took during a deploy), and an
open row whose stream has ended takes its end (stop, video's word, the sweeper, a go-live that
ended a stale one; any of them while this process was down). Returns how many rows it ended.

`pub`: One sample per open stream that video has a count for, at the minute `at` falls in. A stream
video does not list (seconds old, or gone and not ended yet) gets none for this minute.

`pub`: The once-a-minute loop: sync at boot (whatever ended while this was down), then on every
minute sync and sample. Video unreachable: that minute has no samples, nothing is guessed.

`pub`: Who is watching: a login, or a browser's anonymous id.

`pub`: One beat of the watch page for the name's open stream: the viewer's stretch goes on to now,
or a new one starts when the last beat is past `WATCH_GAP_SECS` (a second tab of the same
viewer goes on the same stretch). `leave` ends the stretch now and never starts one. Nothing
for a name with no open stream, nor for the streamer watching themselves. True when written.

`struct WatchingQuery`: `?anon=<uuid>&leave=1`. `anon` is ignored for a login.

`fn owner`: The login asking, or the words a page shows a guest instead of stats.

`type StreamRow`: id, name, started_at, ended_at, peak, avg, watch seconds, unique viewers

`const STREAM_COLUMNS`: A stream's numbers, as the list and the detail both carry them. The peak is the higher of
video's pushes and the samples; the average is the samples'.

`async fn stream_detail`: One stream in full: the list's numbers, the graph's points (`[unix ms, viewers]`, oldest
first), who watched split into logins and anonymous browsers, the follows the account got
while it was live (and still has), and its chat, the lines kept (CHAT_PERSIST) from anyone
but the streamer.

`type SummaryRow`: streams, live seconds, avg, peak, watch seconds, unique viewers

`async fn summary`: The last `days` together: every stream started in them, the average of all their samples (so
a long stream weighs more than a short one), the highest peak, the watch time, the different
viewers across all of them, and the follows the account got in the range, live or not.

`async fn stats`: The stats tab: the range's summary and its streams (newest first, at most LIST_LIMIT), and the
last stream in full, whenever it was (null for an account that never went live).

`async fn stream`: One stream in full, the account's own: anyone else's (or none) is a 404, the same answer.

## `api/src/auth.rs`

Accounts: username + password. See docs/accounts.md.

The password is hashed with argon2id and forgotten. A login is 32 random
bytes in an httponly cookie; the database keeps their sha256. Nobody has to
log in: a name without an account is free for anyone, like before. A name
with one (a "claimed" name) can only go live, save a bio or talk in chat
when the cookie says it is them.

Behind every name is a row id, a uuid that never changes (docs/ids.md). The
cookie resolves to the id and the name together (`Account`); logins point at
the id, so `POST /api/name` can change the name and every device stays logged
in. The old name is held for the account for a while, and a signup as it is
refused like a taken one.

`const RENAME_DAYS`: A name changes once in this many days, and the old one is held for the account as long:
nobody else can sign up as it or rename onto it, and `/watch/<old>` leads to the new one.

`const LOGIN_PER_NAME`: Password tries in a window: per name from one ip (a right one clears that count),
and per ip over every name. Keyed on the ip too, so a stranger's wrong guesses
cannot lock the owner out; an attacker has to bring many ips.

`const HASH_SLOTS`: argon2 runs at once, process-wide. Each takes 19 MiB, so a burst of logins must
queue here rather than allocate n × 19 MiB on the blocking pool. A wait, never an error.

`const ARGON2_ALGORITHM`: argon2id with owasp's numbers: 19 MiB, 2 passes, 1 lane. About 50ms on a small vps.
The salt and these settings travel inside the stored string, so they can change later:
raise them here and every account moves onto the new ones at its next right password
(`needs_rehash`, `upgrade_hash`). The one place they are written down.

`fn verify_password`: The algorithm, version and cost are read from the stored string, so a hash made
on older settings still checks.

`fn needs_rehash`: Was this stored hash made on other settings than `hasher`'s: another algorithm or
version, other costs, another output length. A string that does not parse is not
rehashed here: it never verifies, so there is no right password to rehash it with.

`pub`: What `password_hash` holds for an account made with a provider (google, discord) and no
password yet (oauth.rs). Not a hash: `PasswordHash::new` refuses it, so no typed password
ever verifies against it. Not null either: null means "a name with no account", and every
`password_hash IS NOT NULL` in the api (is_claimed, the ✓, dms, ...) must count this account.

`pub`: A stored value that is a real password, not `NO_PASSWORD`.

`pub`: Does this account have a password (it may have only a provider login).

`fn decoy_hash`: Checked against when the name does not exist, so that takes as long as a wrong
password. Made the first time it is needed, on the blocking thread that needs it.

`async fn hash_blocking`: Hashing blocks a thread for tens of milliseconds. Never on the async runtime,
and never more than HASH_SLOTS at a time. The slot travels into the blocking job
and is freed when the hash is done: a request future dropped mid-wait cannot stop
the job, so freeing the slot with the future would let the next one start a fifth.

`enum Verdict`: What checking a typed password found.

`async fn verify_blocking`: `None` is a name with no account: the decoy is checked instead, so the answer
takes as long as a wrong password, and is wrong. A right password on an old hash is
hashed again in the same blocking job, under the same slot: never on the runtime.

`async fn upgrade_hash`: Swaps an account's old-settings hash for `new`, only while `old` is still the one
stored: a password change or an `api passwd` in between wins, and this does nothing.
Best effort: a failure is logged and the login goes on; the next one tries again.

`fn normalize`: The same string from a phone and a laptop: compatibility normalisation.

`fn clean_password`: Normalised, then 8 to 128 characters. The length rule is one rule for a new
password and for a typed one, measured the same way, or what signup takes
could never log in (`e` + combining acute is two chars raw, one after nfkc).
Only the length: a password made before the number-and-symbol rule still logs in.

`const NEW_PASSWORD_RULE`: The words a refused new password gets. frontend/src/infra/password.ts says the same.

`fn is_symbol`: A symbol is anything not a letter, a number or a space. The frontend's check
(frontend/src/infra/password.ts) uses the same unicode classes, on the same nfkc string.

`fn clean_new_password`: For a new password (signup, change): the length rule, plus at least one number and
one symbol, with the reason as a 400. Never asked of a password being typed to log in.

`fn token_hash`: What the database keeps. The token itself only ever lives in the browser.

`pub`: Httponly: scripts never see it. Secure: https only (browsers allow it on localhost too).
Lax: a form on another site cannot post with it. No Domain: it sticks to this host.

`pub`: A new login row, pointing at the account's id. The account's expired rows go at
the same time: nothing else ever sweeps them. Live ones stay; a phone and a laptop
are both you. The `name` column is still written while it exists (docs/ids.md): the
previous image reads it, and a rename cascades into it.

`pub`: An account: the row id that never changes, and the name it has right now.

`pub`: The account behind the cookie, if the login is real and not expired. A read; the
row's last_seen moves at most once an hour (the cte, in the same round trip),
so a logged-in page does not turn every request into a write.

`pub`: whoami that never writes. For the error reports: a sick main database must
not make a report wait, and a report is not a visit.

`pub`: Is `name` held for an account that renamed away from it (and not for `except`, when
given: an account may take its own old name back). A hold is a claim in waiting: a
signup or a rename onto it gets `name taken`, the same words as for an account's name.

`pub`: The name a held name became, while the hold lasts: `/watch/<old>` leads there.

`pub`: Is this name somebody's: it has an account, or an account renamed away from it and the
hold is still on (`is_held`; a claim in waiting). The one answer for the write gates and
both socket hellos, in one statement, so nobody can go live as, write or wear a held
name while `/watch/<name>` leads to the account that left it (docs/ids.md).

`pub`: The refusals for a name that is somebody's, the http one and the sockets' one. The word
`account` is the wire contract: the pages recognise a refused nick by regex on this text
(`/nick|account|fake/` in frontend/src/infra/events.worker.ts and events.ts,
`/nick|account/` in frontend/src/infra/atoms/chat-atoms.ts) and only then stop re-sending
it; docs/status.md, chat.md, accounts.md, spec.md and test/auth.js, presence.js quote it.
A held name is held for an account, so the words hold for it too. Change them together
with all of those, or not at all.

`pub`: The one rule the rest of the api asks: may whoever holds `me` act as `name`?
A free name: anyone. A claimed name: only its own login. A held name: nobody, not even
the account that left it (its login is under the new name; it renames back instead).

`pub`: Who the cookie says this is. `None` for everyone without a (valid) login.

`pub`: The login the rate limiter already looked up for this request (ratelimit.rs), so `Me`
does not ask postgres a second time.

`pub`: One more in redis, window from the first. Returns the count. One atomic round
trip: INCR and EXPIRE NX (a ttl only when the key has none, redis 7) together,
so a crash between them can never leave a counter that never expires.

`pub`: `bump`, and past `max` a 429 with `message` that says how long is left (`Retry-After`).

`pub`: Caddy sets X-Forwarded-For and nothing else reaches this port, so it is trusted.

`fn wrong`: One answer for a wrong name and a wrong password, so a guess learns nothing about
which it was. Not a secret that the name exists: GET /api/streamers/<name> says so.

`fn name_taken`: Another account's, or held for one. One answer for both: a hold is a claim in waiting.

`fn login_key`: The counter a guess at this name's password from this ip lands on: login and
a password change share it.

`fn from_here`: Did the browser send this from one of our own pages? Browsers put Sec-Fetch-Site
on every request; a form on another site says `cross-site`. Nothing without the
header (curl, the tests, old browsers) is held back by it.

`pub`: The signups from one address in an hour, a password one or a provider one (oauth.rs).

`async fn me`: `{ id, name, renamed_at, has_password, held }`; every field null (`held` empty) for nobody.
`has_password` is false for an account made with a provider that has not set one
(oauth.rs). `held`: this account's old names still held for it (it may go back any time). The one place a person can read
their own id; no page needs it. `renamed_at` is when the name last changed, for the
profile tab to say when it may change again.

`async fn check_password`: The login's own password, counted on the login limiter first: a stolen cookie is not
unlimited guesses. The counter clears on a right one. `None` when the account is gone.

`fn rename_wait`: May an account whose name last changed at `last` rename now? Always when it goes back to a
name held for it (`returning`): the hold is its own, and waiting out RENAME_DAYS would end
the hold at the same moment, a race with everyone else for the name. Otherwise once in
RENAME_DAYS.

`pub`: Takes the free row (no account) under `new` for `me`, who is about to be renamed onto it:
its followers move to `me` (they followed the name, docs/follows.md), then its thumbs and
the row go. Returns its picture keys in the bucket, to drop after the commit. `name taken`
when the row is not free any more: a signup claimed it between the check and here, and the
caller's early return rolls the transaction back.

`async fn change_name`: `POST /api/name` `{ name, password }`: the login's name changes; its logins, groups and
pictures stay, because they point at the id. Once in RENAME_DAYS (but back onto a name held
for this account at any time, `rename_wait`), with the password (a stolen cookie must not
walk off with the name; an account with no password, made with a provider, has only its
cookie), never while live (the stream's url, key and room are the name). The old name is
held HOLD_DAYS for this account. See docs/ids.md.

`pub`: A new random password for a name, printed once. The reset, since there is no
email. Works on a name with no account too: it becomes one.

`fn random_password`: 16 symbols from a 32-letter alphabet (no 0 o 1 l): 80 bits.

## `api/src/cf_purge.rs`

Cloudflare's copy of a public picture or video, dropped when the api takes the thing down.
The edge keeps a public answer as long as its `Cache-Control` says (a day for a chat picture,
a year for an asset); a takedown that only empties the bucket would leave the edge serving it.
So each takedown of a public route names its urls here, and they are purged by url
(docs/cloudflare-cache-rules.md).

CF_PURGE_TOKEN (Zone > Cache Purge on the one zone), CF_ZONE_ID, and PUBLIC_URL (the origin
the urls are under). Any of them unset or empty: off, a debug line per purge, nothing else.
A purge never holds up or fails the request that asked for it: it runs on its own task, gives
up after PURGE_TIMEOUT, and a failure is a warn line. Never a private (group or DM) url: those
answer `private, no-store`, the edge never kept them, and the caller does not name them.

`const PURGE_TIMEOUT`: The whole call to Cloudflare, connect to answer.

`const PER_CALL`: Urls per purge call: the most Cloudflare takes in one on the free plan.

`fn config`: Read once. None: purging is off.

`fn urls`: The absolute urls of `paths` (each starting `/`) under `origin`.

`pub`: Purge `paths` (each starting `/`, query and all, as the page asks for it) from Cloudflare's
cache, on a task of its own. Returns at once.

## `api/src/debug.rs`

The pages' error reports, and the debug database they land in. See docs/debugging.md.

A page that breaks posts one json line to `POST /api/errors` (sendBeacon, so
the body arrives as text/plain). It is written to a second postgres database,
`debug`, made here when missing, through a lazy pool the api never waits for.
Nothing in this file can stop the api: a dead debug database means the report
is a warn line in the log and the browser still gets its 204.

`GET /api/errors` reads them back, for a login in ADMIN_NAMES (the /admin
page) or a machine holding OPS_TOKEN.

`const MAX_EXTRA_BYTES`: `extra` as json, bytes. Bigger is replaced by {"clipped": true}: the message and stack are the report.

`const KINDS`: The five things a page reports. See frontend/src/infra/report.ts.

`const KEEP_DAYS`: Rows go after this many days, and the table never holds more than this many rows.

`const HOUSEKEEPING_FIRST`: Housekeeping runs soon after boot (a box that was flooded while down gets trimmed), then hourly.

`const PER_IP`: Reports per ip, and in total, per window. Over it they are dropped, quietly,
counted in DROPPED_KEY for /api/health.

`pub`: A lazy pool on `url`, with the database and its table made when missing.
`None` only for an empty url or one that does not parse. A server that is
down costs a few seconds here at boot (the pool's 1s, the main pool's 5s) and
nothing after: a report just goes to the log, and housekeeping tries the
database and the table again every hour.

`async fn ensure_schema`: The table, and first the database when the server says there is none (3D000).

`fn is_missing_database`: postgres 3D000, invalid_catalog_name: the database in the url does not exist.

`fn database_name`: The database name at the end of a postgres url, if it is a plain identifier.

`async fn create_database`: `CREATE DATABASE` through the main pool. Works when both urls point at the
same server, which is the compose setup. Elsewhere, make it by hand.

`pub`: A minute after boot, then once an hour: drop rows older than KEEP_DAYS and
everything past the newest KEEP_ROWS. When that fails the database or the
table may not be there yet (it came up late, or was wiped), so make them.

`pub`: Reports the limits dropped in the current window, for /api/health. 0 when none, or redis is not answering.

`pub`: Of `names`, the accounts that are admins. Each name is pinned (`admin_pins`, schema.sql)
to the account that had it the first time a boot saw it with an account, and from then on
the admin is that account, by id, whatever it is called. So an admin who renames stays one
across restarts, and whoever signs up as the released name later is not one: the pin points
at the old id, not at the name. A name nobody has signed up as goes to whoever signs up as
it first (auth.rs), so it is not pinned, and not an admin, until then. Moving a pin is by
hand: `DELETE FROM admin_pins WHERE name = '...'`, then a restart pins it afresh.

`struct Report`: What a page sends. Everything but kind and message is optional; see frontend/src/infra/report.ts.

`fn clip`: Trimmed, at most `max` chars, and no control characters: none belongs in an
error text, a \r or an escape code would forge or wipe lines in the log, and
postgres refuses \u0000. The stack is the one field that keeps its \n and \t.

`fn scrub`: Control characters out of every string and key in it: postgres jsonb refuses \u0000.

`fn clip_extra`: `extra` as stored: an object, scrubbed, and {"clipped": true} in place of one bigger than MAX_EXTRA_BYTES.

`enum Lane`: Where a report goes. Over a limit it is dropped and counted in DROPPED_KEY.
With redis not answering nothing can be counted, so it goes to the log only:
the log can take a flood, the table should not.

`async fn post_error`: The body is read raw: sendBeacon sends text/plain, and the Json extractor would refuse it.

`struct ErrorRow`: One stored report, as /api/errors returns it. Read as a tuple: the sqlx derive is not on.

`async fn is_admin`: A login in ADMIN_NAMES, or `Authorization: Bearer <OPS_TOKEN>`. The bearer is
compared as two sha256 digests, so the comparison time says nothing about the
token. The cookie is looked up by its sha256 in auth.rs, like every login.

`fn list_filter`: A `kind` or `page` filter: empty is none. Matched exactly against what `clip` kept, so one
longer than MAX_FIELD_CHARS or with a control character finds nothing anyway; it is a 400
rather than a query (postgres refuses a \0).

## `api/src/media.rs`

What chat pictures (chat_images.rs) and chat videos (chat_videos.rs) share: who may put one on
a line, who is served one, and the headers it goes out with. See docs/chat.md "who sees a
picture or a video" and "takedown".

An upload is its uploader's alone until a line names it: only the uploader may put it on a
line, and the first line that does (`mark_posted`) says where it lives, kept on its row
(`posted_kind` and the rest, migration 0013). A stream's chat is public. A group's channel is
for the group's members, and a direct message for its two; anyone else is refused, and those
answers are `private, no-store`. Its uploader is always served it (the box's preview of an
upload not posted yet, and a member who has since left).

`pub`: A stream's chat picture, as it is served now.

`pub`: A group channel's or a direct message's: no cache but the viewer's own page keeps it.

`pub`: The two tables of uploads a line names.

`pub`: Where a line goes.

`pub`: Why an id may not go on a line.

`pub`: May `who` put the upload `id` on a line: it is there, and it is theirs. Nothing is written;
`mark_posted` does that once the line is going out.

`pub`: The first line that names an upload says where it lives; a later one changes nothing.

`pub`: How an upload may be served to one viewer.

`pub`: Who `viewer` is to the upload `id`. None: there is no such upload.

`pub`: The answer for an id with no row: 410 `removed` when an admin took it down, 404 otherwise.

`pub`: The refusal for a viewer `access` turned away.

`pub`: Every chat picture, video and emote goes out with these: never sniffed as anything but what
it says it is, and cached only when it is public.

`pub`: The bytes' sha256 in hex, kept with each upload.

`pub`: An admin's takedown: the row out, and a note that it was, so its lines say "removed".

## `api/src/monitor.rs`

`api monitor`: watches the other boxes from a box of its own. See docs/debugging.md.

Every CHECK_EVERY_SECS it asks each target's /api/health and keeps what came
back: up or down and since when, the build, the uptimes (they go backwards after
a restart), an hourly tally for the uptime percentages, and a log of events
(down, up, restart, new build). Every ERRORS_EVERY_SECS it pulls the newest rows
from /api/errors with that box's OPS_TOKEN, so the page shows what broke in
someone's browser without logging in to each box.

One file is the whole store, DATA_DIR/monitor.json, rewritten after every round
(temp file, then rename: a crash mid-write leaves the old one). No database, no
redis. One page, built into the binary (monitor.html), polls GET /api/monitor
every 10s.

The targets' certificates are self-signed (an ip, no domain), so they are not
checked. Health is public anyway and the media is encrypted on its own; what a
man in the middle could read is OPS_TOKEN on the error pulls. The alert webhook
is checked normally.

Env: TARGETS=prod=https://1.2.3.4,dev=https://… (nothing to watch without it),
OPS_TOKENS=prod=…,dev=… (or one OPS_TOKEN for all), ALERT_WEBHOOK (a url that
takes json with "content", like discord; "text" is sent too), PORT (3002),
DATA_DIR (/data), CHECK_EVERY_SECS (15), ERRORS_EVERY_SECS (60), DOWN_AFTER (3:
failed rounds in a row before "down" and the alert).

`const KEEP_HOURS`: Hours of tally kept: the 7-day uptime figure.

`const KEEP_ERRORS`: Error reports kept per target, and how many one pull asks for.

`fn apply`: Fold a round into the target. Returns the alerts to post (down, and up again).

`fn human`: "3d 4h", "4h 12m", "12m 05s", "42s"

`fn uptime`: Percent of rounds that passed over the newest `hours` entries. None before the first round.

`async fn pull_errors`: The newest rows from a target's /api/errors, or what it answered instead.

`fn reconcile`: The stored targets lined up with TARGETS: same name keeps its history (and takes the
new url), a new name starts empty, a name no longer listed is dropped.

`fn parse_pairs`: "a=1,b=2" → [(a, 1), (b, 2)]. Blank entries skipped, a bad one logged and skipped.

## `api/src/oauth.rs`

Log in with Google or Discord (or any provider in `PROVIDERS`), next to the password. See
docs/accounts.md.

The authorization-code flow with PKCE (S256) and a random `state`:

1. `GET /api/oauth/{provider}/start` (`?link=1` when logged in, to attach the provider to
   this account). A fresh `state` and PKCE verifier go into redis for ten minutes, the state
   also into a short HttpOnly cookie on `/api/oauth`, and the browser goes to the provider.
2. `GET /api/oauth/{provider}/callback?code&state`. The state in the query must equal the
   cookie's (a callback started in somebody else's browser is refused: no login csrf), and is
   taken out of redis in one GETDEL (used once). The code is traded for a token with the
   verifier and the client secret, over https, and the provider's user endpoint says who it is.
3. Who it is, by the provider's stable user id (never the email, never the display name):
   - linked already: logged in, the same login cookie as a password login (`auth::open_login`).
   - `link` and still logged in as the account that started: linked to it.
   - nobody's: a pending signup in redis (15 minutes, its own HttpOnly cookie), and the pages
     ask for a name (`/oauth?pick=1`). `POST /api/oauth/signup {name}` makes the account under
     the same name rules as a password signup, with no password (`auth::NO_PASSWORD`).

   An email that matches another account's is never a reason to link: a provider's email is
   whatever that provider let somebody type.

An account with at least one provider linked is *oauth verified* (`linked_sql!`): the mark
next to its name. Any provider counts, so a new entry in `PROVIDERS` counts with no change.

Config is the environment: `<ENV>_CLIENT_ID` and `<ENV>_CLIENT_SECRET` for each provider in
`PROVIDERS` (GOOGLE, DISCORD), and PUBLIC_URL (the callback is
`{PUBLIC_URL}/api/oauth/{provider}/callback`). A provider without both, or every provider
without PUBLIC_URL, is off; nothing crashes.

`const STATE_SECS`: How long a started login may take at the provider.

`const SIGNUP_SECS`: How long a new identity may take to pick its name.

`const PAGE`: Where the pages pick up after the provider (frontend/src/app/auth/OAuthPage.tsx).

`pub`: Everything that differs between two providers. A new provider is one entry in `PROVIDERS`,
its two env vars, and its callback url in the provider's console: the routes, the buttons,
the security tab and the verified mark all go by this list. (The pages have an icon per
slug, and a plain one for a slug they do not know: frontend/src/infra/oauth.ts.)

`const PROVIDERS`: Every provider this api knows, in the order the buttons show them.

`pub`: One of `PROVIDERS`. Equal by slug.

`pub`: What the environment turned on. Read once at boot (`from_env`).

`fn clean_public_url`: An http(s) url with a host, as the origin the browser types: no path, no trailing slash.

`fn random_hex`: 32 random bytes, hex: the state, the verifier and the signup token are each one.
64 characters of [0-9a-f] is a valid PKCE verifier (43 to 128 unreserved characters).

`fn base64url`: base64url without padding (RFC 4648 §5), for the S256 challenge.

`fn pkce_challenge`: RFC 7636: BASE64URL(SHA256(verifier)).

`fn check_state`: The callback's `state` against the cookie set at the start: both there, both ours, the same.

`struct Started`: A started login, in redis under its state.

`struct Newcomer`: Somebody the providers know and we do not, picking a name. In redis under its token.

`fn short_cookie`: HttpOnly, Secure, Lax (the provider's redirect back is a top-level GET, which Lax sends),
and only on `/api/oauth`: no other route ever sees it.

`fn fail`: Back to the pages with words a person can read; the state cookie goes either way.

`struct Profile`: Who the provider says this is.

`fn discord_avatar`: Discord's picture for the account: its own when it set one, else the default one its id
picks (discord's newer rule, `(id >> 22) % 6`).

`const SHOWN_NAME_MAX`: The longest provider name kept, in characters.

`fn shown_name`: A provider's display name as kept: no control characters, trimmed, at most
`SHOWN_NAME_MAX` characters. None when nothing is left.

`const AVATAR_HOSTS`: The only hosts a provider picture is kept from.

`fn shown_avatar`: A provider picture as kept: https, exactly one of `AVATAR_HOSTS`, no port, no login part,
512 characters at most. Anything else is None, and the tab draws the provider's icon.

`fn parse_profile`: The provider's user answer, read. None when it has no stable id.

`fn suggest_name`: A handle as a name we allow (a-z 0-9 _ -, 1 to 32), or empty. Only a suggestion: the
person picks, and the pick goes through every signup rule.

`async fn who_is_it`: The code for a token, then the token for a profile. Errors are logged and come back as one
word for the person: what the provider said is for the log, not for the page.

`pub`: The account a provider's user is linked to, if any.

`pub`: Whether this account is oauth verified: any provider linked (`linked_sql!`). The routes read
the mark inside the queries that already read the row; this is the one-account form.

`pub`: What a link keeps beside the provider's id: the verified email, and the name and picture
the provider shows. Each None when the provider gave none.

`async fn refresh`: The provider's latest for a linked identity, on every login and link with it: a new verified
email (an unverified or missing one keeps the old), and the name and picture as they are now.
Best effort: a failure here never stops the login.

`pub`: Attach. `Ok(false)`: that provider account is somebody's already, or this account has that
provider already (the two unique keys); nothing changed.

`pub`: May this account let go of `p`? Not when it is not linked, and not when it is the last way
in: no password and no other provider.

`pub`: The unlink, under a lock on the account's row: two unlinks at once (two tabs, one for each
provider) cannot both pass the last-way-in check.

`pub`: A new account under `name` for a newcomer, with no password, and the provider linked, in
one transaction. A free row under the name (somebody used it without an account) is claimed
the way a password signup claims it. `name taken` when it is somebody's; a 409 with other
words when the provider account got linked meanwhile (two tabs).

`async fn signup_info`: `GET /api/oauth/signup`: the pending newcomer's provider and suggested name. Never its email.

`async fn signup_finish`: `POST /api/oauth/signup {name}`: the account, named, with the provider linked, and logged in.

`async fn providers`: `GET /api/oauth/providers`: the ones turned on here, for the buttons. Public.

`type IdentityRow`: An identity as the tab reads it: provider, linked at, and the name and picture it shows.

`async fn identities`: `GET /api/oauth/identities`: this login's linked providers, whether it has a password, and
whether it is oauth verified. Each identity has the name and picture its provider shows
(null for one linked before they were kept, until its next login). The provider emails stay
in the database.

`async fn unlink_route`: `POST /api/oauth/{provider}/unlink`. Refused when it would leave no way in.

## `api/src/ratelimit.rs`

A limit on every route, per caller (docs/rate-limits.md has the table).

Each route belongs to one tier: a count per window, kept in redis (`hit`: INCR and
EXPIRE NX in one trip, like `auth::bump`). The caller is the login when the cookie is a
real one, else the address caddy saw. Past the count: 429, `Retry-After` the seconds
left in the window. The handlers' own tighter limits (signup, login, dms, follows,
search, chat images, error reports) still apply on top of these.

What is not counted: a request with no X-Forwarded-For. Caddy sets it on everything it
passes, so one without it came from inside the compose network (video's heartbeat and
`attached` for its publishers, the tests, the dummy box's internal calls). And a
reserved-name request carrying the dummy password, the fake streams' box.

`RATE_LIMITS=off` in the environment turns the route limits off (a load test, a seed run
against a dev box). The handlers' own counts stay.

Redis down: the request goes through and a warning is logged. A limiter must not be
the reason the site is down; the handlers that need redis fail on their own.

`pub`: Who a count is for.

`pub`: `/api/health` asks postgres, redis, video and the bucket each time.

`pub`: `/watch/<name>`: html with a preview card, for people and link unfurlers.

`pub`: Every other GET of the api.

`pub`: Full-text searches: a dm thread's, a chat's history.

`pub`: Every other write: a bio, a follow, a dm, a read marker, join, leave.

`pub`: Signup, login, logout, password and name changes, on top of their own counts.

`pub`: Logging in with google or discord: starting one, the provider's redirect back, the
pick-a-name step, unlinking. By address: a start is a redis write each, a callback two
outbound https calls. A person needs a handful.

`pub`: A group's moderation and setup: kick, timeout, ban, roles, owners, channels, access.

`pub`: Anything that puts a file in the bucket: avatar, card pictures, offline picture,
scene assets, about page and its files, a group's icon and banner, a chat image, a group's emote.

`pub`: A chat video (chat_videos.rs): up to 10 mb each into a bucket on the box's own disk, so far
fewer than the other uploads, on top of the handler's own 5 per 10 minutes.

`pub`: Going live: a video probe and a session row each.

`pub`: The publisher's own calls on its stream: heartbeat (every 15s), stop, attached, viewers.

`pub`: A page's error reports, on top of debug.rs's own 60 per 10 minutes.

`pub`: Free names one caller may write to in an hour (a bio, a picture, a status on a name
nobody has written yet makes its row). A name already written this hour is free.

`pub`: Opening a chat room's socket (`api chat`), on top of its 8 per room per address.

`pub`: A chat's older lines, a speaker's lines, the lines around one.

`pub`: Opening the events socket (`api events`), on top of its open-at-once cap.

`pub`: The home list (`api home`).

`pub`: A container's `/health`.

`pub`: The tier of an api route, by its method and the path as written in the router.

`fn may_make_name`: Paths whose `{name}` a write may bring into being (`INSERT INTO streamers ... ON CONFLICT`).
Following makes a row for the followed name too, but follows.rs counts those already.

`pub`: Off only when RATE_LIMITS=off. Read once.

`pub`: The address caddy saw. None: nobody went through caddy (see the module's words).

`fn path_name`: The third segment of `/api/stream(er)s/<name>/...`, lowercased like `Name` does.

`pub`: One more for `key`. The count, and the seconds left in its window.

`async fn note_name`: `name` among the names `key` wrote this window. Refused (with the seconds left) when it
is a new one past `max`; a name already in is always fine.

`pub`: The answer past a limit: 429, `Retry-After`, and words a person can read.

`async fn check`: Count and check one request against its rule, for `subject` (already "acct:<id>",
"ip:<ip>" or "name:<n>:ip:<ip>"). Some(response) when it is over.

`pub`: The api's limiter: `route_layer`ed onto the main router, so the path is the matched one.

`pub`: The limiter for the processes that only know the address: `api chat`, `api events`, `api home`.

`pub`: `api chat`'s routes: the two sockets, the history, `/health`.

`pub`: `api events`'s routes: the socket, `/online` (inside only), `/health`.

`pub`: `api home`'s routes: the list and `/health`.

`pub`: Counts per address for one process, a fixed window each. Forgotten once their window is over.

`pub`: The monitor's page and its json: 120 a minute per address (the page asks every few seconds).

## `api/src/release.rs`

The release this box runs. The github action (`.github/workflows/images.yml`) numbers every
run that pushed the four images: `v1`, `v2`, ..., one more than the highest tag so far, put
on the commit as a git tag and on the images as `stream-<x>:v<n>` beside `:<commit>`.
`./scripts/deploy.sh` works out which release its tree is (the highest `v<n>` reachable
from HEAD; `v<n>+<commit>` when the images are newer than that tag) and, once `/api/health`
has answered 200, runs `api release <version> <commit>`: one row in `deploys`
(`schema.sql`) per run that ended well. The newest row is what `/api/health` says under
`version` and `deployed_at`.

In the database, not the environment, on purpose: a release that moved only the pages
would otherwise wait for the api container to be recreated before it was reported, and
a restart would lose it. See docs/debugging.md, "health".

`pub`: The newest deploy: its release and when. None on a box no deploy.sh run has finished on.

`pub`: `api release <version> [commit]`: one more row. The version is `v<n>`, or `v<n>+<commit>`
for a tree past the last tag (deploy.sh says which); any short printable word is taken.

## `api/src/s3.rs`

One s3 bucket.

`S3_ENDPOINT=off` (or empty) is the seaweedfs container in docker-compose: `http://s3:8333`,
bucket from `S3_BUCKET`, login `stream` / `stream-s3`. Those two are the literals on
the `s3` service, not `S3_ACCESS_KEY`. Startup waits until the bucket answers, the
same way postgres is waited on. The container creates the bucket; a missing one is
created here too.

A url is someone else's bucket (aws, r2, another s3). The key and secret are
required, the bucket is not created here, and a miss is a warning: the api still
serves. `S3_PATH_STYLE` empty means path-style, except `*.amazonaws.com`, which
wants virtual-hosted. Profile pictures are `avatars/<name>.jpg`. Stream
thumbnails are `thumbs/<name>/<id>.jpg`.

`const LOCAL_ENDPOINT`: Same literals as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` on the `s3` service.

`pub`: Create the container's bucket if it is missing, and do not return until it answers.
A real endpoint is checked once: a miss is logged and the api still starts.

`pub`: 2xx from a HEAD of the bucket, inside the caller's timeout.

`pub`: `Ok(None)` is a missing key.

`pub`: Bytes `start..=end` of a key (`Range: bytes=start-end`), for a chat video's seek
(chat_videos.rs). `Ok(None)` is a missing key. A bucket that ignores the range and sends
the whole object is cut here, so the caller always gets the part it asked for.

`pub`: A missing key is fine.

`async fn send_with`: `send`, with a `Range` header. Not one of the signed headers: sigv4 signs what it lists, and
a header it does not list rides along unsigned.

`fn authorization`: AWS sigv4, header auth, service `s3`. `headers` are lowercase names; this sorts them.

`fn uri_encode`: Encode one path segment the way sigv4 wants. `/` is left to the caller.

## `api/src/socket.rs`

The websocket plumbing `chat.rs` (the rooms) and `events.rs` (the gateway) share: the
limits, a send with a budget, the first frame with a timeout, the redis connection a
blocking tail needs. Lifted out of the chat with no change of behaviour; see docs/status.md.

`pub`: The browser has this long to send its first frame (the hello).

`pub`: Message and frame cap, set on the upgrade so axum refuses a bigger one before any parser sees it.

`pub`: A ping this often. A socket that sent nothing back (pong, text, anything)
for IDLE_LIMIT is a vanished peer and is dropped, so it stops being counted.

`pub`: After SIGTERM: how long `run` waits for the sockets to say goodbye.

`pub`: A frame that cannot be written in this long is a peer that stopped reading (a frozen
tab, a suspended laptop): dropped, like one that stopped answering pings. Otherwise
the handler would sit in the write for as long as the kernel keeps the socket.

`pub`: How long one XREAD waits for a new entry before coming back empty.

`pub`: The first text frame, within HELLO_TIMEOUT. None: nothing came in time, or it was not text.

`pub`: A connection of its own for `XREAD BLOCK`: it would stall the shared multiplexed one, and
the default 500ms response timeout would cut every block short.

`pub`: "1729000000000-3" -> (1729000000000, 3). Orders the same way redis does.

## `api/src/turnstile.rs`

Cloudflare Turnstile: a human check on signup and login. See docs/cloudflare-turnstile.md.

The page draws Cloudflare's widget with the public site key (`GET /api/config/turnstile`),
and the widget hands it a single-use token. The page sends it as `turnstile_token` with the
signup, the login or the oauth name pick, and `verify` asks Cloudflare's siteverify about it
with the secret before the route does anything expensive (argon2, the rate limit counters).

Config is the environment, read once at boot (`Config::from_env`): on only when
TURNSTILE_ENABLED is `true` or `1` and both TURNSTILE_SECRET and TURNSTILE_SITE_KEY are set.
The flag on with a key missing is logged as an error and stays off; nothing crashes.

Fails closed: while on, a token Cloudflare could not be asked about (a network error, a
non-2xx, an answer that does not parse) is refused like a bad one.

`const MAX_TOKEN_CHARS`: Cloudflare's tokens are at most 2048 characters; anything longer is not one.

`pub`: What the environment turned on. `keys` is None while off.

`fn usable_token`: A token worth sending to Cloudflare: there, not blank, not longer than one can be.

`struct Answer`: The part of siteverify's answer that matters: `success` true, and nothing else counts.

`fn passed`: Siteverify's body, read. Err for a body that is not its json.

`pub`: The human check, before anything expensive. Ok at once while off. `ip` is `client_ip`'s;
`?` (not known) is left out of the ask.

`async fn public_config`: `GET /api/config/turnstile`: `{ enabled, siteKey }` for the widget. Public.

## build and config files

### `api/Cargo.toml`

- a group emote is decoded and drawn again as a 128x128 webp here (emotes.rs): no metadata, no non-picture (at `image = { version = "0.25", default-features = false, features = ["png", "jpeg",`)
- rustls-tls (ring, roots built in): `api monitor` talks https to other boxes, and the api talks https when S3_ENDPOINT is a real bucket. the container bucket is plain http. (at `reqwest = { version = "0.12", default-features = false, features = ["json", "rus`)
- the whatwg parser, the one the browser's `new URL` is: a social link is kept only if it parses as http(s) with a host (docs/socials.md) (at `url = "2"`)
- the id behind a name (docs/ids.md). postgres makes them (gen_random_uuid); the api only carries them (at `uuid = { version = "1", features = ["serde"] }`)
- chat_videos.rs: limits on each ffmpeg run (setrlimit before exec), on the box only (at `[target.'cfg(target_os = "linux")'.dependencies]`)

### `api/Dockerfile`

- build context is the repo root (compose: context: ., dockerfile: api/Dockerfile) (at `FROM rust:1-bookworm AS build`)
- ffmpeg and ffprobe: a chat video's real length and codecs, its metadata-free copy and its poster (chat_videos.rs). debian's build, with libx264 for the copy's fallback (at `RUN apt-get update \`)
- /data is for `api monitor` (its one json file). owned by app here, so the named volume compose mounts there starts out writable by it (at `RUN useradd -r -u 10001 -s /usr/sbin/nologin app && mkdir /data && chown app:app`)
- the commit this was built from, reported by /api/health. set by deploy.sh; "dev" by hand. (at `ARG BUILD=dev`)

### `api/schema.sql`

- The baseline: the whole database as of 2026-11-19. The api applies this file at boot to an empty database (one with no `streamers` table) in one transaction, then the migrations after it (api/migrations, listed in api/src/schema.rs `MIGRATIONS`). Do not edit it: a change to the tables is a new migration, which reaches an existing database at its next boot, no reset. (at `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`)
- the one group every database has: the fake streams' pretend chatters wear its badge (at `INSERT INTO groups (name, badge, color, about)`)

### `api/src/monitor.html`

- the monitor's one page. built into the api binary (monitor.rs), polls /api/monitor every 10s. plain html and js on purpose: the monitor box has no node, no vite, no caddy. every piece of text goes in through textContent, never innerHTML: error reports come from strangers' browsers. the colours are the frontend's tokens (globals.css). (at `<html lang="en">`)
- the last 24 hours, newest on the right. an empty block is an hour with no checks yet (at `const bar = el('div', 'bar');`)
