# screen

built. the screen share, and the frame around it: sources in a sidebar, layers over the preview, presets, a mixer. the obs idea, as numbers. obs itself waits.

## what it is for

a site with nothing to connect a stream to. the person is already on that page, goes live here, and shares that tab. watchers get the tab big and the face over it, where the streamer put it. a second screen, a window, a picture, a gif, a border around the face: all layers of the one frame. the page does not composite them: every picture leaves the browser on its own track, and every player lays them out the same way from a few numbers in the slots frame. text stays sharp, nothing is drawn on a canvas, and the streamer can be in another tab the whole time (a hidden tab stops painting; capture, encoding and web audio go on).

the dummies are untouched. they send one camera and no screen, say nothing about a scene, and watchers of a dummy see what they always saw.

## sources

`infra/scene.ts`, the list `publish-atoms.ts` keeps as `sourcesAtom`: the camera (there from the moment it is on), each shared screen, each picture. bottom first; a source on the stream is a layer of the scene, in that order. a source off the stream keeps its box, so the eye brings it back where it was; a video source off the stream is a tile for watchers (what every screen used to be), a picture off the stream is only in the list.

the sidebar (`live/Sources.tsx`, `#sources`, top of the stack first, the way a layers panel reads): a row per source with a little picture of it, the eye (`#source-hide-<id>`), up and down the stack (`#source-up-`, `#source-down-`), `fill` or `whole` on a video (`#source-fit-`), `fit to the camera` on a picture (`#source-fit-camera-`: the same box, just over it, which is how a border lands on the face), and `×` (`#source-remove-`: a screen stops sharing, a picture leaves the scene; the camera has no `×`, the eye takes it off). the `+` (`#add-source`): `screen or window`, `image or gif`, and under those the pictures this name has put up before. before start or live, either: the frame can be laid out before anyone sees it. ids: `cam`, `s1`..`s3` (the wire slot), `i<n>`.

## the share

`screen or window` runs `getDisplayMedia` (`shareScreen`). the browser's picker: a screen, a window, or a tab. the page caps it at 1920×1080 and 30 fps (`SCREEN_CAP`), sets `contentHint` to `detail`, and sends no audio. live, `replaceTrack` fills the first empty screen section; before start the track waits in its slot and the section is offered with it in (`goLive`). those sections are in the offer from the start (`SCREEN_SLOTS` = 3), so a share mid-stream renegotiates nothing. this site's own tab is kept out of the picker (`selfBrowserSurface: "exclude"`, sharing it is a mirror), and the tab can be switched without stopping (`surfaceSwitching: "include"`). a browser that throws on the hints is asked again with the cap alone (`pickDisplay`); the picker closed without a choice is nothing, and no second picker. the screens go with the stream when it stops; the camera and the pictures stay.

the box copies the packets. vp8 only (`media.rs`). a retina capture scaled down inside the encoder would spend the bits on pixels the cap cannot afford (`bitrates.md`), so the capture cap stays 1920×1080.

## the scene

one record, `Scene` in `relay.ts`, bottom layer first:

```
{ "layers": [
  { "id": "s1",  "kind": "screen", "slot": 1, "x": 0, "y": 0, "w": 1, "h": 1 },
  { "id": "cam", "kind": "camera", "slot": 0, "x": 0.73, "y": 0.714, "w": 0.25, "h": 0.25 },
  { "id": "i1",  "kind": "image",  "asset": 12, "x": 0.35, "y": 0.322, "w": 0.3, "h": 0.356 } ] }
```

a box is its top left corner and its size, each a fraction of the 16:9 frame, to thousandths (`clampBox`), so the go live page's preview and every watcher's player draw the same picture at any size. a video layer is one of the publisher's slots and draws with `object-fit` (`fit`: a camera fills its box, `cover`, so resizing it is cropping; a screen shows the whole picture, `contain`, so text is never cut; the row's `fill`/`whole` flips it). a picture is an api asset by id, drawn `fill`: its box keeps the picture's own shape (`ratio`, from the decoded size), so the box is the picture. at most `MAX_LAYERS` 16, each at least `LAYER_MIN` 5% of the frame, inside it.

the editor is the preview (`SceneView`, the same component the watch page draws with). a layer clicked is selected (its row lights too); dragged it moves; a corner pulled resizes it with its shape kept (shift frees a video's); the arrow keys nudge 1% (shift: 5%), `[` and `]` move it through the stack, delete takes a picture out and puts a video source beside, escape lets go. the preview's own `<video>` (`#preview`) stands in for the bottom video layer; the rest are muted copies and `<img>`s.

the rules (`arrangedAfterAdd`, `arrangedAfterRemove`): one picture on its own fills the frame. the first screen beside the camera makes `screen + face` (the screen the frame, the camera bottom right a quarter wide), or the arrangement this browser last had for the two (`settings.lastArrangement`). a third picture takes a corner of its own and moves nothing else: the streamer is in another tab picking the share, and a reflow then is a jump nobody asked for. a source gone leaves the rest where it is, unless one is left, which fills the frame. a picture arrives centred, 30% wide, on top.

presets (`live/Presets.tsx`, `#presets`) are geometry by role, so one applies to whatever sources there are: `face`, `screen`, `screen + face`, `face + screen`, `side by side`, `three up` (`PRESETS`), and the ones this browser saved (`save as preset`, `settings.scenePresets`, 12 at most). a preset's video layers replace the ones there, in its order; a role with no source is skipped and the chip is dimmed; a video source it does not list goes beside; pictures keep their boxes and their place (under the lowest video or above it).

the scene travels with the slots frame, nowhere else: `{"slots":[...],"scene":{...}}` on the publisher's socket when the screens change, once the stream is up (a scene laid out before start, a picture, the camera's box, reaches the first watcher), and within `SCENE_SEND_MS` 150 ms of any other change with the latest by then (a drag is many changes a second; the box and every watcher get a few). the box checks it (`Scene::well_formed`: a short plain id, a known kind, a video slot of that publisher's own offer, an asset id for a picture, fractions in 0..1, 16 layers at most; a frame that fails is ignored and logged, like a bad slot) and passes it on as it came, in every `{"event":"slots"}`: right after a watcher's answer, so a late watcher has the scene before the first frame, and on every change. a publisher that never sent one (the dummy, an older page) has no scene, and the watcher falls back to the rule it always had: the first screen big, the camera a tile.

on the watch page (`watch-atoms.ts`): the big `<video>` (`#video`, the one with the sound) stands in for the scene's bottom video layer, the others are drawn over it (`watchLayersAtom`), and every live slot in no layer is a tile. a video layer clicked is shown alone (`chosenSlotAtom`): the frame is set aside, the other live slots are tiles, and the streamer's own slot in the tiles puts the frame back (`the stream`, `#tile-scene`, when no slot of theirs can). a scene of pictures alone plays the sound with no big picture. the corner player draws the same frame; in its own window, whose shape is the os's, the plain picture shows instead.

## sound

`infra/mixer.ts`, the part of `audio.md` that is built: one `AudioContext` from the start click, the mic through a fader (`level³`: obs's cubic, so half way is -18 dB and not already silence), a mute and an analyser, summed through a master fader and a limiter into a `MediaStreamAudioDestinationNode` whose track is the audio section's for the whole stream. so a sound can join or leave the mix and nothing is renegotiated; a stream started without a mic still has its audio section (an empty one is offered). a shared screen brings no sound (`audio: false`; a tab's sound is `audio.md`, still a plan). nothing reaches `ctx.destination`: the streamer hears nothing of it.

the mixer (`live/Mixer.tsx`, `#mixer`, while the stream is up): a row per source (`#mix-<id>`: a bar painted from a frame loop, `#level-<id>`, with `aria-valuenow`; a mute, `#mute-<id>`; a fader, `#gain-<id>`) and `everyone hears` (`#mix-master`, the same, with a clip light, `#clip`, red for a second after a hot sample). the mic's and the master's faders are kept (`settings.mixer`). the mic chip on the preview (`#live-mic`) reads the mixer's own analyser while it is up, so the mic is never opened twice. a context the browser paused (made outside a click, interrupted) says so in red with a `sound on` button: the stream is silent until then.

## what it costs

a kilobyte or so in the slots frame. the wire otherwise follows the scene (`tuneSenders`): the stage, the biggest picture on the stream, gets the budget: a screen there has the screens' 3 Mbps less 500 kbps for each other screen, the camera there its full 2.5. the camera in a corner is sent as small as its box (`scaleResolutionDownBy` in steps, so a drag does not cost a keyframe per pixel) with the bits that is worth, 150 to 500 kbps; off the stream, small too. other screens get 500 kbps at 15 fps: readable, stuttery on a video. the encoders follow the scene `TUNE_MS` 500 ms after it settles. a screen sender keeps `degradationPreference: "maintain-resolution"` while it has a track: a page is letters and ui, so a tight uplink costs frames, not pixels. the camera is left to the browser's default, so a face keeps its frames.

the layers are css on the watcher's side: absolutely positioned boxes, no second decode, no canvas. a picture is an `<img>` from the api, cached for good (an asset's id is never reused). the cpu is one vp8 encode per picture, in software, on the streamer's machine; a tab that sits still is cheap, a tab with a video in it about a core. the box still does not decode.

## the pictures

`PUT /api/streamers/:name/assets`, the file as it is: png, jpeg, gif or webp by the first bytes (never svg: a script), 2 mb at most, 24 a name, the same gate as the thumbnails (`may_write`). `stream_assets` (`migrate-9.sql`), keyed by name like `stream_thumbs` and renamed with it; the bytes at `assets/<id>/<n>.<ext>`. served back with the sniffed type, `nosniff`, and a year's cache. `GET` lists them, `DELETE /:id` removes one. the scene names a picture by id and the watcher builds the url under the stream's name, so nobody can point a layer at somebody else's picture.

## pages

go live: `#scene` the frame, `#layer-<id>` the boxes (`data-kind`, `data-slot`, the inline style their place; `#layer-<id>-video`, `#layer-<id>-img`; `#layer-<id>-resize-<nw|ne|sw|se>` on the selected one), `#preview` in the bottom video layer; `#sources` with its rows and `#add-source`'s menu (`#add-screen`, `#add-image` and `#image-file`, `#library-<asset>`); `#presets` with `#preset-<name>` (`screen + face` is `preset-screen-face`), `#save-preset`, `#preset-name`, `#preset-save`; `#mixer`; `#share-screen` beside stop, the same as `#add-screen`.

watch: `#scene`, `#layer-<id>` (a video layer a button, "show camera big"), `#video` in the bottom video layer, `#tiles` with `#tile-<slot>` and `#tile-scene`. the corner player: `#pip-scene`.

`test/screen.js` is the check: the sources and the camera layer before start, the mixer with the stream; a screen from the `+` makes the frame on both sides; a drag and a corner follow to the watcher and to localstorage; a png is a layer with its own shape and no new stream; the order follows the arrows; the eye makes a tile and brings the layer back; a saved preset and `face + screen`; the mixer's bars move, a fader at 0 and a mute flatten the master; a second screen takes its corner and hidden is a tile; a late watcher gets it all at once; a screen's `×`; stop leaves the sources and fills the frame with the camera. chrome picks the screen for that test.

## not here

- obs, rtmp, or a second ingest. `spec.md` already leaves those out. a later obs door only pays off if the box forwards obs's own encode. running it back through vp8 at 3 Mbps spends a core and throws the sharper picture away.
- a newer codec. vp9 or av1 hold text in fewer bits, and `media.rs` is opus + vp8 so every watcher already knows the bytes. a second codec is its own build.
- 60 fps, 1440, 4k, or a bitrate above 3 Mbps for the screens.
- a "this is a game" switch. one mode: a page. motion at this cap is the weak spot on purpose.
- the box making a small copy of the screen. `bitrates.md` makes 720 and 360 from the camera, which is the home card. a 360 of a webpage cannot be read, so the watch page keeps the original screen packets.
- burning the layers into one picture. they stay separate; the scene is numbers, and a watcher can still put any one of them big.
- a tab's sound. only chromium hands it over, and it was a source of confusion next to a share that never has sound; the mixer takes a row for it the day `audio.md` builds it.
- scenes to switch between, transitions, text and colour sources, crops, rotation, groups that move together. a border follows the camera by `fit to the camera` again, not by a link.
- the scene as the home card or the thumbnail. `thumbs.rs` stays a frame of the camera, hidden or not.
- a watcher asking the box for fewer slots. four decodes on a phone is heavy; a `want` frame per watcher is the fix, later.
