# screen

a plan, not a build. the screen share that already runs, aimed at a tab of some other site. obs waits.

## today

while live, one press runs `getDisplayMedia` (`publish-atoms.ts`, `shareScreen`). the browser's picker: a screen, a window, or a tab. the page caps it at 1920×1080 and 30 fps, sets `contentHint` to `detail`, and sends no audio. `replaceTrack` fills the first empty screen section. those sections were in the offer from the start (`SCREEN_SLOTS` = 3), so a share mid-stream renegotiates nothing.

the screens share 3 Mbps. one screen gets all of it, three get 1 each. the camera drops to 500 kbps while any screen is up, from 2.5. the box copies the packets. vp8 only (`media.rs`).

a watcher already has the four video sections. the first live screen goes big, the camera becomes a tile, a click swaps them (`watch-atoms.ts`). the streamer's own preview stays the camera, with a 160px tile per screen. the browser's stop-sharing bar is the same stop as the tile.

home and the thumbnail stay a frame of the camera (`thumbs.rs`). a phone has no `getDisplayMedia`, so the button is not there.

## what it is for

a site with nothing to connect a stream to. the person is already on that page, goes live here, and shares that tab. watchers get the tab big and the face as a tile. the page does not composite them into one frame.

the picture stays one browser encode. vp8, 1080p, 30 fps, the same 3 Mbps. a retina capture scaled down inside the encoder would spend the bits on pixels the cap cannot afford (`bitrates.md`). the capture cap stays 1920×1080.

## sharper text, same bits

a page is letters and ui. when the uplink or the cpu gets tight, the encoder drops frames and keeps the pixels. the screen sender sets `degradationPreference` to `maintain-resolution` for as long as that slot has a track, and clears it when the slot is emptied. the camera stays `motion`, so a face keeps its frames.

`contentHint` stays `detail`. a video playing inside the tab stutters before it goes soft. that is the trade. 60 fps and a higher cap are how a game looks better, and they cost a core and a fatter copy to every watcher.

the cursor stays in the picture (`cursor: "always"`), so a person can point at the page. the picker hides this site's own tab (`selfBrowserSurface: "exclude"`) and lets them switch which tab is shared without stopping (`surfaceSwitching: "include"`). a browser that rejects those hints is asked again with the plain size cap, and the share still happens.

two screens and a third still split the 3 Mbps. the first share is the one the budget is for. the button still stops at three.

## what it costs

nothing new on the wire. one screen is 3 Mbps plus the camera at 0.5, and every watcher gets those bytes, the same as today. `maintain-resolution` changes which frames survive, not how many bits leave.

the cpu is the one vp8 encode, in software, on the streamer's machine. a tab that sits still is cheap. a tab with a video playing in it is about a core. the box still does not decode.

## sound

the tab's own audio is `audio.md`. one opus leaves the page: the mic, the share, or the two mixed. this file does not add a second audio section, and the share stays silent until that plan is built. `getDisplayMedia` will not hand over the sound without the picture, so the sound arrives with this same share, into the one opus, not into the screen slot.

## pages

go live, the share button, same place:

- the constraints above. a rejected hint retries with the size cap only
- `degradationPreference` is `maintain-resolution` on a screen sender that has a track
- labels, previews, the three-screen stop, and the camera stepping back to 500 kbps stay

watch: no change. the first screen goes big, the camera is a tile, a click swaps them.

`test/screen.js` stays the check: share, the screen goes big, a second screen, stop. chrome already picks the screen for that test.

`spec.md`'s screen paragraph changes in the same change: the cursor, the hidden own tab, the retry, and `maintain-resolution`. the 1080p30 cap, the 3 Mbps, and `audio: false` stay as written until `audio.md`.

## not here

- obs, rtmp, or a second ingest. `spec.md` already leaves those out. a later obs door only pays off if the box forwards obs's own encode. running it back through vp8 at 3 Mbps spends a core and throws the sharper picture away.
- a newer codec. vp9 or av1 hold text in fewer bits, and `media.rs` is opus + vp8 so every watcher already knows the bytes. a second codec is its own build.
- 60 fps, 1440, 4k, or a bitrate above 3 Mbps for the screens.
- a "this is a game" switch. one mode: a page. motion at this cap is the weak spot on purpose.
- the box making a small copy of the screen. `bitrates.md` makes 720 and 360 from the camera, which is the home card. a 360 of a webpage cannot be read, so the watch page keeps the original screen packets. a bad pipe gets a rough full-size screen, not a tiny one.
- burning the camera onto the screen. they stay two pictures.
- the screen as the home card or the thumbnail.
