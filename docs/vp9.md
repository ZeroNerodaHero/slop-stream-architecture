# vp9

built. a camera is sent in vp9 when the streamer's browser encodes it well, with a small vp8 copy beside it, so a watcher whose browser cannot decode vp9 still gets a picture. screens, voice cameras and the dummy stay vp8. nothing on the page changes.

## the publisher (`frontend/src/infra/camera-codec.ts`, `simulcast.ts`, `atoms/publish-atoms.ts`)

`cameraCodec()` runs once per page, before the first go-live builds its offer, so it costs no round trip:

- no `RTCRtpTransceiver.setCodecPreferences` or no vp9 in `RTCRtpSender.getCapabilities('video')`: vp8.
- `navigator.mediaCapabilities.encodingInfo` for webrtc vp9 1080p30 at 1.75 Mbps (`VP9_PROBE`): vp9 when it is supported and either `powerEfficient` (a hardware encoder) or `smooth` on at least 4 cores (`MIN_SOFTWARE_CORES`, adequate software). else vp8. a throw is vp8.

vp9 is simulcast, not svc: rids `q`, `h`, `f`, the same sizes and switching as vp8 (`simulcast.md`), each encoding `scalabilityMode: 'L1T1'`. svc would put every spatial layer on one ssrc with inter-layer prediction; the sfu would then strip layers out of each packet and rewrite the descriptor per watcher, and the switching, keyframe asks, layer stats and nack floor in `simulcast.md` and `keyframes.md` would all need a second model. simulcast reuses every one of them per layer. its cost is a few percent more uplink than svc for the same layers, which the lower vp9 caps more than pay for.

caps are the vp8 table times `VP9_SHARE`, 0.7: 1080 at 1.75 Mbps, 720 at 840 kbps, 360 at 350 kbps. every encoding keeps `maxFramerate: 30`. the camera transceiver is steered with `vp9First` (vp9 profile 0 first, other vp9 profiles dropped, vp8 and the rest kept), so a server that cannot do vp9 still answers vp8. if the browser throws on vp9 simulcast it tries vp8 simulcast, then the single encoding.

### the vp8 copy

a second transceiver, added last (after the screens), vp8 only (`vp8Only`), with two rids:

| rid | size | cap | on |
|---|---|---|---|
| `cq` | the lowest live camera layer, 360 for 1080 | the vp8 rate for that size, 500 kbps | always |
| `ch` | the next live layer up, 720 for 1080 | vp8, 1.2 Mbps | only while the sfu says a vp8 watcher watches full size |

a 1080p30 camera sends 1.75 + 0.84 + 0.35 Mbps of vp9 and 0.5 of vp8: 3.44 Mbps up, against 4.2 for vp8 simulcast. with `ch` on it is 4.64. a source too small for two layers sends `cq` alone.

the sfu sends `{"event":"copy","full":true|false}` on the publish socket. `true` at once when the first vp8 watcher (not a preview, view full) arrives, `false` 10s (`COPY_HOLD`) after the last leaves or shrinks, so a flicker does not toggle an encoder. `tuneCopy` sets `ch` active and leaves `cq` alone.

after the answer `settleCodec` reads which codec the camera got. an old sfu answers vp8 on the camera and rejects or ignores the copy: the copy sender is set inactive and caps go back to vp8. `setCameraTrack` swaps the track on both senders at every `replaceTrack` site.

## the sfu (`video/src/simulcast.rs`, `media.rs`, `main.rs`, `fanout.rs`)

the publish peer registers vp9 profile 0 (pt 98) beside vp8. watcher and dummy peers register what they are given per track.

`offer_slots` reads each video section's codecs. a section with rids `cq`/`ch` and vp8 only is the copy: it is tied to the first vp9 camera slot without one and is not a slot of its own, so it does not count toward the slots watchers see. a camera that offers vp9 but has no copy, or a second copy, gets no copy: the camera is pinned to vp8 (`Offered::pins`) and every watcher gets vp8. `pin_codecs` sets each transceiver's codec preferences before the answer, because webrtc-rs otherwise answers every codec negotiated on any section. so the answer is the codec choice: no extra round trip.

each video slot has `Feeds { vp8, vp9 }`. a vp9 camera fills `vp9` from rids `q`/`h`/`f` and `vp8` from the copy's `cq`/`ch` (levels 0 and 1); a vp8 camera, a screen and the dummy have `vp8` only. a track whose codec is not its feed's is dropped.

a watcher's codec is read from its own offer (`decodes_vp9`): vp9 when every receiving video section lists vp9 profile 0. `Feeds::pick` gives it the vp9 feed when that feed is live, or when neither is live yet; otherwise the vp8 feed. its `ViewerTrack` is made with that codec, and the answer is pinned to it. once picked, a watcher keeps its feed; switching happens inside it.

### why a vp8 copy and not vp8 for everyone

the other choice was to drop to vp8 for the whole stream when one vp8-only watcher arrives. that needs the publisher to renegotiate or swap encoders mid-stream: every watcher of that stream gets a keyframe wait and a freeze when anyone with an old browser joins, and the stream stays on vp8's bitrate until they leave. the copy costs 0.5 Mbps up, and 1.2 more only while a vp8 watcher watches full size, it needs no renegotiation, and a vp8 watcher's first frame comes the same way as anyone's. a vp8 watcher tops out at 720 for a 1080 camera.

### no black screen

- `cq` is never turned off, so the vp8 feed always has a live layer.
- a watcher gets vp9 only when its offer lists vp9 profile 0 on every video section and the vp9 feed is live.
- a camera without a usable copy is vp8 for everyone.
- a publisher on a new page and an old sfu settles to vp8 (`settleCodec`).
- the thumbnail is taken from the vp8 feed's lowest layer, so `thumbs.rs` decodes vp8 as before.

### vp9 packets

`parse_vp9` reads the payload descriptor (RFC 9628, as chrome sends it): I P L F B E V Z, a 7 or 15 bit picture id, the layer byte and tl0picidx when L is set (tl0picidx only without F), up to three p_diff bytes when F and P are set, and the scalability structure when V is set (its last spatial layer's size is the keyframe height). a keyframe is B set, P clear, spatial id 0. anything short or malformed is not a keyframe. `Rewrite` shifts the picture id and tl0picidx on a switch exactly as for vp8 (`simulcast.md`), so layer switches are the same code. plis go to the layer's own ssrc, per codec (`Slot::asks[codec][level]`, `keyframes.md`).

## measured locally

`MODE=vp9 node test/simulcast.js` (headless chrome 157 publishing a 1080p30 y4m clip; one vp9 publisher, vp9 and forced vp8-only watchers; 10 joins each):

| | vp8 simulcast | vp9 + vp8 copy |
|---|---|---|
| send, 1080 / 720 / 360 | 2488 / 1201 / 499 kbps | 1742 / 842 / 351 kbps, copy 360 at 516 |
| first frame, median / p90 | 99-116 / 142-160 ms | vp9 88 / 109 ms, vp8-only 88 / 105 ms |
| preview first frame, median | 105-109 ms | 88 ms (vp9 and vp8-only previews at 360) |
| copy `ch` on after a vp8 watcher arrives | | 621 ms; that watcher on 720 at 4.3 s |
| copy `ch` off after it leaves | | 9.1 s |
| resume to picture, median | 149 ms | 49 ms |
| switch, decision to new keyframe out, median | 78-81 ms | 36 ms |
| dummy first frame, median | 241 ms | 248 ms |

both columns are with the pre-srtp hold (`keyframes.md`); before it vp8 joins were ~350 ms or ~120 ms depending on a race, and vp9 joins lost that race every time (347 ms).

equal quality, offline (`test/codec-quality.sh`, ffmpeg libvpx realtime, `-cpu-used` 6 for vp8 and 7 for vp9, 1080p30, psnr / ssim against the source):

| clip | vp8 | vp9 at the same quality | saving |
|---|---|---|---|
| xiph `dinner` (indoor, people) | 2573 kbps, 30.06 dB / 0.934 | 1486 kbps, 30.07 dB / 0.935 | 42% |
| xiph `pedestrian_area` (street, people) | 2019 kbps, 29.93 dB / 0.900 | 1509 kbps, 29.91 dB / 0.902 | 25% |
| a photographic gif, upscaled | 2802 kbps, 44.92 dB | 2102 kbps, 44.93 dB | 25% |
| dithered pixel-art gifs, upscaled | | | about 0, one ~5% worse |

camera-like content saves 25-42%, so 0.7 of the vp8 caps is the same quality or better for it. heavily dithered flat art gains nothing, so such a camera at the vp9 caps looks somewhat worse than it did at the vp8 caps.
