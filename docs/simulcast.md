# simulcast

built. the camera is sent as up to three layers (vp8, or vp9 with a vp8 copy, `vp9.md`) and `video` picks one per watcher, so a watcher on a weak link gets a smaller picture instead of loss. screens are still one encoding.

## the publisher (`frontend/src/infra/simulcast.ts`)

the camera transceiver is added with three `sendEncodings`, rids `q`, `h`, `f`, low to high. the top layer is the source capped at 1080 tall; `h` is top / 1.5 and `q` is top / 3. a layer under its minimum height (`q` 180, `h` 240) is sent `active: false`, so a 480 source sends 320 and 480 only and a 240 source sends one.

every encoding, camera layers, the single-encoding fallback and screens, carries `maxFramerate: 30`, and every capture (camera, face camera, screens) asks for `frameRate` at most 30.

caps follow the layer's height through this table, linear between points (vp8; vp9 layers get 0.7 of it, `vp9.md`):

| height | cap |
|---|---|
| 180 | 150 kbps |
| 360 | 500 kbps |
| 540 | 800 kbps |
| 720 | 1.2 Mbps |
| 1080 | 2.5 Mbps |

a 1080p30 camera sends 360 / 720 / 1080 at 0.5 / 1.2 / 2.5 Mbps, 4.2 Mbps up in all. beside a screen the camera's top layer takes the old shared cap and size from `tuneSenders`, and the layers under it 45% and 15% of that cap (at least 60 kbps).

a browser that throws on three encodings gets one: 720p at 2.5 Mbps, 30fps, the old single stream. so does `MODE=single` in the test.

the publisher's own stats panel folds the layers of one track into one line: the tallest sending layer's size and fps, bitrates and nack/pli rates summed, the worst loss.

## the sfu (`video/src/simulcast.rs`, `fanout.rs`, `resend.rs`)

the publish peer registers the mid and rid header extensions, so webrtc-rs answers the offer's `a=rid:… send` lines and fires `on_track` once per rid. each video slot holds a `Feed` with three `Layer`s (ssrc, last packet time, bitrate as an ewma over 500ms windows, keyframe count, keyframe height). a slot offered without rids is one layer at level 0: the dummy and old publishers. a vp9 camera's slot holds a vp9 feed and a vp8 one (`vp9.md`).

every watcher of a video slot has its own `ViewerTrack` (a `TrackLocal` with one binding) and a `Viewer`: target layer, current layer, and a `Rewrite`. the publish loop for each layer calls `Feed::forward`, which for each watcher asks its `Rewrite` whether to send the packet:

- a packet of the watcher's current layer goes out with its sequence number and timestamp shifted.
- the first packet of a keyframe on the target layer switches the watcher: the sequence number continues at last sent + 1, the timestamp at last sent + the wall time since (90 kHz, at least 1), the vp8 or vp9 picture id and tl0picidx at last sent + 1. from then on only that layer is sent.
- anything else is dropped.

the payload is copied only when the picture id or tl0 offset is not zero, and the copy is shared by every watcher with the same offsets (four per packet). the header is built fresh without the publisher's header extensions, whose ids mean nothing on the watcher's side. no lock is held across an await; the watcher list is an `Arc<[Arc<Viewer>]>` swapped on join and leave.

watcher peers use `resend.rs` instead of the stock nack responder: the same 512-packet ring, but a switch sets a floor, and a nack for a packet before it is not answered. those packets belong to the old layer, the new keyframe replaces them, and resending them on a link that is already full is what kept a squeezed watcher frozen for seconds.

## picking a layer

one `follow` task per watcher and video slot reads the watcher's rtcp and ticks every 250ms. signals:

- **loss**: fraction lost from the watcher's receiver reports on its ssrc, smoothed.
- **nack ratio**: nacked packets over packets sent in a sliding 1s window, not counting nacks for packets before the last switch (needs 50 sent).
- **remb**: chrome sends one; the watcher side negotiates no transport-cc.

loss and nack windows restart when a switch lands. `Picker::decide` (pure, tested in `simulcast.rs`):

| rule | value |
|---|---|
| congested | loss ≥ 10%, nack ≥ 10%, or remb < 0.6 × the current layer's rate |
| where to | loss or nack ≥ 25%: the lowest live layer; a low remb: the highest layer under remb × 0.85; else one down |
| settle | 1s between decisions, none right after a climb (a climb that hurts is undone at once) |
| remb after a climb | ignored for 3s, it is still sized for the old layer |
| healthy | loss < 2%, nack < 2%, remb not under the current rate |
| climb | one up after healthy for the wait: 4s, 8s after a drop, doubled up to 32s when a climb fails within 10s, back to 4s after holding 30s |
| layer gone | no packets for 1s: move to the nearest live one |
| previews and small players | pinned: capped at the lowest offered layer, and if it goes quiet the next one up but never the top (`pinned_limits`, `watch-view.md`) |

a decision sets the target and asks the publisher for a keyframe on that layer (`Ask::Switch`, `keyframes.md`), again every 500ms until it lands. chrome makes a keyframe on every layer for any one pli.

## joining

`start_level`: a preview starts on the lowest live layer that is not the top one (the lowest offered before any is live); a watcher on the highest live layer whose rate fits 1.5 Mbps, which is 720 for a 1080 camera. before any rates are known, layer 1 if offered. the join and backup keyframe asks go to the start layer.

## measured locally

`node test/simulcast.js` (below), headless chrome publishing a 1080p30 y4m clip, video on loopback, 10 joins each:

| | main, one 720p encoding | this, simulcast |
|---|---|---|
| first frame, median / p90 | 1677 / 1718 ms | 346 / 369 ms |
| preview first frame, median / p90 | | 113 / 122 ms |
| dummy first frame, median / p90 | | 280 / 588 ms |
| climb 720 → 1080, healthy watcher | | 4.3s after join, 0 freeze |
| switch, decision to the new layer's keyframe out | | 27-90 ms |
| 10s squeeze to 800 kbps from 1080 | stays 720, 0 fps in the second half, 12.9s frozen in all | decided 350ms in, on 360 at 1.0s, 30 fps, 0.77s frozen |
| back to 720 after the squeeze | | 0.6s (after the 8s wait from the drop) |

the first frame gain is the keyframe changes in `keyframes.md`, not simulcast. the publisher's own ramp is slow on loopback for both (chrome's estimate takes ~25s to turn on 720 and ~35s for 1080, ~40s for main's single 720p to reach 2 Mbps), and the test waits for it before measuring.

## testing it

```
cargo build --release -p video
node test/simulcast.js
MODE=single VIDEO_BIN=<a main build> node test/simulcast.js
```

it starts its own `video` on loopback ports 17880/17882 with a mock api, a publisher chrome with a fake camera from a y4m clip (`CLIP`, made with ffmpeg if missing), and a watcher chrome. the squeeze is a node udp relay in front of one watcher (the answer's candidate port is rewritten to it) that drops past 150ms of queue at `DOWNLINK_KBPS` (800) for `SQUEEZE_MS` (10000). `OUT` and `LOG` keep the results json and video's log. it touches nothing outside the machine.
