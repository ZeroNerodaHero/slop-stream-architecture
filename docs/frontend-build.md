# frontend build files

what the comments in the frontend's build and config files said (`index.html`, `vite.config.mts`, `tailwind.config.ts`, `Dockerfile`, `publish-pages.sh`, `scripts/`, `.env.example`), moved here when those files lost their comments (`.cursor/rules/no-comments.mdc`). the files are the truth; check a detail against them before trusting it.

## `frontend/scripts/precompress.mjs`

Brotli at its best (quality 11) beside every built asset that shrinks, as `<file>.br`, after
`vite build` (`npm run build`). caddy serves the .br to a browser that takes br (Caddyfile
`precompressed br` on /assets) and compresses on the fly as before for the rest. on the fly is
gzip or zstd at a fast level: the main bundle is ~23% bigger that way, and on a cold load it
is downloaded in tcp slow start, so every 14kB is part of a round trip (docs/debugging.md
"Watch startup timings"). index.html is left alone: publish-pages.sh renames it into place
last, and a .br beside it could go in first and serve the new page early.

## `frontend/tailwind.config.ts`

`export default`: The same token names as Axiom-Frontend, fed by the css variables in src/app/globals.css.

Hard edges: the theme has no border radius at all (only `rounded-none` exists, so a stray
`rounded-xl` produces no css) and no box shadow at all (an empty scale, so a stray `shadow-md`
produces none either; .cursor/rules/no-box-shadow.mdc). A box is a 1px stroke.

## `frontend/vite.config.mts`

`export default defineConfig`: `npm run dev` serves the pages from here and forwards /api and /ws to a running
backend. Which one, in order:
  1. BACKEND in the shell or in frontend/.env      e.g. BACKEND=https://192.81.135.162
  2. https://<PUBLIC_IP> from the repo's .env        the docker stack on this machine
  3. https://127.0.0.1
The backend's cert is self-signed, so `secure: false`. Video packets go straight to
the backend's ip:7882 the same way they would from its own pages.

## `frontend/index.html`

- the theme and the size this browser keeps, before first paint: the css variables the appearance setting derived (src/infra/atoms/settings-atoms.ts writes them under settings.themeVars) and the root font size as a percentage (settings.textSize; 100 is the browser's own and sets nothing), applied inline on <html> so a light or custom theme does not flash dark, nor a smaller page large, while the bundle loads. vite keeps a classic inline script as it is, and the api's /watch document leaves it in place (api/src/profile.rs looks for the title, the end of the head and #root only, none of them in here). nor may this comment spell the end-of-head tag out: vite's build injects the bundle before the first one it finds, and would put it inside the comment. (at `<script>`)
- the sizes the appearance tab offers, less 100: TEXT_SIZES in src/infra/atoms/settings-atoms.ts, which reads anything else as 100, so a size painted here is the one the bundle keeps (change the two lists together) (at `var size = JSON.parse(localStorage.getItem('settings.textSize') || 'null');`)
- a stream's page opened straight (a shared link, a reload): what the page asks first, sent now, while the bundle is still downloading (~1s on a cold load, docs/debugging.md "Watch startup timings"). the grant, and the peer with its offer and the video socket, the same as a press warms (watch-atoms.ts `makeWarm`), sending nothing. `start` in watch-atoms.ts takes them as window.__bootWatch, once; past WARM_MAX_MS it closes them and asks itself, and one nobody took is closed after 10s (video's own handshake timeout). the name rule is names.ts NAME_RE after cleanName, the 4 video sections are VIDEO_SLOTS (1 + relay.ts SCREEN_SLOTS), the path is api.ts `watch`: change them together. (at `<script>`)
- never taken (the bundle failed, the page is not the watch page after all): closed (at `setTimeout(function () {`)
- the site icon. ?v= so a browser that kept the old one asks again after a change: bump it with the files (at `<link rel="icon" href="/favicon.ico?v=2" sizes="any" />`)
- the profile card the api puts inside #root when it serves /watch/<name> (api/src/profile.rs), so the page shows the name, picture, the word and the status line before react boots. react replaces it when it renders. a <template> draws nothing, so the pages caddy serves straight from this file are unaffected. {{...}} are the api's placeholders. the markup mirrors PageFrame + WatchPage; tailwind scans this file, so the classes here exist in the css. {{banner}} is a style, not markup: the offline picture as a background on the player's box while they are not live, and an api older than it leaves words the browser ignores. {{bio}} is the status line under the name, as markup (a span the api makes, so a name with none leaves nothing), like {{avatar}} and {{verified}}. (at `<template id="watch-shell">`)

## `frontend/Dockerfile`

- stage 1: build the react pages with node. no node needed on the machine. (at `FROM node:24-alpine AS build`)
- the build's own checks (no-box-shadow.sh, no-native-select.sh) (at `COPY scripts ./scripts`)
- served as they are, under their own names: the about tab's sample media (docs/about.md) (at `COPY public ./public`)
- the commit, from deploy.sh. vite bakes it in as __BUILD__; every error report carries it. (at `ARG BUILD=dev`)
- stage 2: a tiny image whose only job is to copy the built pages into the volume caddy serves from. it runs once per deploy. caddy itself never restarts, so the websockets of people who are live stay up while the pages change under them. (at `FROM alpine:3.20`)

## `frontend/publish-pages.sh`

- Publish the build in /dist into /srv, the volume caddy serves, so a page loaded mid-deploy never meets a half-written index.html or one that points at js that is not there yet: 1. copy the build into a temp dir on the same volume, so every step below is a rename, never a write caddy could read halfway through 2. rename everything but index.html into place. assets carry a hash in the name, so these are new files; the old build's stay for whoever is on it 3. rename index.html over the old one. rename is atomic: old page or new page 4. then remove what the new build no longer has (at `set -e`)

## `frontend/scripts/no-box-shadow.sh`

- The site has no box shadows (.cursor/rules/no-box-shadow.mdc). This fails when the pages' source has one: a tailwind `shadow-*` class behind any variant prefix (`drop-shadow-*` is not one, see the rule), a css `box-shadow:` declaration, or a `boxShadow:` with a value in a style object. Code forms only: prose may name the rule file or quote a class in backticks. `npm run lint` and `npm run build` run it over the tree; the cursor hook (.cursor/hooks/no-box-shadow.sh) runs it over one edit's text with `-`, read from stdin. Prints the offending lines; exit 1 when there are any. (at `set -u`)
- the api's hand-written pages (profile.rs's watch card, monitor.html) wear the same look. not in the frontend's docker build context, so only when it is there (at `[ -d ../api/src ] && set -- "$@" ../api/src`)

## `frontend/scripts/no-native-select.sh`

- The site draws its own pickers (.cursor/skills/no-native-select/SKILL.md): a list to pick one option from is `Select` (src/shared-components/Select.tsx), never the browser's, whose open list is the operating system's and takes no css. This fails when the pages' source has the browser's: a `select`, `option`, `optgroup` or `datalist` tag, or one made with createElement. Code forms only: prose may name the tag without its bracket. `npm run lint` and `npm run build` run it over the tree; the cursor hook (.cursor/hooks/no-native-select.sh) runs it over one edit's text with `-`, read from stdin. Prints the offending lines; exit 1 when there are any. (at `set -u`)

## `frontend/.env.example`

- where `npm run dev` sends /api and /ws. copy to frontend/.env (gitignored). leave it out to use the docker stack on this machine (PUBLIC_IP from the repo's .env). (at `BACKEND=https://192.81.135.162`)
