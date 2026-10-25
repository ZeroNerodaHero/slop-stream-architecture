# hover preview

a plan, not a build. hold the mouse on a card on home and the card plays the stream, muted; click it and the watch page shows the first frame at once, because the connection the card made is the one the page uses. the second half is the point: today every click pays the whole connection pipeline after the page mounts. the first half is what you see while it is paid. findings first, then the three questions, then what to build if it is built.

## what exists already

picture in picture is a stream whose connection outlives its page, and the watch page already knows to adopt a connection under way instead of starting one:

```ts
// watch-atoms.ts:154
export async function watch(name: string): Promise<void> {
  if (store.get(pipAtom) && name === store.get(watchNameAtom) && !RESTART_PHASES.includes(store.get(watchPhaseAtom))) return;
  await start(name);
}
```

the page's `<video>` binds to the same `remoteStreamAtom` MediaStream and nothing is renegotiated. `test/pip.js:190` asserts the property wanted here: one `/watch` call in total when a page takes a live connection over. a hover preview is that handoff with a different trigger.

the server already treats a join as "a watcher": a new peer on `Connected` asks the publisher for a keyframe on every slot at once (`video/src/main.rs:802`), rate limited so a burst of joins shares one (`FORCED_KEYFRAME_GAP`, 300ms, `main.rs:75`). nothing on the server needs to change for a preview. a preview is a watcher.

## where a click's time goes

the route change is free: `WatchPage` is in the main bundle, nothing is lazy (`router.tsx`). everything the eye waits for is the pipeline in `start()` (`watch-atoms.ts:160`):

| step | about | notes |
|---|---|---|
| `POST /api/streams/:name/watch` | 30–100ms | the api asks video `GET /live` over http, then postgres twice (`api/src/main.rs:658`, `:254`) |
| `createOffer`, `setLocalDescription`, ice gathering | 10–50ms, up to the 1s cap | no stun, host candidates only (`relay.ts:60`) |
| `/ws` open, offer, answer | 1–2 rtt | tls through caddy, then video negotiates (`main.rs:740`) |
| ice checks, dtls handshake | 100–400ms | 2–4 rtt. the big fixed cost |
| the keyframe | 100–300ms | video's pli to the publisher on `Connected`, the publisher encodes one, it is copied out. a join inside 300ms of the last request is dropped and waits for the browser's own pli, which passes on a 1.5s gap (`KEYFRAME_GAP`, `main.rs:72`) |
| decode, `playing` | ~50ms | |

0.5–1.5s, most of it ice/dtls and the keyframe. only a real connection can warm those. prefetching the grant alone saves one row.

## hover, not mousedown

`pointerdown` comes 50–150ms before `click` for a mouse: one api round trip at best fits in it, none of the rows that matter. a hover lasts 300ms–1s+ before a click and covers the whole table. so the trigger is `pointerenter` on the card (and keyboard `focus` within it), after a delay; `pointerdown` is not worth a code path. on touch there is no hover and tap-to-click is already instant, so phones keep the thumbnail.

## the shape

1. hover a card, hold still past the delay: the full watcher pipeline starts for that name.
2. first frame: the card's `<img>` (`HomePage.tsx:33`) gives way to a muted `<video>` on that MediaStream. muted autoplay needs no gesture, so it plays. before the first frame the thumbnail stays; nothing flickers.
3. click: navigate. `WatchPage` mounts, `watch(name)` finds a session under way for this name and binds its `<video>` to the same stream. first frame at once. unmute as today.
4. leave the card: a short grace (~400ms, so crossing the chip or the text does not flap), then teardown, thumbnail back. one preview at a time; the next card's preview replaces it after its own delay.
5. the ws says `not live`, or anything fails: the thumbnail stays and nothing retries. the 3s home poll drops the card on its own.

the one real piece of work is in `watch-atoms.ts`. `pc`, `ws`, `primary`, `videoTracks`, `attempt` are module globals (`:93`–`:106`) and `start()` begins with `teardown()`: one connection at a time, which is how picture in picture works at all. a preview has to live beside a corner player (hovering home while a stream plays bottom right must not kill it), so the attempt (`:187`–`:256`: the peer, its transceivers, `ontrack`, `onconnectionstatechange`, `onMessage`, `connectRelay`) becomes a value, a session, and there are two slots for one: the watched session and the previewed one. click promotes the preview into the watched slot; the old corner stream ends, as it does today when another card is opened. the preview's own atoms (`previewNameAtom`, `previewStreamAtom`) are separate; `remoteStreamAtom`, `slotsAtom` and the phase atoms stay the watched session's. only `WatchPage` and `MiniPlayer` read those today.

a smaller version reuses the singleton and skips previews while picture in picture is on: hover → `start(name)` unless `pipAtom`, leave → `endWatch()` unless `pipAtom`, the takeover check in `watch()` no longer gated on `pipAtom`, the card renders `remoteStreamAtom` when `watchNameAtom === stream.name`. ~40 lines, and a stepping stone, not the shape: the case it excludes is exactly the one the refactor exists for.

the preview does not need the grant. the grant's `bio`, `verified`, `avatar`, `live` are all in the home list already (`LiveStream`, `api.ts:14`), `url` is the constant `/ws`, and the ws answers `not live` itself. so the hover path goes straight to the socket and the api, postgres and the api→video hop are not on it. on promote, the page's `bioAtom`/`verifiedAtom`/`avatarAtom` are set from the card's data instead of a grant.

## 1. does hovering spam the backend?

not if the start waits for a dwell. with a delay before anything is sent and the timer cleared on `pointerleave`, a mouse crossing the grid costs nothing: no request, no socket, no peer. a card crossed at normal speed is under the mouse for 100–200ms and never reaches the timer.

a hover that does pause past the delay costs one join, which is what a click costs today:

| what | cost | who pays |
|---|---|---|
| the grant | none: the preview skips it (above). if kept: one `POST /watch` = one `GET video/live` + two postgres queries | api, postgres, video |
| the socket | one wss through caddy, one text frame each way | caddy, video |
| the peer | ice, a dtls handshake (a few ms of cpu), srtp contexts, one task | video |
| the keyframe | one pli per slot to the publisher, shared with every join in the same 300ms. a vp8 keyframe is several to ten delta frames in size (tens of kB against ~10kB at 2.5Mbps/30fps), and every watcher of that stream downloads it | the publisher's upload, every watcher's download |
| while it is up | a copy of every packet of the stream, 2.5Mbps for a camera (`publish-atoms.ts:21`), up to 3.5Mbps with a screen | video's egress |
| leaving | one close | video |

for scale, what home does already, per open tab: `GET /api/streams` every 3s (each one an api→video `/live` hop, a redis scan and postgres) and `GET /thumb/<name>.jpg` every 5s per card (`HomePage.tsx:14`, `:16`). a preview is a burst on top of that steady floor, bounded to one per tab at a time.

the one cost that is not the hoverer's own is the keyframe. a stream's watchers all pay for every join. the forced gap bounds it to 3.3 keyframes/s per slot under any join rate, which at tens of kB each can add 1–2Mbps to a 2.5Mbps stream for everyone watching it while joins churn. a preview join could request on the 1.5s gap instead of the 300ms one: a slower first frame for the hoverer, a third of the tax on the room. the knob is one bool (`request_keyframe(.., force)`, `main.rs:913`).

so: a delay, one preview per tab, teardown on leave, no grant on the hover path. with those four, hovering is not spam. without the delay it is: a sweep across four cards opens and closes four peers in 200ms and asks the publisher for four keyframes.

## 2. a preview after 0.3s of hovering?

yes, and 300ms is about the right number: the lower edge of where a pause is telling apart from a pass-through (a card is crossed in 100–200ms), and short enough that the preview is on by the time a person has decided to look. what it looks like in time:

| t | what |
|---|---|
| 0 | `pointerenter` (or `focus` in the card). a 300ms timer is armed. nothing is sent |
| <300ms, `pointerleave` | the timer is cleared. nothing happened |
| 300ms | the timer fires. a preview up on another card is torn down. socket, offer, answer, ice, dtls, the keyframe request. the thumbnail stays |
| ~1–2s | first frame: `playing` on the preview `<video>`. the thumbnail gives way to it, muted |
| leave | a ~400ms grace, then teardown and the thumbnail is back. re-entering inside the grace cancels it |
| click, any time after 0 | navigate. the page adopts whatever stage the session is at: connecting, or already playing. nothing is torn down and nothing starts over |

so the preview itself shows about 1–2s after the mouse arrives; the delay is 300ms, the rest is the pipeline. what the delay buys is question 1: no cost until a person has stopped. a click under 300ms starts the session on the page as today; starting it on `pointerdown` in that case saves ~100ms and is optional.

things to hold to: one preview at a time. no retry loop on `not live` (the card is gone within 3s anyway). `playing`, not `ontrack`, switches the picture, so no black box replaces the thumbnail. a `play()` refused (ios low power) keeps the thumbnail. the home poll re-renders the grid every 3s; the cards are keyed by name so the preview `<video>` does not remount. and `test/pip.js:77` counts `/watch` calls per name: playwright's `click()` moves then clicks within a few ms, under the delay, so no preview starts in the tests and its counts hold; a longer hover there would want the count checked against the no-grant path.

## 3. a lower bitrate or downscaled preview at 1000 users × 3 cards/s?

split the scenario in two, because the delay changes it.

**the rate.** 1000 people each moving across 3 cards a second never hold a card 300ms, so the timer never fires: zero joins, zero bytes. the hover rate is not a load at all once the start waits for a dwell. if dwells do cross the line (a person wiggling between two cards every third of a second), the churn is joins, not bandwidth: up to 3 socket + dtls handshakes a second per tab, and the keyframe tax on each room, bounded at 3.3/s per slot however many join. a lower bitrate does nothing for any of that. what does: a per-tab cooldown (no new preview within ~1s of the last teardown) and a server-side cap (video refuses a `preview` join over N per room, or when it is busy, with `{"error":"busy"}`; the card keeps its thumbnail). two small changes, and the worst case becomes "N extra watchers per room".

**the concurrency.** 1000 people each holding on a card is ≤1000 preview peers, one per tab, and that is exactly 1000 viewers: 1000 × 2.5Mbps = 2.5Gbps out of the video box, same as if they had all clicked. bitrate is the lever here, an ~8× one (a 320×180 layer at ~300kbps is 300Mbps for the same thousand). but there is no small layer to send. the publisher encodes one vp8 stream per slot and the server copies its packets as they are (`main.rs:564`). getting a small one:

| how | what it costs | the catch |
|---|---|---|
| simulcast from the publisher | +10–20% upload and encoder cpu on the streamer; in video: `rid` parsing, per-layer tracks per slot, a layer per watcher | promoting a preview on click means switching layers inside one peer: rtp sequence and timestamp rewriting and a keyframe on the target layer. webrtc-rs does not do that for you; it is the core of an sfu and the biggest item in the whole feature. without it the click opens a second, full peer, and the performance half of this plan is gone |
| transcode on video (ffmpeg, as the thumbnail already does) | a slice of a core per live stream, all the time, hovered or not (the dummy streams note the same, `dummy.rs:456`); re-packetizing to rtp | the same layer switch on promote |
| faster thumbnails | ffmpeg already decodes the camera for a jpeg every 5s (`thumbs.rs`); at 1–2 fps on hover the card flips pictures. 20–40kB a picture, so 160–640kbps per hoverer, about a small layer's worth. but it is a file: no peer, no dtls, no keyframe tax, one output per live stream whoever is looking, cacheable at caddy per bucket, so 1000 hoverers on one stream are 1000 static hits | it warms nothing. the click still pays the whole pipeline. this is the preview without the performance |

so the two halves of the plan pull apart at scale: the warm connection has to be the full-bitrate real watcher (one offer, no renegotiation, no layer switch), and the cheap preview cannot warm anything.

**is it worth it:** not before the rungs in `bitrates.md` exist. three reasons, for the world where the only picture is the 2.5 Mbps one. the wall at that scale is the one video box's egress and its per-watcher copy loop, which 1000 viewers hit with no previews at all; a smaller preview moves nothing about where that wall is, a second video box does (`kubernetes.md` has the routing problem). the cheap guards (delay, one per tab, cooldown, server cap, no grant) make the worst case a bounded number of extra watchers for a few dozen lines. and simulcast, the only version where a small preview is also the warm connection, is weeks of sfu work that would be built for viewers on bad networks if it is built, with previews riding the low layer as a side effect. if a preview must be cheap before then, the faster thumbnail is the one to build, knowing it is the picture and not the speed.

**once the box makes 360 and 720** (`bitrates.md`): the preview join the 360 rung. the small picture already exist for bad pipes, so a hover is just another 360 watcher, muted, no audio, ~0.3 Mbps. the 360 keyframe is the box's, so a hover does not make every 1080 watcher download a fat keyframe. click keep that peer and the box step the same watcher up to the rung their pipe can hold; the picture sharpen on that rung's next keyframe. the warm connection and the cheap picture are the same peer. the "not worth it" above is about building a small picture only for hover. this one is a small picture that already had a job.

## if it is built

- `watch-atoms.ts`: the attempt becomes a session value; two slots, watched and preview; `promote()`; the takeover in `watch()` reads the preview slot. `endWatch`/`leaveWatchPage` unchanged for the watched slot.
- `HomePage.tsx`: `Card` arms the 300ms timer on `pointerenter`/`focus`, clears it on leave, grace on leave while up; renders `<video>` over the thumbnail once `playing`.
- `relay.ts`: the hover join ask for the 360 rung (`bitrates.md`), muted, no audio. a `preview: true` so video can count and cap them. optional until the rungs exist; without it a preview is a full watcher and that is also fine.
- `video/src/main.rs`: a 360 join get the box's 360 encode and a keyframe from that encode, not a pli to the publisher. cap previews per room. on promote, step that peer up a rung.
- `test/`: a hover held past the delay shows the card playing; the click after it makes no new `/ws` and no `/watch`; a sweep makes nothing; a preview beside a corner player leaves the player alone; leave tears down.
- `spec.md`: the watch page's "the one `/watch` call" wording and the home page row.

## to settle

- 300ms and the ~400ms grace are guesses to feel out on a real grid.
- the preview's keyframe on the slow gap or the fast one: the hoverer's first frame against the room's bandwidth.
- a cap per room, and the number.
- whether the no-grant path is kept for the page's own start too (the page needs the grant only for the fields the card already has).
