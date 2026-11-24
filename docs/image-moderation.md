# Image moderation

Every picture someone uploads is checked by OpenAI's moderation endpoint before the api keeps it.
The code is `api/src/moderate.rs`, the tables are in migration `0015-image-moderation.sql`, and the
page side is `ChatImages` (ChatPanel.tsx) and `ChatVideoPlayer.tsx`.

## How it works

- `POST https://api.openai.com/v1/moderations`, model `omni-moderation-latest`, with one input:
  `{"type":"image_url","image_url":{"url":"data:<mime>;base64,..."}}`. Each call has a 5 second
  timeout. The key comes from `OPENAI_API_KEY` and is never logged.
- **The bytes checked are the bytes kept.** An emote is checked after `redraw` turns it into a
  webp. A chat video's poster is checked as the frame ffmpeg drew. Everything else is stored as
  the page sent it, so the upload itself is checked. Video bytes are never checked (see
  follow-ups). Stream chat videos stay off (`STREAM_CHAT_VIDEO = false`).
- **The api acts only on OpenAI's `categories` booleans.** There are no score thresholds of our
  own. `category_scores` is stored as it came back, on the `uploads` row.
- **Rate limit:** before each call, a per-uploader count in redis (`rl:moderate:acct:<id>`, or the
  address): 40 per 10 minutes, across every kind of upload. Past it the upload gets 429 `too many
  uploads, slow down`. This count is separate from the route tiers in docs/rate-limits.md.
- **`uploads` table:** every checked picture gets a row with key, kind, uploader, address,
  sha256, size, mime, `nsfw`, scores, and `accepted` or `rejected`. Writing the row is best
  effort: if the insert fails, the api logs it and the decision still stands.
- **Logs:** a refusal, or an accepted picture with a flag worth noting, is logged at `warn` with
  its sha256, the uploader's address and the categories. The bytes are never logged.

### Answers

| what happened | status | words |
| --- | --- | --- |
| refused by policy | 422 | `image rejected by moderation` (nothing stored) |
| no key, timeout, 429 from OpenAI, 5xx, any other non-2xx, unreadable answer | 503 | `image checks are down, try again later` |
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
| `model_thumb` | models.rs `upload` (`api models`, the CLI: no row, no count) | block (the run stops) | block | allowed |
| `chat_image`, `video_poster` in a **stream's chat** | chat.rs `accept`, checked when the line is said | block | block | log |
| `chat_image`, `video_poster` in a **DM or group channel** | dms.rs, chat.rs | allowed, `nsfw=true`, blurred | log | log |

A chat picture is uploaded before the api knows where it will be posted. So the upload keeps it
with `chat_images.nsfw` (sexual) and `chat_images.graphic` (violence/graphic) set, and the check
happens when a line names it (`moderate::may_post`). A stream's chat refuses a picture with
either flag. The refusal goes back over the socket as the room's error frame, with the words `image rejected by moderation`. A DM or a group channel accepts
both. To refuse sexual pictures in DMs and group channels too, flip
`DM_GROUP_IMAGE_BLOCK_SEXUAL` in moderate.rs to `true`: the upload is then refused right away,
because no destination would accept it.

**Blur.** `GET /api/chat-images/:id` answers 409 `sensitive` for a picture with `nsfw` set,
unless the request has `?show=1` or comes from the uploader. When a picture fails to load, the
page asks why (`whyGone`), draws it blurred with a `show` button, and loads the `?show=1` address
on click. A video's poster works the same way: the player is covered until `show` is pressed.

**Not checked:** profile.rs `lift_object` and `lift_legacy`. They move old avatars that are
already being served from their legacy location to the id key on a read. They are not new
uploads, and checking them would make a plain page view depend on OpenAI. The about page's text
html (`about_page.rs` `put_page`) is text. The model files and `models/index.json` are not
pictures.

Not done specially: `sexual/minors`. It is stored with the other categories and nothing extra
happens. `omni-moderation-csam-latest` is never called. CSAM detection is Cloudflare's job, see
the next section.

## Cloudflare CSAM Scanning Tool (a step for Billy)

1. Cloudflare dashboard → the zone → **Caching → Configuration → CSAM Scanning Tool**. Turn it on
   with Billy's email as the notification address, and accept the terms. Accepting them brings
   NCMEC reporting duties: a hit has to be reported to NCMEC by us (see the workflow below).
2. It only sees media that Cloudflare **caches**, which means **public** pictures: avatars,
   offline pictures, thumbnails, group pictures, emotes, about files, and stream chat pictures
   (`public, max-age=86400`). The cache rules have to cover those paths, or nothing gets scanned.
3. Known gap, accepted: DM and group channel pictures are `private, no-store`, so the tool never
   sees them. It also does not scan video.

## Rollback

Set `MODERATION_ENABLED=false` (or unset it) in `.env` and restart the api. The checks, the
count, and the `uploads` rows all stop, and every upload is kept as before. Flags already set
stay: `nsfw` pictures are still blurred in DMs and groups, and the say still refuses flagged
pictures in a stream's chat. To clear the flags too:
`UPDATE chat_images SET nsfw = false, graphic = false`. The migration is additive, so it can stay.

## Follow-ups (not in this PR)

- **CSAM-hit admin workflow:** keep the evidence for 1 year in a locked-down store, add a
  `csam_reports` row, delete the object and purge the Cloudflare cache, add a `site_bans` entry
  for the uploader, and have Billy file the NCMEC report.
- **A `Report image` button** on pictures, feeding the same admin queue.
- **Video frame sampling:** check several frames of a chat video, not just the poster. Until
  then, stream chat videos stay off.
- **Blur polish:** a per-viewer "always show" setting, and blur in the pins list's full view.
- Animated GIF assets and about files: OpenAI may refuse an animated GIF. When moderation is on,
  that upload is refused with 503. Check this, and if it happens, send the first frame.

## Pending Mod Guard sign-off

- Billy's calls to confirm: DM and group pictures are blurred, not refused, and violence/graphic
  in DMs and groups is only logged.
- Is 40 checks per uploader per 10 minutes right?
- Should a `sexual/minors` true get special handling (an alert, holding the evidence) before
  the CSAM workflow lands?
- Should stream chat pictures stay hard-blocked, or should viewers who opt in see them blurred?
- How long to keep `uploads` rows, which include addresses.
