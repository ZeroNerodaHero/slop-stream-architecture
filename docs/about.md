# about

built, the viewer's half: a tab under the player, `about`, beside `calendar` (`calendar.md`), where the bio was. the bio is still first on it. under the bio is a page of the person's own, the way a myspace or a neocities page was theirs: blocks of fixed kinds (words, a heading, a picture, a gallery, a clip, a music player, links, a rule) and css of their own over all of it. no scripts, by construction: there is no block that takes one. the document the tab draws is a sample until the editor and the route exist; the renderer and the rules are the real ones and are what this file is about. `frontend/src/infra/about.ts`, `shared-components/About.tsx`, `test/about.js`.

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
- **nothing is saved**, yet. the sample document is made in the page (`demoAbout`) from the name and the person's own pictures where they have put some; the css box under it is for trying the rules and empties on the next visit.

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

`test/about.js` types the first seven in and checks: the body is shown, the title's colour is what it was, the heading's allowed colour landed and its background is `none` and it is not `fixed` and its box is inside the about box, the style text has no `url(`, `@import`, `@font-face`, `</style`, and not one request left this origin.

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

- **the route and the editor.** `GET /api/streamers/:name/about` → the document; `PUT` through the bio's gate (`may_write`); a `jsonb` column on `streamers` (one document, replaced whole, like the bio), or a row in a table of its own if versions are wanted. the editor is a profile-tab section: add a block of a kind, move it, remove it, and the css box, with the sanitizer's note under it as it is now. the api should run the same caps (sizes, counts, `mediaPath` on every `src`) so a document that would not draw is refused at the door, and keep the css as typed: the page sanitizes on every draw, whoever wrote the row.
- **uploads for the blocks.** `PUT /api/streamers/:name/about/<n>` for a jpeg, an mp4, an mp3, with the offline picture's limits for the picture and a size cap for the rest; the keys under the account's id in the bucket like every picture (`ids.md`). until then the only pictures a document can show are the ones the profile already has.
- **`@keyframes`.** an animation loads nothing, but a keyframes name is global and would have to be prefixed and rewritten in every `animation` declaration. one more pass when wanted.
- **themes to pick from**, the way myspace had layouts: a few css files of the site's own, chosen by name. a `theme` field on the document, applied before the person's css.

## not this

- **html in the document.** the whole feature is that there is none. a sanitizer for html is a bigger and softer thing than one for css, and every block anyone has asked for is a fixed kind.
- **iframes, embeds, oembed.** a youtube or spotify embed is somebody else's page inside ours, with its own scripts and cookies. a clip block takes an mp4 of their own instead.
- **pictures from anywhere.** a hotlinked picture is a request from every viewer to a host the author chose: an address log. same-origin only.
- **regex on the css text.** `\75 rl(` is `url(`; a comment can split a word; `@imp\ort` is `@import`. the browser's parser decodes all of it and hands back normalized rules, so the checks run on what the browser understood, not on what was typed.
- **the css in an iframe sandbox or a shadow root instead of a scope.** a shadow root is open to the page's styles anyway and the sandboxed iframe is a separate document with its own fetches to police; the scope-and-contain box is simpler and the same rules apply either way.

## open questions

1. **a free name's page.** the one rule says a free name's bio is anyone's, so its page would be too. (recommendation: logins only for the editor, like posts; the bio stays anyone's.)
2. **how long a page.** 1200px of box with a scroll inside, or no cap and the page as long as they make it. (recommendation: the cap; the chat beside it has a height, and a wall of a page under a player is a different design.)
3. **the sample on every page until the editor lands.** it says it is a sample; it is also a sample on everyone's page. (recommendation: keep it while the tab is new; the editor's first cut replaces it with "nothing here yet" for a page nobody has written.)
4. **`position: fixed` → `absolute`, or dropped.** (recommendation: as built; the containment makes it moot and the author's intent survives.)
