# keyframes

built. how `video` gets a joining watcher its first picture, and why it does that with keyframe requests to the publisher and not with a cache of the last keyframe.

a watcher can decode nothing until a keyframe: every vp8 delta frame refers to the frame before it. a browser publisher sends a keyframe only when asked (a PLI or FIR) or when its resolution changes. no periodic keyframes. so a new watcher's first picture is one PLI to the publisher, the publisher encoding a keyframe, and that keyframe copied out to every watcher of the slot.

## who asks

every request goes through `Hub::request_keyframe` (`video/src/main.rs`), per slot, with a reason (`Ask`):

| reason | when | its rule |
|---|---|---|
| `Join` | a watcher's peer reaches `Connected`; one request per video slot | below |
| `Lost` | a watcher sent a PLI or FIR (lost the picture) | none within `KEYFRAME_GAP`, 1.5s, of any request |
| `Thumb` | the thumbnail's ffmpeg has no picture (`thumbs.rs`) | none within `FORCED_KEYFRAME_GAP`, 300ms, of any request |
| `Trailing` | the one extra request a burst of joins scheduled | below |

## a join

the slot counts the keyframes it forwards (`is_vp8_keyframe` in `media.rs`, on the first packet of partition 0, read in the publish loop, one atomic add). each request notes the count. so `KeyframeAsks::decide` knows whether a keyframe is **on its way** (a request under `KEYFRAME_IN_FLIGHT`, 500ms, old, and nothing forwarded since) or **gone** (one was forwarded since).

1. a keyframe on its way: skip. the joiner's peer is bound before it lands, so it gets that one.
2. no join asked in the last 300ms: this is the first join of a burst. ask now, whatever else asked lately. a watcher's loss or the thumbnail may have been answered before this peer existed, and that keyframe is no use to it.
3. a join asked within 300ms, and its keyframe is gone: this joiner may have connected after it passed. schedule **one** trailing request at the end of the 300ms gap, shared by every join until then. when it fires it is skipped if a join asked since or a keyframe is on its way again.

so join requests stay at one per 300ms per slot (3.3 keyframes/s under any join rate, the bound before this), and no join waits out the 1.5s `KEYFRAME_GAP` for its browser's own PLI. before, a join inside 300ms of any request was dropped: the second wave of a go-live push (the `live` event makes every waiting watcher connect at once) often connected just after the first wave's keyframe went by and sat ~1.5s on a black picture. now it waits at most the rest of the gap plus one round trip to the publisher.

a request unanswered after 500ms is taken as lost (RTCP has no retransmission), and the next join asks again.

## a publisher that cannot be asked

the dummy (`video dummy`, `video/src/dummy.rs`) is ffmpeg encoding to rtp, and ffmpeg takes no PLI: the dummy reads its peer's rtcp and drops it. so every request above goes nowhere for a dummy slot, and a joining watcher waits for ffmpeg's next scheduled keyframe. that schedule is `-g` = `-keyint_min` = the frame rate (`FPS`, 15): one keyframe a second, so half a second on average and a second at most. it was `-g 30` (2s, ~1s on average, up to 2s): most of the ~0.9-1.6s between `ice-connected` and `first-frame` that `watchperf` measured on prod, whose streams are all dummies. a browser publisher answers a PLI in one round trip and is not on a schedule.

## why not a keyframe cache

the other way, which some sfus do: keep each slot's last keyframe and the packets after it (a GOP), and on join send that GOP to the new watcher at once, then live packets. no round trip to the publisher. it was looked at and not built:

- **the cache is empty almost always.** keyframes come only on request. a cache bounded to ~2s or ~2-3MB per slot holds a whole GOP only within ~2s of the last keyframe, and past that it must be dropped (a GOP without its keyframe is useless). in a quiet room the next join finds nothing and asks the publisher anyway. the joins inside 2s of a keyframe are the burst case, which the trailing request above covers for one round trip and 300ms.
- **fan-out is one shared track per slot.** every watcher of a slot is a binding of the same `TrackLocalStaticRTP`, and one `write_rtp` goes to all of them. a replay to one watcher needs a track per watcher (or a custom `TrackLocal`), the publish loop writing to each, and a way to know the moment a watcher's binding is up so the replay goes before its first live packet. that rebuilds the hot path every stream's packets go through.
- **the replay's timestamps.** the cached frames are up to 2s old and arrive in a burst. sent as they are, the browser's jitter buffer plays them at their own pace and the watcher sits ~2s behind live for good, or its timing gives up. they would need rewriting per watcher (squeezed together just behind the live timestamp) so the decoder runs through them and lands on live. how chrome, firefox and safari handle that was not tested: `test/` declares playwright but it is not installed, so no browser checked it.
- **the burst itself.** 2-3MB at once to a new watcher overflows home routers and our shared udp buffer (4MB for every peer), and the nack responder keeps 512 packets per stream, fewer than a big GOP, so a lost early packet of the keyframe cannot be resent and the watcher sends a PLI anyway.

the dummy is the one publisher whose keyframes come on a schedule, so a cache would be full for it: a join would get a picture with no wait at all instead of half a second on average. that is not worth the rebuild above for fake streams; the 1s gop gets most of it.

if it is built later (a box-made 360 rung, `bitrates.md`, would make keyframes on the box's own schedule and give the cache something to hold): per-watcher tracks, per-watcher sequence and timestamp offsets, a paced replay, and a browser test. the PLI path above stays as the fallback.

## codecs

`media.rs` registers opus and vp8 only, so vp8 is the one video codec a publisher can send and the one with keyframe detection. a slot of any other codec counts no keyframes: a request to it looks on its way for 500ms and a join in that time shares it, which is no worse than the 300ms drop before.
