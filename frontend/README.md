# frontend

the pages. react 19, vite, tailwind, jotai, tanstack query, react router. three.js and `@pixiv/three-vrm` plus mediapipe for the face cam (`docs/vtuber.md`).

## run

```
npm install
npm run dev
```

http://localhost:42069. the camera works there.

which backend it talks to:

- `BACKEND=https://<ip> npm run dev` — a server, no docker on this machine
- plain `npm run dev` — the docker stack on this machine (`./scripts/deploy.sh --build` first)

put `BACKEND=...` in `.env` (gitignored; see `.env.example`) to make it stick.

`SHOW_DOCS=1` in the **repo root** `.env` serves `docs/tech-docs` at http://localhost:42069/tech-docs. only vite does this.

## scripts

- `npm run build` — no-box-shadow and no-native-select checks, `tsc --noEmit`, vite build
- `npm run lint` — the same two checks, then oxlint
- `npm run format` / `format:check` — oxfmt

## layout

- `src/router.tsx` — routes and the shell (sidebar, players, modal)
- `src/app/` — pages: home, live, watch, groups, auth, admin
- `src/infra/` — api client, events worker, atoms, face/model/scene
- `src/shared-components/` — ui, including `live/` and `user-modal/`
- `Caddyfile` — bind-mounted into the `frontend` container; not in the pages image
- `Dockerfile` — build the pages, then a tiny image that copies them into a volume (`publish-pages.sh`)

## conventions

read `.cursor/rules` before changing tsx: no box shadows, text for small actions, a relative parent around `absolute` / `sr-only`, tooltips on icon-only controls, the site `Select` instead of a native `<select>`. hooks will refuse an edit that breaks the first and the last.
