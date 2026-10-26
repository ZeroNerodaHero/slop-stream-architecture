---
name: dead-code
description: Find unused code, files, imports, dependencies, unreachable branches, commented-out code, and stale docs in this repo. Delete anything the compiler and a repo-wide search both show is unused. Mark anything that might still be a route, wire field, script entry, or plan doc with a dead? comment. Use when the user asks to find, mark, or remove dead code, unused exports, unused files, unused dependencies, or stale docs.
---

# Dead code

Delete what is unused. Mark what only looks unused. Do not refactor, rename, or restyle anything else in the same pass.

## Confidence

**Delete** only when every check below holds:

- The compiler reports it unused (`dead_code`, `unused_imports`, `unreachable_code`), or it is commented-out code, or it is a file or dependency with no reference.
- A repo-wide search finds no use outside the definition. Search `*.rs`, `*.ts`, `*.tsx`, `*.js`, `*.sh`, `*.py`, `*.yml`, `*.md`, `Dockerfile*`, and `*.html`. Skip `target/`, `node_modules/`, `dist/`, `Cargo.lock`, and `package-lock.json`.
- It is not on the keep list below.

**Mark** everything else that is a real candidate. A mark is a one-line comment whose first word is `dead?:`. Say what it might still be for.

```rust
// dead?: no rust caller, but docs/spec.md still lists POST /api/name
```

```ts
// dead?: nothing imports this, but seed.sh names the file
```

```md
> dead?: this says GET /api/foo exists, and no route or caller has that path
```

In JSX use `{/* dead?: ... */}`. Grep `dead?:` to find every mark later.

## Keep list

These are live even when nothing in Rust or TypeScript calls them. Mark them, do not delete them.

- **Process argv.** `api monitor`, `api chat`, and `api passwd` are branches on `args().nth(1)` in `api/src/main.rs`. `video dummy` is the same in `video/src/main.rs`. The modules they call (`monitor`, `chat`, `auth::passwd`, `dummy`) are entrypoints.
- **HTTP routes.** A handler passed to `.route(...)` is used. The path string is the contract. `docs/spec.md`, `frontend/src/infra/api.ts`, and `test/*.js` all count as callers.
- **Wire fields.** `serde` fields, `sqlx` row fields, JSON keys, websocket `type` / `role` / `event` strings, Redis keys, and env vars. An unread field can still be the protocol. `video` and `frontend/src/infra/` share the websocket vocabulary.
- **Frontend entry.** `frontend/src/main.tsx`, `frontend/src/router.tsx`, and `frontend/src/infra/events.worker.ts`. The worker is imported as `@/infra/events.worker?sharedworker` from `events.ts`. A search that ignores the `?sharedworker` query will call the worker unused.
- **Pages imported only by the router.** One importer is enough.
- **Tests.** `#[cfg(test)]` modules and `test/*.js`. Production code used only from there is live.
- **Root scripts and images.** `deploy.sh`, `test.sh`, `seed.sh`, `manage.sh`, `manage.py`, `ship.sh`, Dockerfiles, and compose files. A person runs these. No in-repo caller does not make them dead.
- **Plan docs.** `docs/README.md` says which docs are "a plan, not a build". A plan is not stale. Do not delete it.
- **Prose comments.** This repo's comments state invariants. Delete a comment only when it is commented-out code, not when it explains why something works the way it does.

## Search

Do the inventory before editing. Compile tests too, so a test-only helper does not look dead:

```bash
cargo check --workspace --all-targets
```

```bash
cd frontend && npx tsc --noEmit
```

`frontend/tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`, so unused imports, locals, and parameters fail that check. Rustc's `dead_code` and `unused_imports` are the Rust list. Do not install knip, cargo-udeps, or a new linter.

Then search by hand for what those compilers cannot see:

| Look for | Delete when | Mark when |
|---|---|---|
| Unused export or private item | Compiler warns, and the name appears nowhere else, including tests and scripts | It is a route, wire field, argv branch, or named in `docs/spec.md` |
| File nothing imports | No `mod`, import, script, Docker, or doc reference. Not an entry file | The only reference is a doc or a script, or the file is a root script |
| Unused import | `unused_imports` or `tsc` names it | Never. An unused import is not a protocol |
| Unreachable code | Compiler reports `unreachable_code` | You only think a branch cannot run |
| Commented-out code | Three or more comment lines that are code (braces, semicolons, `fn`, JSX), or a single commented-out statement | It might be prose that happens to mention code |
| Unused dependency | The crate or package name appears only in its manifest. Config plugins count as uses: `tailwindcss`, `postcss`, `autoprefixer`, `vite` | A Cargo feature is unused while the crate itself is used |
| Stale doc | A doc that describes current behavior names a file, route, function, or env var that is absent | The name almost matches something real, or the doc is a plan |

`cargo check --all-targets` does not see TypeScript, and `tsc` does not see Rust. A name that crosses that boundary is a mark, not a delete.

## Delete

Work in this order: unused imports, unreachable code, unused items, unused files, unused dependencies, commented-out code, stale sentences.

- One batch, then compile. If the build fails, put that deletion back and mark it.
- Remove a Rust dependency from the crate's `Cargo.toml`, then `cargo check --workspace --all-targets`. Cargo updates `Cargo.lock`.
- Remove an npm dependency with `npm uninstall <pkg> --prefix frontend` (or `--prefix test` for `test/package.json`) so `package-lock.json` stays honest. Then run `tsc` again.
- A stale doc: delete or rewrite the false sentence. Do not delete the document.
- Do not drop a whole module because one function in it is unused.
- Do not touch `random-media/`, lockfiles by hand, or generated files.

## Report

End with two lists and nothing softer:

- **Deleted.** Path, symbol, and the compiler warning or the search that showed no callers.
- **Marked.** Path, symbol, and why it might still be live.

If a category was clean, say so in one line. Compiler success after a deletion is the check. Do not start the app to prove an unused item was unused. If a change needs a click to feel safe, it was not high confidence: mark it instead.
