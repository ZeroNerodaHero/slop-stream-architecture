# about

built: a tab under the player, `about`, beside `calendar` (`calendar.md`) and `socials` (`socials.md`). the one-line status (`bio`) sits under the name; the tab itself is a page of the person's own, the way a myspace or a neocities page was theirs: blocks laid out on a canvas, each one a kind (`text`, `image`, `video`, `sound`, and the shapes `line`, `box`, `border`) with a place (`x`, `y`, `z`) and a size (`w`, `h`). no scripts and no css of their own, by construction: there is no block that takes either. a name that has saved nothing shows `<name> hasn't made a page yet.`, the fake streams included: they load their page from the api like everyone else.

the code: `api/src/about_page.rs` (the document, the files, the cleaning), the `about_page` jsonb column on `streamers` (`api/schema.sql`), `api/src/profile.rs` (`put_about`), `frontend/src/infra/about.ts`, `frontend/src/shared-components/About.tsx` (the tab and, on your own page, the editor), `frontend/src/app/watch/WatchPage.tsx`, `test/about.js`.

## about me

the column is not drawn by the tab any more (the tab is the page of blocks), but it is still written and read:

- **one column**, `about text NOT NULL DEFAULT ''` on `streamers` (`schema.sql`), beside `bio` and `offline_note`. replaced whole through the bio's gate (`may_write`: a free name is anyone's, a claimed name its login's, a `dummy-` name the dummy box's) and the bio's upsert, so a name nobody saved anything for gets its row here too.
- **`PUT /api/streamers/:name/about[?password=]`**, body `{ about }` → `{ name, about }` as kept: a chat line's cleaning (`clean_text`: no control or invisible characters, no zalgo, two newlines in a row at most), trimmed, 2000 characters at most, cut not refused (it is prose, like the status and the offline line). empty clears it. `bad json body` for a body of another shape, the two 403s of the gate.
- **on the reads.** `GET /api/streamers/:name` and the watch grant (`POST /api/streams/:name/watch`) both carry `about`. no page draws it or writes it today; `test/about.js` writes and reads it through the api.

## the page of blocks

- **the document** is `{ blocks: [...] }` in `streamers.about_page`, 40 blocks at most (`BLOCKS_MAX`), positions clamped to 0 to 1600 and z to 0 to 40, a size between the kind's smallest (80 by 40) and 800. a missing size takes the kind's usual box.
- **routes**: `GET /api/streamers/:name/about-page` (public, cached), `PUT /api/streamers/:name/about-page[?password=]` with `{ blocks }`, `PUT /api/streamers/:name/about-file[?password=]` for one picture, clip or track, and `GET /api/streamers/:name/about-file/:id` for its bytes. writes go through the bio's gate (`may_write`). a bad block is a 400 with the api's words (`bad type. one of text, image, video, sound, line, box, border`, `upload the file first`, `that file is a different kind`, `a block is on the page twice`).
- **files** go up on their own and the document names them by id. the kind is sniffed from the bytes, not trusted from the name: png, jpeg, gif, webp pictures; mp4 and webm clips; mp3 and m4a sound. caps: a picture 2 MB, a clip 12 MB, a track 8 MB, the document 2 MB. every upload goes through image moderation (`image-moderation.md`); with moderation on, an animated picture and any clip are refused (422).
- **text** is html, but only a fragment of the tags a line needs: `p`, `br`, `b`, `strong`, `i`, `em`, `u`, `s`, `a`, `ul`, `ol`, `li`, `h2`, `h3`, `blockquote`. a `div` becomes a `p`. a link is http or https or it is not a link. `script`, `style`, `iframe`, `svg`, `form` and the rest are dropped with what is inside them. cut at 10 000 characters (`TEXT_MAX`). the api cleans it (`sanitize_html` in `about_page.rs`) and keeps the cleaned string in the bucket; the page cleans it again before it draws it (`sanitizeHtml` in `about.ts`).
- **the look** of a block is a few fields, each checked by the api: a font from a fixed list of families already on the machine (nothing is fetched), a size from 12 to 96, `#rrggbb` colors for the text, the fill and the stroke, a stroke width, a turn (`r`, a rotation), an alignment. anything else is dropped.
- **the sample**: on your own empty page, `start from a sample` (`startSample` in `About.tsx`) writes a starter paragraph and uploads `/about-demo/banner.jpg` and `/about-demo/track-1.mp3` as your own files. the demo media is in `frontend/public/about-demo/`.

## not this

- **html as a document.** a text block is a fragment: the tags above, nothing that loads or runs.
- **iframes, embeds, oembed.** a youtube or spotify embed is somebody else's page inside ours, with its own scripts and cookies. a clip block takes a file of their own instead.
- **pictures from anywhere.** a hotlinked picture is a request from every viewer to a host the author chose: an address log. a page's media is its own uploads.
- **css of their own.** an earlier version of this tab took a stylesheet per page and scoped it; the canvas with checked look fields replaced it, and there is no css field in the document now.
