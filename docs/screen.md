# screen

built. the screen share, aimed at a tab of some other site, and the camera laid over it where the streamer puts it. obs waits.

## what it is for

a site with nothing to connect a stream to. the person is already on that page, goes live here, and shares that tab. watchers get the tab big and the face over it, in the corner the streamer dragged it to, or beside it as a tile. the page does not composite them into one frame: two pictures leave the browser, and every player lays them out the same way from a few numbers.

the dummies are untouched. they send one camera and no screen, say nothing about a layout, and watchers of a dummy see what they always saw.

## the share

while live, one press runs `getDisplayMedia` (`publish-atoms.ts`, `shareScreen`). the browser's picker: a screen, a window, or a tab. the page caps it at 1920×1080 and 30 fps (`SCREEN_CAP`), sets `contentHint` to `detail`, and sends no audio. `replaceTrack` fills the first empty screen section. those sections were in the offer from the start (`SCREEN_SLOTS` = 3), so a share mid-stream renegotiates nothing.

the picker is asked with hints (`SCREEN_HINTS`): the cursor in the picture (`cursor: "always"`) so a person can point at the page, this site's own tab kept out of the picker (`selfBrowserSurface: "exclude"`, sharing it is a mirror), and switching which tab is shared without stopping (`surfaceSwitching: "include"`). a browser that throws on the hints (a `TypeError`, an `OverconstrainedError`) is asked again with the size cap alone, and the share still happens (`pickDisplay`). the picker closed without a choice is nothing, and no second picker.

the screens share 3 Mbps. one screen gets all of it, three get 1 each. the camera drops to 500 kbps while any screen is up, from 2.5. a screen sender is set to `degradationPreference: "maintain-resolution"` for as long as it has a track (`tuneSenders`): a page is letters and ui, so when the uplink or the cpu gets tight the encoder drops frames and keeps the pixels. the camera is left to the browser's default, so a face keeps its frames. a video playing inside the tab stutters before it goes soft. that is the trade.

the box copies the packets. vp8 only (`media.rs`). a retina capture scaled down inside the encoder would spend the bits on pixels the cap cannot afford (`bitrates.md`), so the capture cap stays 1920×1080.

## the layout

where the camera goes while a screen is shared. one record, `Layout` in `relay.ts`:

```
{ "camera": "over" | "beside", "x": 0.73, "y": 0.73, "w": 0.25 }
```

`over`: the camera is a 16:9 box over the screen, `w` of the frame wide, its top left corner at `x`,`y` of the frame. fractions, so the go live page's preview and every watcher's player draw the same picture at any size. `beside`: the camera is a tile under the video, what every slot was before this. `w` is kept between `CAMERA_MIN_W` 0.1 and `CAMERA_MAX_W` 0.5, the corner so the whole box fits, everything to thousandths (`clampLayout`). the default is bottom right, a quarter wide (`DEFAULT_LAYOUT`).

on the go live page the preview is what a watcher gets big (`stageStreamAtom`): the camera alone, or the first shared screen with the camera over it (`CameraOverlay`). the camera is dragged around in there, the arrow keys nudge it 1% (shift: 5%), the `size` dial is `w`, and two buttons say `on the screen` or `beside it`. the choice is this browser's (`settings.cameraLayout`, localstorage) and comes back for the next stream.

the layout travels with the slots frame, nowhere else: `{"slots":[...],"layout":{...}}` on the publisher's socket whenever the screens change, and within `LAYOUT_SEND_MS` 150 ms of a layout change with the latest by then (a drag is many changes a second; the box and every watcher get a few). the box checks it (`Layout::well_formed`: a known word, fractions in 0..1; a frame that fails is ignored and logged, like a bad slot) and passes it on as it came, in every `{"event":"slots"}`: right after a watcher's answer, so a late watcher has the layout before the first frame, and on every change. a publisher that never sent one (the dummy, an older page) has no layout, and the watcher falls back to tiles.

on the watch page (`watch-atoms.ts`, `cameraOverlaidAtom`): the camera is drawn over the big picture when the layout says `over`, a screen is the big one (the rule's first screen, or one the watcher chose), and the camera is live. it is a button: clicked, the camera goes big and the screen is a tile, as the camera's tile would have done; the screen's tile clicked puts it back. `beside`, or no layout, and the camera is a tile like before. the corner player (`MiniPlayer`, `CornerPlayer`'s `overlay`) draws the same box, so the face is not lost when the stream goes to the corner.

## what it costs

a few bytes in the slots frame. nothing else on the wire: one screen is 3 Mbps plus the camera at 0.5, and every watcher gets those bytes, the same as before. `maintain-resolution` changes which frames survive, not how many bits leave. the layout is css on the watcher's side: one absolutely positioned box, no second decode, no canvas.

the cpu is the one vp8 encode per picture, in software, on the streamer's machine. a tab that sits still is cheap. a tab with a video playing in it is about a core. the box still does not decode.

## sound

the tab's own audio is `audio.md`. one opus leaves the page: the mic, the share, or the two mixed. this file does not add a second audio section, and the share stays silent until that plan is built. `getDisplayMedia` will not hand over the sound without the picture, so the sound arrives with this same share, into the one opus, not into the screen slot.

## pages

go live: `#preview` (the stage), `#camera-overlay` and `#camera-overlay-video` while the camera is on the screen (drag, arrow keys), `#screens` with `#camera-tile` first while it is beside and `#screen-<i>` with `#stop-screen-<i>` for every shared screen, `#layout` with `#camera-over`, `#camera-beside` (`aria-pressed`) and the `#camera-size` dial (disabled while beside), `#share-screen` beside stop.

watch: `#video` the big one, `#camera-overlay` over it (a button, "show camera big"), `#tiles` with `#tile-<slot>` for the rest. the corner player: `#pip-camera-overlay`.

`test/screen.js` is the check: share, the screen goes big with the camera over it, a drag and the dial follow to the watcher, the camera clicked goes big, beside and back, a second screen, a late watcher gets the layout at once, stop. chrome picks the screen for that test.

## not here

- obs, rtmp, or a second ingest. `spec.md` already leaves those out. a later obs door only pays off if the box forwards obs's own encode. running it back through vp8 at 3 Mbps spends a core and throws the sharper picture away.
- a newer codec. vp9 or av1 hold text in fewer bits, and `media.rs` is opus + vp8 so every watcher already knows the bytes. a second codec is its own build.
- 60 fps, 1440, 4k, or a bitrate above 3 Mbps for the screens.
- a "this is a game" switch. one mode: a page. motion at this cap is the weak spot on purpose.
- the box making a small copy of the screen. `bitrates.md` makes 720 and 360 from the camera, which is the home card. a 360 of a webpage cannot be read, so the watch page keeps the original screen packets. a bad pipe gets a rough full-size screen, not a tiny one.
- burning the camera onto the screen. they stay two pictures; the layout is numbers, and a watcher can still put the face big.
- a layout for the second and third screen. they are tiles. the first share is the one the layout is for.
- the screen as the home card or the thumbnail. `thumbs.rs` stays a frame of the camera.
