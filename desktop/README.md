# nodentity desktop

A Tauri v2 shell around the live site. The window loads https://nodentity.xyz itself rather than a bundled copy of `frontend/dist`, so cookies, `/api` calls and the WebSockets stay same-origin exactly as on the web. A new web deploy reaches the desktop app the same way it reaches a browser tab; only the native shell needs a release.

## Run it

Needs Rust (stable) and Node.

```sh
npm --prefix desktop install
npm --prefix desktop run dev
```

`dev` opens the window on https://nodentity.xyz too (`build.devUrl` in `src-tauri/tauri.conf.json`). To point it at a local vite, pass another `devUrl` for the session, as in [Against a local build](#against-a-local-build).

## Native capture

Inside the app the go live page uses native code for sound and screens. The web build never loads any of it: every path checks `inTauri()` first and imports `@tauri-apps/api` lazily.

- **Desktop audio**: `add desktop audio` in the sound panel adds a `desktop audio` row to the mixer. macOS takes it from ScreenCaptureKit (the app's own sound is left out), Windows from a WASAPI loopback of the default output. Removing the row stops the capture.
- **Mic**: the mic picker lists the devices cpal sees, and the one picked is captured natively, then runs through RNNoise, a noise gate and a limiter before the mixer. The mic row has toggles for noise suppression and the gate.
- **Screens on macOS**: `share screen` lists displays and windows through ScreenCaptureKit and opens a picker. The picked one is captured at up to 1920 px wide and 30 fps, sent as JPEG frames and drawn into a canvas whose `captureStream` track goes out like a `getDisplayMedia` one. When listing fails (no permission) it falls back to `getDisplayMedia`. Windows keeps WebView2's `getDisplayMedia`.

- **Restream straight from the app**: with the `send to destinations from this app` setting on (the default in the app), going live with destinations switched on encodes the scene in the page with WebCodecs and hands each frame to `restream_direct_packet`. `src/rtmp.rs` then publishes it over RTMP or RTMPS to each destination, so nothing goes through the relay. See [docs/relay.md](../docs/relay.md).

The commands (`start_desktop_audio`, `stop_desktop_audio`, `list_input_devices`, `start_mic`, `stop_mic`, `list_capture_sources`, `start_screen_capture`, `stop_screen_capture`, `restream_direct_ready`, `restream_direct_start`, `restream_direct_packet`, `restream_direct_status`, `restream_direct_stop`) are allowed by the `native-capture` permission set in `src-tauri/permissions/native-capture.toml`, which `capabilities/main.json` grants to the main window.

`main` is scoped to https://nodentity.xyz through `remote.urls`, so any other origin the window navigates to (an OAuth provider) gets none of these commands. PCM goes to the page as 20 ms chunks of 48 kHz f32 over a `Channel` as raw bytes: stereo for desktop audio, mono for the mic.

macOS asks for Screen & System Audio Recording the first time the screen list or desktop audio starts, and for the Microphone the first time a mic opens. A refusal comes back as an error that names the setting to turn on; after allowing screen recording, quit and open the app again.

### Against a local build

Serve the frontend, point a dev window at it with an inline `devUrl`, and grant that origin the same permissions with an inline capability, so nothing localhost is committed:

```sh
npm --prefix frontend run build
npm --prefix frontend run preview -- --port 4173
npm --prefix desktop run dev -- --config '{"build":{"devUrl":"http://localhost:4173"},"app":{"security":{"capabilities":["main",{"identifier":"local","windows":["main"],"remote":{"urls":["http://localhost:4173/*"]},"permissions":["core:default","updater:default","process:allow-restart","native-capture"]}]}}}'
```

`vite preview` proxies `/api` and the sockets to `BACKEND` the same way `npm run dev` does, so going live from that window works against whatever backend `frontend/.env` names. `add desktop audio` and the mic toggles show in the sound panel once you are live.

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
