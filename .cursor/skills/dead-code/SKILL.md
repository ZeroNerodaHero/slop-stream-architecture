---
name: dead-code
description: Find unused code, files, imports, dependencies, unreachable branches, leftover comments, and stale docs in this repo. Delete anything the compiler and a repo-wide search both show is unused. List anything that might still be a route, wire field, script entry, or plan doc as a candidate in the report, never as a mark in the code. Use when the user asks to find, mark, or remove dead code, unused exports, unused files, unused dependencies, or stale docs.
---

# Dead code

Delete what is unused. Report what only looks unused. Do not refactor, rename, or restyle anything else in the same pass.

## Confidence

**Delete** only when every check below holds:

- The compiler reports it unused (`dead_code`, `unused_imports`, `unreachable_code`), or it is a file or dependency with no reference.
- A repo-wide search finds no use outside the definition. Search `*.rs`, `*.ts`, `*.tsx`, `*.js`, `*.sh`, `*.py`, `*.yml`, `*.md`, `Dockerfile*`, and `*.html`. Skip `target/`, `node_modules/`, `dist/`, `Cargo.lock`, and `package-lock.json`.
- It is not on the keep list below.

**Candidates** are everything else that might be dead but might still be live. Do not mark them in the source: the repo has no code comments at all (`.cursor/rules/no-comments.mdc`), so a `dead?:` line or any other marker comment is itself a violation. Put each candidate in the report instead, with the path, the symbol, and what it might still be for, for example:

- `api/src/<file>.rs` `<fn>`: no rust caller, but `docs/spec.md` still lists its route
- `frontend/src/infra/<file>.ts`: nothing imports it, but a script names the file
- `docs/<topic>.md`: names a route that no handler or caller has

## Keep list

These are live even when nothing in Rust or TypeScript calls them. Report them as candidates, do not delete them.

- **Process argv.** `api monitor`, `api models`, `api chat`, `api events`, `api home`, `api passwd` and `api release` are branches on `args().nth(1)` in `api/src/main.rs`. `video dummy` and `video voice` are the same in `video/src/main.rs`. The modules they call are entrypoints.
- **HTTP routes.** A handler passed to `.route(...)` is used. The path string is the contract. `docs/spec.md`, `frontend/src/infra/api.ts`, and `test/*.js` all count as callers.
- **Wire fields.** `serde` fields, `sqlx` row fields, JSON keys, websocket `type` / `role` / `event` strings, Redis keys, and env vars. An unread field can still be the protocol. `video` and `frontend/src/infra/` share the websocket vocabulary.
- **Frontend entry.** `frontend/src/main.tsx`, `frontend/src/router.tsx`, and `frontend/src/infra/events.worker.ts`. The worker is imported as `@/infra/events.worker?sharedworker` from `events.ts`. A search that ignores the `?sharedworker` query will call the worker unused.
- **Pages imported only by the router.** One importer is enough.
- **Tests.** `#[cfg(test)]` modules and `test/*.js`. Production code used only from there is live.
- **Scripts you run.** `scripts/deploy.sh`, `scripts/ship.sh`, `scripts/test.sh`, `scripts/seed.sh`, `scripts/manage.sh`, and `manage.py` (the screen behind manage). `frontend/publish-pages.sh` runs inside the pages image, not from a shell. Dockerfiles and compose files too. A person runs these. No in-repo caller does not make them dead.
- **Plan docs.** `docs/README.md` says which docs are "a plan, not a build". A plan is not stale. Do not delete it.
- **Tool directives.** Shebangs, lint and compiler directives (`#[allow(...)]`, `// @ts-expect-error`, `/// <reference ... />`) and the `--help` header blocks at the top of `scripts/ship.sh`, `test.sh`, `seed.sh`, `models.sh`, `manage.sh` and `dummy-groups.sh` (their `-h` prints that block with `awk`) are not dead and are not stray comments.

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

| Look for | Delete when | Report as a candidate when |
|---|---|---|
| Unused export or private item | Compiler warns, and the name appears nowhere else, including tests and scripts | It is a route, wire field, argv branch, or named in `docs/spec.md`: report it |
| File nothing imports | No `mod`, import, script, Docker, or doc reference. Not an entry file | The only reference is a doc or a script, or the file is a root script |
| Unused import | `unused_imports` or `tsc` names it | Never. An unused import is not a protocol |
| Unreachable code | Compiler reports `unreachable_code` | You only think a branch cannot run |
| Any comment in code | Always, except the tool directives in the keep list: the repo carries no comments (`.cursor/rules/no-comments.mdc`). Commented-out code is deleted, not uncommented. Knowledge worth keeping goes into `docs/` | Never |
| Unused dependency | The crate or package name appears only in its manifest. Config plugins count as uses: `tailwindcss`, `postcss`, `autoprefixer`, `vite` | A Cargo feature is unused while the crate itself is used |
| Stale doc | A doc that describes current behavior names a file, route, function, or env var that is absent | The name almost matches something real, or the doc is a plan |

`cargo check --all-targets` does not see TypeScript, and `tsc` does not see Rust. A name that crosses that boundary is a candidate for the report, not a delete.

## Delete

Work in this order: unused imports, unreachable code, unused items, unused files, unused dependencies, stray comments, stale sentences.

- One batch, then compile. If the build fails, put that deletion back and report it as a candidate.
- Remove a Rust dependency from the crate's `Cargo.toml`, then `cargo check --workspace --all-targets`. Cargo updates `Cargo.lock`.
- Remove an npm dependency with `npm uninstall <pkg> --prefix frontend` (or `--prefix test` for `test/package.json`) so `package-lock.json` stays honest. Then run `tsc` again.
- A stale doc: delete or rewrite the false sentence. Do not delete the document.
- Do not drop a whole module because one function in it is unused.
- Do not touch `random-media/`, lockfiles by hand, or generated files.

## Report

End with two lists and nothing softer:

- **Deleted.** Path, symbol, and the compiler warning or the search that showed no callers.
- **Candidates.** Path, symbol, and why it might still be live. Nothing was marked in the code.

If a category was clean, say so in one line. Compiler success after a deletion is the check. Do not start the app to prove an unused item was unused. If a change needs a click to feel safe, it was not high confidence: report it as a candidate instead.
