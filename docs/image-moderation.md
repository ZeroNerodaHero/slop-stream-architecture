# Image moderation

Every picture someone uploads is checked by OpenAI's moderation endpoint before the api keeps it.
The code is `api/src/moderate.rs`, the tables are in migration `0015-image-moderation.sql`, and the
page side is `ChatImages` (ChatPanel.tsx) and `ChatVideoPlayer.tsx`.

## How it works

- `POST https://api.openai.com/v1/moderations`, model `omni-moderation-latest`, with one input:
  `{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}`. Each call has a 5 second
  timeout, from connect to the last byte. The key comes from `OPENAI_API_KEY` and is never logged.
- **Turning it on:** `MODERATION_ENABLED` is read once, and `true`, `1`, `yes` or `on` turns it on.
  Anything else, unset included, is off: nothing is asked and nothing is written. When it is on
  and `OPENAI_API_KEY` is empty, the api logs a `warn` at startup (the key itself is never logged)
  because every picture upload would then be refused with 503. The two lines in `.env.example`
  and `docker-compose.yml` default it to off.
- **The http client:** if reqwest cannot build the client with the timeout, the check does not
  fall back to a client without one. It fails closed: 503 like any other outage.
- **Size:** a picture over 20,000,000 bytes (`MAX_ASK_BYTES`) is never sent to OpenAI. `check`
  answers 413 `picture too big to check. 20 mb at most` before the count or the call. Every upload route has a smaller limit of
  its own today, so this is a guard for later routes.
- **The bytes checked are the bytes kept.** An emote is checked after `redraw` turns it into a
  webp. A chat video's poster is checked as the frame ffmpeg drew. Everything else is stored as
  the page sent it, so the upload itself is checked. Video bytes are never checked (see
  follow-ups). Stream chat videos stay off (`STREAM_CHAT_VIDEO = false`).
- **At most 4 calls at once:** one api process sends at most `MAX_ASKS_AT_ONCE` (4) moderation
  calls to OpenAI at the same time (a tokio `Semaphore` in `ask`). A check that waits more than 3
  seconds (`QUEUE_WAIT`) for a turn fails closed with the usual 503 `image checks are down, try
  again later`, and the log says how many were running. This bounds what a burst of uploads
  costs and keeps us under OpenAI's per-minute limits.
- **The sha256 is computed once per upload.** Chat pictures, video posters and emotes hash the
  bytes once and pass it to `check` (`Upload.sha`), which uses it for the log and the `uploads`
  row, and the caller uses it for its own table. Other kinds pass `None` and `check` hashes the
  bytes itself, only when moderation is on.
- **The api acts only on OpenAI's `categories` booleans.** There are no score thresholds of our
  own. `category_scores` is stored as it came back, on the `uploads` row.
- **Rate limit:** before each call, a per-uploader count in redis (`rl:moderate:acct:<id>`, or the
  address): 40 per 10 minutes, across every kind of upload. Past it the upload gets 429 `too many
  uploads, slow down`. This count is separate from the route tiers in docs/rate-limits.md. It is
  above chat pictures' own 30 per 10 minutes, so a person sending pictures never meets it, but a
  script spending our moderation quota does.
- **Who the uploader is:** the logged-in account. For a profile or about page write made with the
  name's password and no login, it is the name's own row.
- **`uploads` table:** every checked picture gets a row with key, kind, uploader, address,
  sha256, size, mime, `nsfw` (`sexual`), `graphic` (`violence/graphic`), `categories` (OpenAI's
  booleans as sent), `scores` (`category_scores` as sent), and `accepted` or `rejected`. The flags
  are written for refused pictures too, so a rejected row says why. `key` is the bucket key of a
  kept picture; a refused one was never stored and has none. For a picture whose key is only
  known after the put (a thumbnail, an asset, an about file, an emote, a chat picture), the key
  is filled in afterwards. Writing the row is best effort: if the insert fails, the api logs it
  and the decision still stands.
- **`uploads.uploader_name`:** a snapshot of the uploader's name, filled in by the insert from
  `streamers`. `uploader_id` is `ON DELETE SET NULL`, so when an account is deleted the id goes
  but the name stays on the row, and the evidence still says who sent it.
- **XFF:** the address on the row and in the logs comes from `ratelimit::forwarded_ip`. Trusting
  `X-Forwarded-For` only from our own proxy was fixed in #177, so this PR adds nothing for it.
- **Logs:** a refusal, or an accepted picture with a flag worth noting, is logged at `warn` with
  its sha256, the uploader's address and the categories. The bytes are never logged.

### Answers

| what happened | status | words |
| --- | --- | --- |
| refused by policy | 422 | `image rejected by moderation` (nothing stored) |
| animated picture on a public kind | 422 | `animated images aren't allowed` |
| video on the about page | 422 | `videos can't be added to the about page while image checks are on` |
| over 20,000,000 bytes | 413 | `picture too big to check. 20 mb at most` |
| stream chat line naming a picture that was never checked | error frame | `this picture was never checked, send it again` |
| no key, timeout, 429 from OpenAI, 5xx, any other non-2xx, unreadable answer, no free slot within 3 s | 503 | `image checks are down, try again later` |
| `GET` of a sexual picture posted in a group whose adult content is now off | 403 | `hidden` |
| over the per-uploader count | 429 | `too many uploads, slow down` |

When moderation is on, any failure of the check refuses the upload (fail closed). The pages
already show the api's `error` words where an upload fails: the avatar, offline picture,
thumbnail and asset status lines, the about page status, the group picture errors, the emote
dialog, and the chat notice. One gap: MakeGroupDialog drops a failed icon or banner on purpose.
The group is still made, and its room offers the picture again, with the words shown there.

### OpenAI's own rate limits

The numbers are not copied into the code or into this doc, because they change by account tier.
See the model page, which has the per-tier RPM/RPD/TPM table:
<https://developers.openai.com/api/docs/models/omni-moderation-latest>, and the general guide:
<https://platform.openai.com/docs/guides/rate-limits>. The endpoint sends no rate-limit headers,
according to reports on OpenAI's developer forum. A 429 from OpenAI is handled like any other
outage: 503, and the upload is refused.

## Policy

| kind (`uploads.kind`) | where it is put | `sexual` | `violence/graphic` | `violence`, `self-harm*` |
| --- | --- | --- | --- | --- |
| `avatar` | profile.rs `put_avatar` | block | block | log |
| `offline` | profile.rs `put_offline` | block | block | log |
| `thumb` | profile.rs `put_thumb` | block | block | log |
| `asset` | profile.rs `put_asset` | block | block | log |
| `about_file` (pictures only) | about_page.rs `put_file` | block | block | log |
| `group_icon`, `group_banner` | group_mod.rs `write_picture` | block | block | log |
| `emote` | emotes.rs `screen` | block | block | log |
| `model_thumb` | models.rs `upload` (`api models`, the CLI: no row, no count, animated refused) | block (the run stops) | block | allowed |
| `chat_image`, `video_poster` in a **stream's chat** | chat.rs `accept`, checked when the line is said | block | block | log |
| `chat_image`, `video_poster` in a **group channel**, adult content off (the default) | chat.rs `accept` | block | log, blurred | log |
| `chat_image`, `video_poster` in a **group channel**, adult content on | chat.rs `accept` | allowed, `nsfw=true`, blurred | log, blurred | log |
| `chat_image`, `video_poster` in a **DM** | dms.rs `send` | allowed, `nsfw=true`, blurred | log, blurred | log |

A chat picture is uploaded before the api knows where it will be posted. So the upload keeps it
with `chat_images.nsfw` (sexual) and `chat_images.graphic` (violence/graphic) set, and the check
happens when a line names it (`moderate::may_post`). The place decides the policy
(`moderate::place_policy`):

- A stream's chat refuses a picture with either flag, like the public kinds.
- A group channel refuses a sexual picture, like the public kinds, unless the group's owner
  turned adult content on (`groups.adult_content`, read by `moderate::group_place` on every line
  with a picture). With it on, sexual pictures are accepted with `nsfw` and blurred.
- A DM accepts both flags, and the picture is blurred.

`violence/graphic` is only logged (and blurred) in group channels and DMs, either way. The
refusal goes back over the socket as the room's error frame, or as the 422 of `POST` on a DM,
with the words `image rejected by moderation`.

The say's check is chat.rs `pictures_allowed` (a stream's chat or a group channel) and the same
call in dms.rs `send`. A line with no picture and no video skips it. It covers the line's pictures and its video's poster. If postgres cannot
answer, a stream or group line is refused with `chat is busy, try again`.

**Blur.** `GET /api/chat-images/:id` answers 409 `sensitive` for a picture with `nsfw` or
`graphic` set, unless the request has `?show=1` or comes from the uploader. Only DMs and group
channels can have such a picture, because a stream's chat refuses both flags. When a picture
fails to load, the page asks why (`whyGone` in `chat-video.ts`) and draws a plain `sensitive`
box with a `show` button in its place (`ChatImages` in ChatPanel.tsx). The box is a placeholder,
not the picture blurred by CSS: no byte of the picture reaches the browser before the click, so
it cannot be pulled out of the page, the cache or devtools. On click it loads the `?show=1`
address (`shownSrc`) and draws it like any other picture, full-size view included. In the
full-size view (`PictureView`), a flagged picture not shown yet is the same box, with its own
`show` button, when the arrows reach it. A video's poster works the same way
(`ChatVideoPlayer.tsx`): the player is replaced by the box until `show` is pressed, and no poster
is loaded before. The player is measured again after that, so the chat scroll stays right.

**Hidden.** A group without adult content can still hold `graphic` pictures (blurred, as above),
and `nsfw` ones posted while adult content was on. Turning adult content off (by the owner or by
a site admin) refuses new ones and hides the old ones: `GET /api/chat-images/:id` answers 403
`hidden` for a picture with `nsfw` set, posted in a group (`posted_kind = 'group'`) whose
`adult_content` is false now, even with `?show=1`. The uploader and the site admins
(`ADMIN_NAMES`) still get it. Nothing is deleted: turning adult content back on shows them again
(blurred). A group that no longer exists counts as off. A chat video whose poster is such a
picture is hidden the same way on `GET /api/chat-videos/:id`. The page reads the 403's `error`
(`whyGone` asks again with a `GET`, since a `HEAD` has no body) and draws `hidden: adult content is
off in this group` in the picture's or the video's place (`MediaGoneNote`). The rule is
`moderate::hidden`.

**Animated pictures.** While moderation is on, an animated picture is refused with 422 `animated
images aren't allowed` on the public kinds that keep the bytes as sent: scene assets (profile.rs
`put_asset`), about files (about_page.rs `put_file`), and chat pictures (chat_images.rs
`upload`). OpenAI looks at one frame, so the other frames of an animation would go unchecked.
`moderate::is_animated` sniffs the bytes:

- GIF: it walks the blocks (header, global color table, extensions and their sub-blocks, image
  descriptors with their local color table and data). More than one image descriptor means
  animated. A `0x2C` byte inside a color table or frame data is not counted. It fails closed:
  only the `0x3B` trailer is a clean end. Any other byte where a block should start, and any
  file that runs out once the first frame has begun, counts as animated, because a decoder may
  skip the junk and find more frames after it. A file that runs out before any frame is not
  animated (it has nothing to show).
- WebP: the `VP8X` animation flag (`0x02`), or an `ANIM` or `ANMF` chunk.
- PNG: an `acTL` chunk before the first `IDAT`. An `acTL` after `IDAT` is ignored, as the APNG
  spec says.

Model thumbnails (`api models`) are refused when animated too, with `animated images aren't
allowed`, while `MODERATION_ENABLED` is set in the CLI's shell. Emotes are exempt, because
`redraw` turns every emote into one still webp. Avatars, offline
pictures, thumbnails and group pictures are JPEG only. When moderation is off, animated pictures
are accepted as before.

**The `moderated` flag.** `chat_images.moderated` is set to true when the check ran on the upload.
Rows made before this migration, or while moderation was off, stay false. While moderation is
on, a line in a stream's chat that names a picture (or a video poster) with `moderated = false`
is refused with `this picture was never checked, send it again`. So a picture uploaded while
moderation was off cannot be posted publicly later without a check. A group channel without adult
content refuses it the same way, since an unchecked picture could be sexual. DMs and groups with
adult content on do not look at the flag.

**About page videos.** While moderation is on, `PUT` of `type=video` on the about page is refused
with 422 `videos can't be added to the about page while image checks are on`. This is a known
gap, on purpose: no frame of the video is checked yet, and the about page is public. It goes away
when video frame sampling lands (see follow-ups). Sounds are still accepted.

**The `api models` CLI.** `check_offline` only checks when `MODERATION_ENABLED` is set in the
shell that runs `api models`. It does not read the api container's environment. Without it, model
thumbnails go up unchecked. With it, a refused or unchecked thumbnail stops the run before
anything of that model is uploaded. It keeps no `uploads` row and does no count, because the CLI
runs without postgres or redis. The model file itself is not a picture and is not checked.

**Emotes.** emotes.rs `screen` is the only moderation hook for emotes, and every emote upload
goes through it. It has to fail closed: a check that errors, times out or cannot be reached
refuses the upload.

**Not checked:** profile.rs `lift_object` and `lift_legacy`. They move old avatars that are
already being served from their legacy location to the id key on a read. They are not new
uploads, and checking them would make a plain page view depend on OpenAI. The about page's text
html (`about_page.rs` `put_page`) is text. The model files and `models/index.json` are not
pictures.

Not done specially: `sexual/minors`. It is stored with the other categories and nothing extra
happens. `omni-moderation-csam-latest` is never called. CSAM detection is Cloudflare's job, see
the next section.

## Adult content in groups

Each group has `groups.adult_content` (migration 0015), false by default.
`PUT /api/groups/:group/adult` `{"adult": true|false}` changes it and answers
`{"adult": ..., "locked": ...}`. 401 for nobody, 404 for no such group. Who may do what
(`moderate::adult_change`):

- An owner turns it on or off, unless a site admin locked it (below).
- A site admin (`ADMIN_NAMES`) who is not an owner can only turn it off: 403 `site admins can only
  turn adult content off` for on. Turning it off records the admin's id in
  `groups.adult_locked_by` (uuid, no foreign key, so the lock stays if that account goes).
- While `adult_locked_by` is set, turning it on is refused for everyone with 403 `a site admin
  turned adult content off for this group, so it can't be turned back on`. The update checks the
  lock in the same statement, so a race with the admin cannot slip past it. Owners can still
  turn it off (it already is). Only the database lifts a lock:
  `UPDATE groups SET adult_locked_by = NULL WHERE name = '<group>'`.
- An owner who is also a site admin acts as the owner: turning it off does not lock.
- Anyone else: 403 `only an owner changes this`.

Turning it off, by anyone, hides the sexual pictures already posted (see Hidden). The room's
members hear it as the `adult` fact (`{adult, locked}`), and `GET /api/groups/:group` says `adult`
and `adult_locked`. The page's switch is the `adult content` section of the manage dialog's about
tab (ServerRoom.tsx `AdultSection`), drawn for owners and site admins. When a change is not
allowed, the `turn on` button is disabled and a line under it says why (locked by a site admin,
or site admins can only turn it off), and the state reads `off, locked`.

While it is on:

- sexual pictures are accepted in the group's channels, marked `nsfw` and blurred (see Policy);
- the group is left off every list and search for anyone not in it, whatever its `public` says:
  `GET /api/groups` (the groups tab of the user settings) and `GET /api/explore` (`discover`,
  which the explore page, the home page's groups and the friends panel's search read). Members
  still see it in their own lists (`yours`). These two are the only api routes that list groups; there is no sitemap.
  Anyone with the address or an invite can open the room and join, as with a private group.
- the member list is not public, whatever `public` says (`moderate::roster_public`: public only
  when `public && !adult_content`). The room's `roster`, `GET /api/groups/:group/members` and
  `GET /api/groups/:group/members/:name` (`sees_roster`) answer it only to members and site admins.
- its badge is never worn on public surfaces. `groups::badges_of` (chat lines in every chat,
  chat.rs) and `groups::badges_by_name` / `badge_of` (the home list's cards, home.rs, and a
  name's card, main.rs) skip groups with adult content on: a member whose primary group is one
  wears their next group's badge (primary first, then by join date), or none. `badges_named`
  (the inbox's channel rows, notify.rs) is only shown to members and still includes it.

The group's own icon and banner are public kinds and stay blocked for sexual and graphic
pictures either way.

## Cloudflare CSAM Scanning Tool (a step for Billy)

1. Cloudflare dashboard → the zone → **Caching → Configuration → CSAM Scanning Tool**. Turn it on
   with Billy's email as the notification address, and accept the terms. Accepting them brings
   NCMEC reporting duties: a hit has to be reported to NCMEC by us (see the workflow below).
2. It only sees media that Cloudflare **caches**, which means **public** pictures: avatars,
   offline pictures, thumbnails, group pictures, emotes, about files, and stream chat pictures
   (`public, max-age=86400`). The cache rules have to cover those paths, or nothing gets scanned.
3. Known gap, accepted: DM and group channel pictures are `private, no-store`, so the tool never
   sees them. That includes groups with adult content on. It also does not scan video.

## Rollback

Set `MODERATION_ENABLED=false` (or unset it) in `.env` and restart the api. The checks, the
count, the animated and about-video refusals, the `moderated` gate on stream chat, and the
`uploads` rows all stop, and every upload is kept as before. Flags already set
stay: `nsfw` and `graphic` pictures are still blurred in DMs and groups, and the say still refuses flagged
pictures in a stream's chat and in groups without adult content. A group's `adult_content` stays
as its owner set it, so it stays off the lists, and an admin's lock (`adult_locked_by`) stays too. To clear the flags too:
`UPDATE chat_images SET nsfw = false, graphic = false`. The migration is additive, so it can stay.

## Follow-ups (not in this PR)

- **CSAM-hit admin workflow:** keep the evidence for 1 year in a locked-down store, add a
  `csam_reports` row, delete the object and purge the Cloudflare cache, add a `site_bans` entry
  for the uploader, and have Billy file the NCMEC report.
- **A `Report image` button** on pictures, feeding the same admin queue.
- **Video frame sampling:** check several frames of a chat video, not just the poster. Until
  then, stream chat videos stay off, and about page videos are refused while moderation is on.
- **Animated pictures:** check several frames instead of refusing animated assets, about files
  and chat pictures.
- **Blur polish:** a per-viewer "always show" setting, and blur in the pins list's full view.

## Pending Mod Guard sign-off

- Billy's calls to confirm: DM pictures are blurred, not refused; group pictures follow the
  group's adult content switch (off by default: sexual refused); violence/graphic in DMs and
  groups is only logged and blurred.
- Is 40 checks per uploader per 10 minutes right?
- Should a `sexual/minors` true get special handling (an alert, holding the evidence) before
  the CSAM workflow lands?
- Should stream chat pictures stay hard-blocked, or should viewers who opt in see them blurred?
- How long to keep `uploads` rows, which include addresses.
