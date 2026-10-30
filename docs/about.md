# about

built: a tab under the player, `about`, beside `calendar` (`calendar.md`) and `socials` (`socials.md`). the one-line status (`bio`) sits under the name; the tab itself is the page of blocks. the viewer's half of a page of the person's own, the way a myspace or a neocities page was theirs: blocks of fixed kinds (words, a heading, a picture, a gallery, a clip, a music player, links, a rule) and css of their own over all of it. no scripts, by construction: there is no block that takes one. the document the tab draws is a sample until that name has saved a page. a saved page is json, `{ type, id, x, y, z, w, h }`, and the bytes are in the bucket (`about_page.rs`). `api/migrations/migrate-12.sql`, `api/migrations/migrate-20.sql`, `api/src/profile.rs` (`put_about`), `api/src/about_page.rs`, `main.rs` (the two json literals), `frontend/src/infra/about.ts`, `atoms/profile-atoms.ts`, `atoms/watch-atoms.ts`, `shared-components/AboutMe.tsx`, `shared-components/About.tsx`, `shared-components/AboutCanvas.tsx`, `WatchPage.tsx`, `test/about.js`.

## about me

not on the tab. the status under the name is the one line, and the tab is the page of blocks. the column is still `streamers.about` (below); nothing on the page reads it.

the status (`spec.md`: one line about you, set in the profile tab and on the go live page, under your name on your page) is for what you are up to. this column was the longer piece that used to sit at the top of the tab.

- **one column**, `about text NOT NULL DEFAULT ''` on `streamers` (`migrate-12.sql`), beside `bio` and `offline_note`. replaced whole through the bio's gate (`may_write`: a free name is anyone's, a claimed name its login's, a `dummy-` name the dummy box's) and the bio's upsert, so a name nobody saved anything for gets its row here too.
- **`PUT /api/streamers/:name/about[?password=]`**, body `{ about }` → `{ name, about }` as kept: a chat line's cleaning (`clean_text`: no control or invisible characters, no zalgo, two newlines in a row at most), trimmed, 2000 characters at most, cut not refused (it is prose, like the status and the offline line). empty clears it. `bad json body` for a body of another shape, the two 403s of the gate.
- **on the reads.** `GET /api/streamers/:name` and the watch grant (`POST /api/streams/:name/watch`) both carry `about`, so the tab draws it with no request of its own, like the links. not on the home card, the people, the search or the chats: a paragraph is a thing on the person's page, not beside their face in a list.
- **the page** (`AboutMe.tsx`, first in `#panel-about`): `#about-me`, a `whitespace-pre-wrap` paragraph; nothing at all on a stranger's page with none written. on your own page: `yours. edit it` under the words (`#about-me-edit`), or with none yet a line and a `write it` button (`#about-me`, `data-empty`). either swaps the words for the box in their place (`#about-me-editor`: `#about-me-text`, 2000 characters with `#about-me-count` counting down; `save` `#about-me-save`; `done` `#about-me-done`, outside the `fieldset` so it works with the box off; `#about-me-status`: `saving`, `saved`, `cleared`, `not saved: …`, or `whyNotEditAtom`'s words with the box off). the draft is `profileAboutAtom` in `profile-atoms.ts`, loaded by `loadMyProfile` with the status and the links (the page's own words seed an untouched draft first, so the box does not open empty while it loads); `done` keeps an unsaved draft for next time. a save lands on the page at once (`alsoOnWatchPage` → `watch-atoms`' `aboutAtom`), no reload; a watcher's page learns on its next grant.
- **why on the page and not in the settings modal.** you are writing what the tab shows, and the tab is where you can see it; the modal is for things about you (the picture, the name, the status, the presence choice). the profile tab's `your page` section points here.

```mermaid
flowchart LR
  doc["the document · blocks + css"] --> blocks["react draws the blocks · fixed kinds, no html from strings"]
  doc --> parse["the browser parses the css · a constructed sheet, attached to nothing"]
  parse --> keep["style rules and @media / @supports only"]
  keep --> scope["every selector under #about-name"]
  scope --> strip["drop any declaration that loads, runs or leaves"]
  strip --> style["a style element inside the box"]
  blocks --> box["the box · contain: layout paint style · isolate · max-height, scroll"]
  style --> box
```

## the short answer

**the dangerous part is the css, and it never reaches the page as typed.** it goes into a `CSSStyleSheet` the browser constructs and attaches to nothing (so parsing fetches nothing, and `@import` is thrown out by the parser itself), and what the page gets is written back from the parsed rules, not from the text: only style rules and `@media` / `@supports`, every selector prefixed with the box's id, every declaration checked, and the whole thing capped. the box itself is a containing block and a paint clip (`contain: layout paint style`), so even a declaration that got through could not put anything outside it.

**the rest is react.** a block is a tagged object (`{ kind: 'image', src, alt }`); the renderer switches on `kind` and draws elements with escaped text. there is no `dangerouslySetInnerHTML`, no html block, no iframe block, no script block, and nothing will add one. a block of an unknown kind draws nothing.

## the rules

- **words** are text nodes. a heading is 80 characters at most, a paragraph 2000, a caption 200, a label 80; longer is cut, not refused.
- **a picture, a clip, a track** load only from a path on this origin: it starts with `/`, is printable ascii with no whitespace, has no `..`, no backslash, no `//`, no scheme, and is under `/api/streamers/`, `/thumb/` or `/about-demo/` (`mediaPath`). a `data:` picture, an `https://elsewhere` picture, a `javascript:` anything is not drawn. the reason is not only script: a picture from elsewhere hands every viewer's address to whoever put it there. the real upload route, when it exists, lands under `/api/streamers/<name>/`, so the list does not change.
- **a link** is `http:` or `https:` after `new URL(href, origin)` (`linkHref`), nothing else. on this origin it is a router link; elsewhere it opens in a new tab with `rel="noopener noreferrer nofollow"`.
- **the music player and the clip are the site's own elements** (`<audio>` and `<video>` with `controls`, `preload="metadata"`), skinned by their classes (`about-music`, `about-music-track`, `about-music-bar`, `about-music-play`). a page cannot bring a player of its own. the player plays on a press, as the browser wants, and is silent the moment the tab is left (it unmounts).
- **the css**, `safeCss(css, scope)`:
  - 20 000 characters at most, 400 rules, 2000 declarations, 300 characters a selector or a condition. past a cap, the rest is dropped.
  - parsed by `new CSSStyleSheet().replaceSync(css)`. where constructed sheets do not exist, a detached document parses it, and a sheet with any `@` in it is refused outright rather than reasoned about there.
  - kept: `CSSStyleRule`, `CSSMediaRule`, `CSSSupportsRule` (recursed). dropped: `@import`, `@font-face` (a font is a fetch), `@keyframes`, `@namespace`, `@page`, `@property`, `@layer`, `@container`, and a rule nested in a rule. none of it is needed to colour a box.
  - every selector list is split at its top-level commas (quotes and brackets respected) and each part becomes `#about-<name> <part>`. the subject of a selector is then a descendant of the box whatever it says: `body` becomes `#about-alice body`, which is nothing. a part with a backslash (an escape the serializer still needed), a brace, or over 300 characters is dropped.
  - a declaration is dropped when its name or its value matches `url`, `image-set`, `image(`, `src(`, `element(`, `cross-fade`, `paint(`, `expression(`, `javascript:`, `@import`, a backslash, or `</` (a value that reads as a closing tag; the text goes into a style element as a text node, where it could do nothing, and it is dropped anyway), or when its name has `binding` or `behavior` in it. custom properties get the same check, so `--x: url(…)` cannot smuggle a url into `var(--x)`.
  - `position: fixed` becomes `absolute`. the box is the containing block for a fixed descendant anyway (layout containment), so this keeps the intent and loses the word.
  - the longhands come out of the parser: `background: url(x) red` is `background-image: url("x")` (dropped) and `background-color: red` (kept), not an all-or-nothing on the shorthand.
  - the output is a `<style>` element inside the box with the rules as text. `!important` is kept per declaration; it cannot reach past the box.
- **the box**: `contain: layout paint style` (a containing block for every positioned descendant, fixed included; what they paint is clipped to it), `isolation: isolate` (no blend mode or z-index reaches the page), `overflow: auto` with `max-height: 1200px` (a tall page scrolls inside itself), `position: relative`. the box has no class a selector could aim at from inside; the page's own elements outside it are not reachable by any scoped selector.
- **on your own page the blocks are the canvas** (`AboutCanvas.tsx`, `edit`): each one is `{ type, id, x, y, z, w, h }` with `type` one of `text`, `image`, `video`, `sound`. the page opens on the preview (`#about-<name>`), the way a visitor sees it. an empty page of yours shows a pencil and "edit this. make it yours" in the middle of that box, and that opens the editor. `edit` / `stop edit` (`#about-edit`) opens the canvas above that preview; `save` (`#about-save`) writes it and closes the editor, and it also saves on its own a moment after a change. while editing, each block has a tab on top (the type, drag to move, `front`, `replace`, `remove`) and a handle on the corner and the right and bottom edges to scale `w` and `h`. a block snaps to an 8px grid and to the edges of the others. drag across the page to draw a box; every block it touches is selected, and dragging any of their tabs moves that group together. the page is as wide as the column beside the chat, and 1600 tall; the canvas and the preview scroll that page. text, a picture, a line, a box, and a border can turn (`r`, degrees). text also keeps a css font (`font`, one of sans serif mono cursive fantasy system arial helvetica verdana tahoma trebuchet georgia times courier palatino garamond impact — nothing is fetched), a `size`, a `color`, a `bg`, a text border (`stroke` and `strokeColor`), and `align`. a `line`, a `box`, and a `border` are shapes with no file: a line is a thin bar, a box is a fill, a border is a stroke. add text, a picture, a video, or a sound (`#about-add-text` `#about-add-image` `#about-add-video` `#about-add-sound`). a preset (`#about-preset-1` `#about-preset-2` `#about-preset-3`) shows a small picture of that layout, then lays one, two, or three columns under what is already there: in each column a text block over an image slot of the same width. the slot stays empty until a picture is chosen. the text is html, cleaned down to `p`, `br`, `b`/`strong`, `i`/`em`, `u`, `s`, `a` (http or https only), a list, `h2`, `h3`, `blockquote`; a `div` becomes a `p`; a script is dropped with what is inside it. 10 000 characters of text at most, 40 blocks. the cleaned html, the picture, the clip and the sound are objects in the bucket at `about/<row uuid>/<id>.<ext>` (`text/plain` for the html, so opening the object does not run it). the row keeps only the layout, `about_page` jsonb. a picture is png, jpeg, gif or webp, 2 mb; a clip is mp4 or webm, 12 mb; a sound is mp3 or m4a, 8 mb. `GET`/`PUT /api/streamers/:name/about-page` through the bio's gate on the write; `PUT /api/streamers/:name/about-file?type=image|video|sound` for the bytes; `GET .../about-file/:id` serves them back. a page with no blocks is still the sample. a `dummy-` name gets `dummyPage` instead, picked from the name. there is no box to type css into.

## what a viewer gets, with hostile css typed in

| typed | kept as | why |
|---|---|---|
| `body { display: none }` | `#about-alice body { display: none }` | matches nothing. the page stays |
| `#who { color: red }` | `#about-alice #who { … }` | the title is outside the box |
| `.about-heading { background: url(https://evil/x.png); color: red; position: fixed; inset: 0 }` | `#about-alice .about-heading { color: red; position: absolute; top: 0; … }` | the url is gone, the colour lands, the pin is inside the box |
| `@import url(https://evil/e.css)` | nothing | the parser throws it out of a constructed sheet, unfetched |
| `@font-face { src: url(…) }` | nothing | a font is a fetch |
| `.about-text::after { content: "</style><img onerror=…>" }` | nothing | `</` in a value |
| `.about-text, body { visibility: hidden }` | `#about-alice .about-text, #about-alice body { … }` | the list is split and each part scoped |
| `.x { --p: url(https://evil/t.gif); background-image: var(--p) }` | `#about-alice .x { background-image: var(--p) }` | the custom property is dropped; `var(--p)` resolves to nothing |
| `.x { cursor: url(https://evil/c.cur), auto }` | nothing of it | a url |

`test/about.js` types the first seven in and checks: the body is shown, the title's colour is what it was, the heading's allowed colour landed and its background is `none` and it is not `fixed` and its box is inside the about box, the style text has no `url(`, `@import`, `@font-face`, `</style`, and not one request left this origin. before that it writes `ab1`'s about me through the api as nobody (trimmed, two paragraphs kept, on the read and the grant) and finds it first on the tab with no box offered to a stranger; after, as `ab1` (the nick in the corner panel), it opens the box in place, holding the words, types, saves (the page has it at once, the api agrees), and `done` folds it.

## the document

```ts
type AboutBlock =
  | { kind: 'heading'; text }
  | { kind: 'text'; text }
  | { kind: 'image'; src; alt; caption? }
  | { kind: 'gallery'; images: { src; alt }[] }
  | { kind: 'video'; src; poster?; caption? }
  | { kind: 'music'; title?; tracks: { title; src }[] }
  | { kind: 'links'; links: { label; href }[] }
  | { kind: 'divider' };

interface AboutDoc { blocks: AboutBlock[]; css: string }
```

the sample for a name is a heading, a paragraph, the person's offline picture if they have one (else `/about-demo/banner.jpg`), the clip under `/about-demo/clip.mp4`, two tracks, their home-card pictures as a gallery when they have put some, a rule, and three links on this origin. the demo media is small generated stuff in `frontend/public/about-demo/` (about 440 KB in all), served by caddy's catch-all like any file in the build; the frontend's Dockerfile copies `public/` in.

## what is not built

- **`@keyframes`.** an animation loads nothing, but a keyframes name is global and would have to be prefixed and rewritten in every `animation` declaration. one more pass when wanted.
- **themes to pick from**, the way myspace had layouts: a few css files of the site's own, chosen by name. a `theme` field on the document, applied before the person's css.

## not this

- **html as a document.** a text block is a fragment, not a page: the tags above, nothing that loads or runs, cut at 10 000 characters, and the bytes stored as `text/plain`. the page draws that fragment itself. there is no html block a person authors by hand beyond what the text box writes.
- **iframes, embeds, oembed.** a youtube or spotify embed is somebody else's page inside ours, with its own scripts and cookies. a clip block takes an mp4 of their own instead.
- **pictures from anywhere.** a hotlinked picture is a request from every viewer to a host the author chose: an address log. same-origin only.
- **regex on the css text.** `\75 rl(` is `url(`; a comment can split a word; `@imp\ort` is `@import`. the browser's parser decodes all of it and hands back normalized rules, so the checks run on what the browser understood, not on what was typed.
- **the css in an iframe sandbox or a shadow root instead of a scope.** a shadow root is open to the page's styles anyway and the sandboxed iframe is a separate document with its own fetches to police; the scope-and-contain box is simpler and the same rules apply either way.

## open questions

1. **a free name's page.** the one rule says a free name's status is anyone's, so its about me is too (as built: the bio's gate, `test/about.js` writes `ab1`'s as nobody), and its page of blocks would be. (recommendation: logins only for the blocks editor, like posts; the status and the about me stay anyone's.)
2. **how long a page.** 1200px of box with a scroll inside, or no cap and the page as long as they make it. (recommendation: the cap; the chat beside it has a height, and a wall of a page under a player is a different design.)
3. **the sample on every page until the editor lands.** it says it is a sample; it is also a sample on everyone's page. (recommendation: keep it while the tab is new; the editor's first cut replaces it with "nothing here yet" for a page nobody has written.)
4. **`position: fixed` → `absolute`, or dropped.** (recommendation: as built; the containment makes it moot and the author's intent survives.)
