# keyframes

built. how `video` gets a joining watcher its first picture, and why it does that with keyframe requests to the publisher and not with a cache of the last keyframe.

a watcher can decode nothing until a keyframe: every vp8 or vp9 delta frame refers to the frame before it. a browser publisher sends a keyframe only when asked (a PLI or FIR) or when its resolution changes. no periodic keyframes. so a new watcher's first picture is one PLI to the publisher, the publisher encoding a keyframe, and that keyframe copied out to every watcher of the slot.

## who asks

every request goes through `Hub::request_keyframe` (`video/src/main.rs`), per slot and simulcast layer (`simulcast.md`; each layer has its own ssrc, its own `KeyframeAsks` and its own count), with a reason (`Ask`). a join asks on the watcher's start layer. `RUST_LOG=video=debug` logs every request and its plan.

| reason | when | its rule |
|---|---|---|
| `Join` | a watcher's ICE reaches `Connected` (the early ask); one per video slot it watches | below |
| `Backup` | a watcher's peer reaches `Connected` (ICE and DTLS done); one per video slot it watches, with the slot's keyframe count at that moment | below |
| `Join` | a watcher sent a PLI or FIR in its first 3s (`JOIN_PLI_WINDOW`): it has no picture yet | below |
| `Lost` | a watcher sent a PLI or FIR later (lost the picture) | none within `KEYFRAME_GAP`, 1.5s, of any request |
| `Switch` | a watcher's layer changed and it waits for a keyframe on the new one; again every 500ms until it lands | not while one is on its way, none within `FORCED_KEYFRAME_GAP`, 300ms, of any request |
| `Resume` | a watcher's player was hidden and is seen again (`watch-view.md`); again every 300ms until it lands | none within `FORCED_KEYFRAME_GAP`, 300ms, of any request, so many watchers coming back at once share a keyframe per layer |
| `Thumb` | the thumbnail's ffmpeg has no picture (`thumbs.rs`) | none within `FORCED_KEYFRAME_GAP`, 300ms, of any request |
| `Trailing` | the one extra request a burst of joins scheduled | below |

## when a watcher asks

a keyframe is no use to a watcher until its SRTP is up. webrtc-rs binds the watcher to the slot's track when it sets the answer, but every packet written to it before DTLS finishes is dropped (`SrtpWriterFuture::write_rtp` returns 0 until SRTP is ready). SRTP comes up just before the peer turns `Connected`. on prod the answer to `Connected` is ~400ms, and `Connected` to the first frame was ~0.5s when the only ask was at `Connected`.

so each watcher asks at most twice per slot, once each:

1. **early, at ICE connected** (`on_ice_connection_state_change`, `Connected` or `Completed`). ICE is done and only the DTLS handshake is left, ~one or two watcher round trips. the keyframe takes a publisher round trip plus the encode, about as long, so it often lands just after SRTP is up and the watcher has a picture one handshake sooner than before.
2. **backup, at peer `Connected`**. it carries the slot's keyframe count read the moment the peer connected. it asks unless a keyframe is still to come:
   - the watcher's track already holds a picture (`ViewerTrack::holds_picture`, below): skip.
   - a keyframe was forwarded since this watcher connected (the count moved): skip, the watcher has it.
   - a request is on its way (under `KEYFRAME_IN_FLIGHT`, 500ms, and nothing forwarded since): skip, it lands after `Connected`.
   - otherwise the early keyframe (or someone else's) went by before SRTP was up: ask again, by the join rules below.

**the pre-srtp hold.** the early keyframe used to be lost whenever it beat SRTP, and then the backup trailed to the end of the 300ms gap: ~350ms to a first frame instead of ~100. vp9 lost that race on every join. now each `ViewerTrack` keeps what it is sent from its first keyframe on while writes still return 0 (up to `EARLY_PACKETS`, 600, and `EARLY_BYTES`, 768 KB; past either it drops all of it and holds nothing more), and the first write that goes through sends the held packets in order, then the new one. a new keyframe before SRTP replaces what was held. the packets were already rewritten for this watcher, so the flush looks to it like packets that came a little late. local joins went from ~350ms (bimodal with ~120ms) to ~100ms median for vp8 and 88ms for vp9 (`vp9.md`).

the hold lives only as long as the session. `unbind` (the peer closing) and `leave_all` (every way a watch session ends, including `peer gone` when ICE never completes) call `ViewerTrack::release`, which empties it and stops it filling again. the peer's own state callbacks keep only a `Weak<ViewerTrack>` for the backup's check: a strong one closed a cycle (track, resend interceptor, its per-ssrc writers, the transport, the transport's handlers, the peer's callbacks) and no watch session was ever freed, ~1 MiB each with a full hold. `test/soak.js` measures it (`test/README.md`).

**not at answer time.** an ask when the answer goes out lands a publisher round trip later (tens of ms) while the watcher still has ~400ms of ICE and DTLS to go: it would be dropped for that watcher nearly every time. it would also open the 300ms gap below and push the useful ask back. so nothing asks at answer time.

## the join rules

each layer counts the keyframes it forwards (`parse_vp8` or `parse_vp9` in `simulcast.rs`, by the layer's codec, read in the publish loop, one atomic add). a vp9 camera's slot has a feed per codec (`vp9.md`), and asks are kept per codec and layer. each request notes the count. so `KeyframeAsks::decide` knows whether a keyframe is **on its way** (a request under `KEYFRAME_IN_FLIGHT`, 500ms, old, and nothing forwarded since) or **gone** (one was forwarded since).

`Join` (early) and `Backup` share these, after the backup's own check above:

1. a keyframe on its way: skip.
2. no join-type request (`Join`, `Backup` or `Trailing`) in the last 300ms: this opens a gap. ask now, whatever else asked lately. a watcher's loss or the thumbnail may have been answered before this peer existed, and that keyframe is no use to it.
3. otherwise (a join-type request within 300ms, its keyframe gone): schedule **one** trailing request at the end of the gap, shared by every join until then. when it fires it is skipped if a join asked since or a keyframe is on its way again. a backup that finds the trailing request already scheduled skips: it fires after this watcher connected.

so per slot and layer, join-type requests are one opening each 300ms and the single trailing request (which opens the next gap). there used to be one re-ask at once for the first backup inside a gap an early ask opened (the single-viewer case: its own early keyframe went by before its DTLS finished). chrome does not answer a second pli ~50ms after the first: the keyframe count did not move, the request sat "on its way" for 500ms, the watcher's own plis were then the 1.5s `Lost` kind, and a lone join waited ~1.7s for a picture (`test/simulcast.js`, both builds). now that backup takes the trailing request at the end of the gap, and the watcher's plis in its first 3s are joins, so a lone join gets its picture in ~350ms. under a steady burst the trailing requests usually open the gaps and give no re-asks, so it stays near one per 300ms (3.3 keyframes/s), the bound before this. a watcher's backup never waits longer than the rest of one gap plus a publisher round trip, the same worst case as the single ask at `Connected` had, and no join waits out the 1.5s `KEYFRAME_GAP` for its browser's own PLI. before, a join inside 300ms of any request was dropped: the second wave of a go-live push (the `live` event makes every waiting watcher connect at once) often connected just after the first wave's keyframe went by and sat ~1.5s on a black picture. now it waits at most the rest of the gap plus one round trip to the publisher.

a request unanswered after 500ms is taken as lost (RTCP has no retransmission), and the next join or backup asks again.

the tests beside `KeyframeAsks` in `main.rs` pin these: a backup asking again at the end of the gap when the early keyframe went before connect, skipping one on its way or one forwarded after connect, early backups sharing one trailing request, a switch asking at most once per gap, and a burst of watchers (one ICE-connected every 10ms, connected 120ms later) staying within two requests per 300ms with every watcher getting a keyframe within 360ms of connecting.

## a publisher that cannot be asked

the dummy (`video dummy`, `video/src/dummy.rs`) is ffmpeg encoding to rtp, and ffmpeg takes no PLI: the dummy reads its peer's rtcp and drops it. so every request above goes nowhere for a dummy slot, and a joining watcher waits for ffmpeg's next scheduled keyframe. that schedule is `-g` = `-keyint_min` = the frame rate (`FPS`, 15): one keyframe a second, so half a second on average and a second at most. the dummy is 426×240 at 180 kbps (`-cpu-used 16`), so a keyframe a second is small and cheap; the 1s gop stays. it was `-g 30` (2s, ~1s on average, up to 2s): most of the ~0.9-1.6s between `ice-connected` and `first-frame` that `watchperf` measured on prod, whose streams are all dummies. a browser publisher answers a PLI in one round trip and is not on a schedule.

## why not a keyframe cache

the other way, which some sfus do: keep each slot's last keyframe and the packets after it (a GOP), and on join send that GOP to the new watcher at once, then live packets. no round trip to the publisher. it was looked at and not built:

- **the cache is empty almost always.** keyframes come only on request. a cache bounded to ~2s or ~2-3MB per slot holds a whole GOP only within ~2s of the last keyframe, and past that it must be dropped (a GOP without its keyframe is useless). in a quiet room the next join finds nothing and asks the publisher anyway. the joins inside 2s of a keyframe are the burst case, which the trailing request above covers for one round trip and 300ms.
- **the replay needs per-watcher timing.** simulcast already gives every watcher its own `ViewerTrack` and sequence and timestamp offsets (`simulcast.md`), but a replay also needs a way to know the moment a watcher's binding is up so the replay goes before its first live packet, and its own pacing.
- **the replay's timestamps.** the cached frames are up to 2s old and arrive in a burst. sent as they are, the browser's jitter buffer plays them at their own pace and the watcher sits ~2s behind live for good, or its timing gives up. they would need rewriting per watcher (squeezed together just behind the live timestamp) so the decoder runs through them and lands on live. how chrome, firefox and safari handle that was not tested: `test/` declares playwright but it is not installed, so no browser checked it.
- **the burst itself.** 2-3MB at once to a new watcher overflows home routers and our shared udp buffer (4MB for every peer), and the nack responder keeps 512 packets per stream, fewer than a big GOP, so a lost early packet of the keyframe cannot be resent and the watcher sends a PLI anyway.

the dummy is the one publisher whose keyframes come on a schedule, so a cache would be full for it: a join would get a picture with no wait at all instead of half a second on average. that is not worth the rebuild above for fake streams; the 1s gop gets most of it.

if it is built later (a box-made 360 rung, `bitrates.md`, would make keyframes on the box's own schedule and give the cache something to hold): per-watcher tracks, per-watcher sequence and timestamp offsets, a paced replay, and a browser test. the PLI path above stays as the fallback.

## codecs

`media.rs` registers opus and vp8 for every peer, and vp9 profile 0 for publish peers (`vp9.md`). vp8 and vp9 both have keyframe detection. there is no other video codec a publisher can be answered.
