# nodentity desktop

A Tauri v2 shell around the live site. The window loads https://nodentity.xyz itself rather than a bundled copy of `frontend/dist`, so cookies, `/api` calls and the WebSockets stay same-origin exactly as on the web. A new web deploy reaches the desktop app the same way it reaches a browser tab; only the native shell needs a release.

## Run it

Needs Rust (stable) and Node.

```sh
npm --prefix desktop install
npm --prefix desktop run dev
```

`dev` opens the window on https://nodentity.xyz too (`build.devUrl` in `src-tauri/tauri.conf.json`). To point it at a local vite, change `devUrl` to `http://localhost:42069` for the session and add that origin to `remote.urls` in `src-tauri/capabilities/main.json`.

## Build it locally

```sh
npm --prefix desktop run build
```

The bundles land in `desktop/src-tauri/target/release/bundle/` (`macos/`, `dmg/`, `nsis/`). `createUpdaterArtifacts` is on, so a local build wants `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in the environment; without them the bundle step fails after compiling. For a quick build without them:

```sh
npm --prefix desktop run build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

## Releases

Push a semver tag `vX.Y.Z`, for example `git tag v0.1.0 && git push origin v0.1.0`. `.github/workflows/desktop.yml` writes that version into `tauri.conf.json`, builds macOS arm64, macOS x64 and a Windows NSIS installer, and publishes them with a signed `latest.json` to a GitHub release named `nodentity <tag>`. It can also be started by hand from the Actions tab, but only on a tag.

The plain `vN` tags that `.github/workflows/images.yml` pushes for docker images never start a desktop build; only `vX.Y.Z` tags do.

Repository secrets the workflow needs:

- `TAURI_SIGNING_PRIVATE_KEY`: the minisign private key whose public half is `plugins.updater.pubkey` in `tauri.conf.json` (`npx tauri signer generate` makes a pair).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password.

## Updates

- The web app: every build writes `/version.json` (`{"build": "<BUILD>"}`), which Caddy serves `no-store`. The page asks for it every 5 minutes and when the tab comes back, and shows a bar with `reload` when the build differs from the one running.
- The native shell: inside the app the same bar also asks the updater plugin, which reads `https://github.com/ZeroNerodaHero/slop-stream-architecture/releases/latest/download/latest.json`. A newer shell wins over a web reload: `update and restart` downloads, verifies the signature, installs (passive on Windows) and relaunches. A failed check (no release yet, offline) shows nothing.

## Not yet

The builds are not Apple-signed or notarized and not Windows code-signed. macOS Gatekeeper blocks the first open (System Settings, Privacy & Security, Open Anyway), and Windows SmartScreen will warn. The updater's own minisign signature is separate from that and is in place.
