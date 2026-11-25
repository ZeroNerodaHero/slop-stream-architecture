# watch view: no video for a player nobody sees

a watcher tells `video` what its player is doing, and `video` sends the camera and screens only as big as that, or not at all. audio is never touched.

## the frame

after the answer, the watch socket takes one text frame per change, exactly one of:

```
{"view":"full"}
{"view":"small"}
{"view":"hidden"}
```

anything else (other spacing, other keys, binary) is a strike; so is sending the view already asked for. past 16 strikes the socket gets `{"error":"bad frames"}` and is closed. a watcher starts as `full`.

the changes go through a token bucket per socket (`view::Gate`): 6 at once, then one a second. a change past the budget is held, not dropped, and the last one wanted lands when a token comes back, so a page that flaps ends up where it stopped.

## what video does (`follow` in `main.rs`, `Rewrite` in `simulcast.rs`)

| view | video |
|---|---|
| `full` | the normal picker (`simulcast.md`). coming from `small` it lifts at once to the start layer (720 for a 1080 camera) and climbs from there |
| `small` | pinned to the lowest offered layer, never the top one: if the lowest goes quiet the next one up, back down when it returns (`pinned_limits`) |
| `hidden` | `Rewrite::pause`: no video packet for this watcher, on any slot. the picker and its health stop. rtcp and audio go on |

previews are always pinned, whatever they say.

coming back from `hidden`: the picker's climb wait restarts, the health windows are cleared, the target is set (the layer it had, or the pinned one), and a keyframe is asked for that layer at once (`Ask::Resume`, `keyframes.md`), again every 300ms on its own timer until it lands: chrome now and then drops a pli that comes soon after another one (the thumbnail's, on the low layer, makes a keyframe on every layer), and waiting out a switch's 500ms for that showed as a 760ms resume. the pause cleared the watcher's layer, so the resume is a switch: nothing is forwarded until a keyframe on the target, and that keyframe goes out with the sequence number after the last one sent before the pause, a timestamp moved on by the wall time hidden, and the picture id and tl0 one past the last ones. chrome sees one stream with a gap in time, no loss, no nacks. the resend floor (`resend.rs`) is set at that keyframe, so a late nack for something before the pause is not answered.

keyframe cost: `Resume` is rate limited per stream and layer: never within 300ms of any other request on that layer. a crowd coming back at once shares one keyframe a layer; one socket can ask at most about once a second after its first 6.

## what the page does (`frontend/src/infra/watch-view.ts`)

- the watch page's player box (`useShowsWatch` in `WatchPage.tsx`) is watched with an `IntersectionObserver`: any pixel on screen is seen.
- the corner player (`WatchCorner.tsx`) is fixed on screen, so it is seen whenever its document is visible. popped out it lives in its own window, and that window's document counts, not the tab's.
- `full` if a full-size player is seen, `small` if only the corner is, `hidden` if none is. with no player registered, the tab's visibility.
- `hidden` is sent after 2s of it (`HIDE_AFTER_MS`); a look away and back inside that sends nothing. `full` and `small` go at once.
- a new socket starts from `full` and sends the current view if it is anything else.

previews on home and in the profile popup already hang up when the tab is hidden (`preview.ts`) and are pinned low by `video`.

## measured locally

`node test/simulcast.js`, a 1080p30 publisher, one watcher on 1080, 8s hidden then 8 hide/show cycles:

| | before (main) | now |
|---|---|---|
| video to a hidden tab | 2.5 Mbps, all of it | 0 (about 10-18 KB already on the wire as it pauses) |
| saved in 8s hidden | | ~2.6 MB |
| audio to a hidden tab | 24 kbps | 24 kbps |
| show to first frame, 1080 layer, median / max of 8 | no pause | 137 / 169 ms |
| show to first frame, one 720p encoding, median / max of 8 | no pause | 74 / 88 ms (before the 300ms re-ask) |
| packets lost across 8 pauses | | 0 |
| corner player | 720 or 1080 | 360, back to ≥720 ~220ms after leaving the corner |
| 61 toggles in one burst | | 1-3 applied, lands on the last |
| 20 garbage frames | | socket closed with `bad frames` |
