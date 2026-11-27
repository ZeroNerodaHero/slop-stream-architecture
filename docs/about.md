# about

built: a tab under the player, `about`, beside `calendar` (`calendar.md`) and `socials` (`socials.md`). the one-line status (`bio`) sits under the name; the tab itself is a page of the person's own, the way a myspace or a neocities page was theirs: blocks on a 12-column grid, each one a kind with a width and a few checked looks. no scripts and no css of their own, by construction: there is no block that takes either. a name that has saved nothing shows `<name> hasn't made a page yet.`, the fake streams included: they load their page from the api like everyone else.

the code: `api/src/about_blocks.rs` and `api/src/about_md.rs` (the block page), `api/src/about_page.rs` (the files, the cleaning, the old document), the `about_page`, `about_draft` and `about_live` jsonb columns on `streamers`, `api/src/profile.rs` (`put_about`), `frontend/src/infra/about.ts`, `frontend/src/shared-components/About.tsx` (the tab and, on your own page, the editor), `frontend/src/app/watch/WatchPage.tsx`, `test/about.js`.

## about me

the column is not drawn by the tab any more (the tab is the page of blocks), but it is still written and read:

- **one column**, `about text NOT NULL DEFAULT ''` on `streamers` (`schema.sql`), beside `bio` and `offline_note`. replaced whole through the bio's gate (`may_write`: a free name is anyone's, a claimed name its login's, a `dummy-` name the dummy box's) and the bio's upsert, so a name nobody saved anything for gets its row here too.
- **`PUT /api/streamers/:name/about[?password=]`**, body `{ about }` → `{ name, about }` as kept: a chat line's cleaning (`clean_text`: no control or invisible characters, no zalgo, two newlines in a row at most), trimmed, 2000 characters at most, cut not refused (it is prose, like the status and the offline line). empty clears it. `bad json body` for a body of another shape, the two 403s of the gate.
- **on the reads.** `GET /api/streamers/:name` and the watch grant (`POST /api/streams/:name/watch`) both carry `about`. no page draws it or writes it today; `test/about.js` writes and reads it through the api.

## the block page

the tab is a 12-column grid of blocks, kept in two jsonb columns on `streamers` (migration `0022-about-blocks`): `about_draft`, what the owner is editing, and `about_live`, what everyone else sees. each is `{ v: 2, blocks: [...] }`, an ordered list: the grid fills left to right in that order and wraps. the code is `api/src/about_blocks.rs` (the document, the upgrade, the files), `api/src/about_md.rs` (markdown), `frontend/src/infra/about-blocks.ts`, `frontend/src/shared-components/About.tsx` (the viewer) and `frontend/src/shared-components/about/` (the builder).

- **a block** is `{ id, kind, span, phone, fill, accent, font, align, href, title, sub, md, file, bg, label, link, socials, items }`. `kind` is one of `heading`, `text`, `panel`, `image`, `gallery`, `buttons`, `socials`, `schedule`, `clip`, `sound`, `stats`, `quote`, `divider`. `span` is 3 to 12 columns, `phone` is `full`, `half` or `hide`, `fill` is `none`, `card`, `accent` or `image` (`bg` names the picture), `accent` a `#rrggbb`, `font` one of `geist`, `mono`, `serif`, `display`, `align` `left`, `center` or `right`. the api keeps only the fields a kind uses and drops the rest:
  - `heading`: `title`, `sub`, `href`. `text`: `md`, `href`. `panel`: `title`, a picture (`file`) linked by `href`, `md`, a button (`label`, `link`). `image`: `file`, a caption (`title`), `href`. `gallery`: up to 12 `items` of `{ file, label, href }`. `buttons`: up to 12 `items` of `{ label, href }`. `socials`: the name's socials (`socials.md`). `schedule`: `title`, the days the calendar has streams on (`calendar.md`), a note (`md`). `clip` and `sound`: `title`, `file`. `stats`: followers, streams and joined, and the socials under them with `socials: true`. `quote`: `md`, who said it (`sub`). `divider`: a line, with an optional word (`title`).
- **limits**: 60 blocks (`BLOCKS_MAX`), a title 80 characters, a sub line 160, a label 40, markdown 10 000, 12 items. a link is http or https (`not a link. it needs to be an http or https address`), a file must be this name's and of the kind the field wants (`no such file`, `that file is a different kind`), an unknown kind is `bad kind. one of …`, two blocks with one id `a block is on the page twice`. ids are `a-z 0-9 -`, 16 at most; a missing or bad id gets a new one.
- **markdown** is turned into html on the server, every time a page is read: `#` and `##` are `h2`, `###` and deeper `h3`, `- ` `* ` `+ ` and `1. ` lists, `> ` quotes, `**strong**`, `*em*` or `_em_`, `__underline__`, `~~strike~~`, `[words](https://…)` and bare `https://` addresses as links, a backslash before a mark keeps it. everything else is text, escaped, and the result goes through `sanitize_html` (the tags below), so no markup the writer types survives. each block comes back with its `html` beside its `md`.
- **routes**:
  - `GET /api/streamers/:name/about-blocks` (public, cached 30 s at the edge): the live page, with `followers`, `streams`, `joined` and `socials` for the stats and socials blocks.
  - `GET /api/streamers/:name/about-blocks/draft[?password=]`: the draft, for the owner, with `changed` (the draft is not what is live).
  - `PUT /api/streamers/:name/about-blocks[?password=]` with `{ blocks }`: keeps the draft. viewers see nothing new.
  - `POST /api/streamers/:name/about-blocks/publish[?password=]`: the draft becomes the live page and the draft column is cleared.
  - writes go through the bio's gate (`may_write`) and the about page's lock.
- **files** are the about files below: the same upload route, the same sniffing, the same caps (a picture 2 MB, a clip 12 MB, a track 8 MB) and the same image moderation. a name has 60 of them at most, text not counted. a file is kept while the draft, the live page or the old page names it; one that none of them names and is over an hour old is deleted on the next save or publish.

## the upgrade from cards

nothing is copied by the migration: until a name saves or publishes a block page, both reads build one from the old document on the fly (`upgrade` in `about_blocks.rs`), so an old page shows as it was, and the old document, its text files and its pictures stay where they are.

- each card that is on and has something in it becomes a `panel` of 6 columns, in the cards' order: its title, its body as markdown (escaped, so `*` stays a star; `1. ` lines become a list), its link as the panel's button (the label is the address without `www.`), its first picture as the panel's picture. its other files follow it as `image`, `clip` or `sound` blocks. a card that was off is left out of the new page (it is still in `about_page`).
- every other old block, in reading order (`y`, then `x`): text becomes a `text` block (its html turned back into markdown), a picture, clip or track its own block, each as wide as it was (`w` out of 800, in twelfths). lines, boxes and borders are dropped.
- the upgraded blocks have the ids `u0`, `u1`, …, the same on every read.

## the old page

the document the tab used before the blocks, still read and written for a frontend that has not been updated:

- **the document** is `{ blocks: [...] }` in `streamers.about_page`, 60 blocks at most (`BLOCKS_MAX`), positions clamped to 0 to 1600 and z to 0 to 40, a size between the kind's smallest (80 by 40) and 800. a missing size takes the kind's usual box.
- **routes**: `GET /api/streamers/:name/about-page` (public, cached), `PUT /api/streamers/:name/about-page[?password=]` with `{ blocks }`, `PUT /api/streamers/:name/about-file[?password=]` for one picture, clip or track, and `GET /api/streamers/:name/about-file/:id` for its bytes. writes go through the bio's gate (`may_write`). a bad block is a 400 with the api's words (`bad type. one of text, image, video, sound, line, box, border`, `upload the file first`, `that file is a different kind`, `a block is on the page twice`). a save here never deletes a file the block page names.
- **files** go up on their own and the document names them by id. the kind is sniffed from the bytes, not trusted from the name: png, jpeg, gif, webp pictures; mp4 and webm clips; mp3 and m4a sound. caps: a picture 2 MB, a clip 12 MB, a track 8 MB, the document 2 MB. every upload goes through image moderation (`image-moderation.md`); with moderation on, an animated picture and any clip are refused (422).
- **text** is html, but only a fragment of the tags a line needs: `p`, `br`, `b`, `strong`, `i`, `em`, `u`, `s`, `a`, `ul`, `ol`, `li`, `h2`, `h3`, `blockquote`. a `div` becomes a `p`. a link is http or https or it is not a link. `script`, `style`, `iframe`, `svg`, `form` and the rest are dropped with what is inside them. cut at 10 000 characters (`TEXT_MAX`). the api cleans it (`sanitize_html` in `about_page.rs`) and keeps the cleaned string in the bucket.
- **the look** of a block is a few fields, each checked by the api: a font from a fixed list of families already on the machine (nothing is fetched), a size from 12 to 96, `#rrggbb` colors for the text, the fill and the stroke, a stroke width, a turn (`r`, a rotation), an alignment. anything else is dropped.
- **the cards** that wrote it (`what i stream`, `when i'm on`, `my setup`, `rules`, `links`, `faq`, `more`) sat at `x = 1600`, `y` the card's slot times 100 plus a part (0 to 49 its text, 50 to 99 its files), `z` 1 when on. a card's text was `<h3>title</h3><p>body</p>` and, with a link, `<blockquote>link</blockquote>`, every character escaped; a long body went on in `<p>` blocks at the next parts.

## not this

- **html as a document.** a text block is a fragment: the tags above, nothing that loads or runs.
- **iframes, embeds, oembed.** a youtube or spotify embed is somebody else's page inside ours, with its own scripts and cookies. a clip block takes a file of their own instead.
- **pictures from anywhere.** a hotlinked picture is a request from every viewer to a host the author chose: an address log. a page's media is its own uploads.
- **css of their own.** an earlier version of this tab took a stylesheet per page and scoped it; the canvas with checked look fields replaced it, and there is no css field in the document now.
