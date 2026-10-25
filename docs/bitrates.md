# big picture, small picture

a plan, not a build. `spec.md` still says one quality. this is the later version, in small words.

## today

streamer browser make **one** picture. vp8. camera cap is 2.5 Mbps (`VIDEO_MAX_BITRATE` in `publish-atoms.ts`). screen cap is 1080p and the screens share 3 Mbps.

box no look at picture. box copy packets. every watcher get same bytes.

streamer own wifi bad: browser get told (twcc, `media.rs`) and the **one** picture get smaller. then **everyone** see the small one.

watcher wifi bad: watcher get holes. picture freeze, go blocky. watcher never get a smaller picture. `spec.md` say this out loud.

two different "cannot do 1080":

| problem | what hurt | what fix |
|---|---|---|
| pipe small | not enough bits per second | send fewer bits |
| brain small (phone, old laptop) | decoding a big frame is hard even when the bits are few | send fewer **pixels** |

a blurry 1080p at 400 kbps still a 1080p decode. weak phone still choke. small version must be a real small picture (360, 480, 720), not the big one squeezed.

## the ladder

one stream, many sizes. watcher get the biggest size their pipe and their brain can hold.

rough live bits, 30 fps, talking head. games and fast video want more. screen text want pixels more than frames.

| name | pixels | bits, about | who |
|---|---|---|---|
| tiny | 640×360 | 0.3 Mbps | bad phone, hover card |
| ok | 1280×720 | 1.2 Mbps | normal phone |
| good | 1920×1080 | 2.5–4.5 Mbps | laptop. today sit at 2.5 |
| 2k | 2560×1440 | 6–10 Mbps | strong pipe. people say "2k" and mean this. real cinema 2k is 2048×1080, ignore |
| 4k | 3840×2160 | 12–20 Mbps with a new codec, 20–35 with vp8 | few people, on purpose |

60 fps about 1.5× the bits. default stay 30.

## the pick

streamer send **one** format. same as today.

- one codec: vp8
- one size: 1080p30
- one bit cap: 2.5 Mbps
- one audio: opus, copied as-is, no small version

no second resolution out of the browser. no second codec. a phone streamer upload the same single picture a laptop does.

the **box** make the small pictures. it decode that one vp8 and encode real smaller ones (360, 720) with ffmpeg, same idea as the jpeg in `thumbs.rs`. those copies are still vp8, so every watcher browser already know how to play them. "format" stay vp8. what change is pixels and bits.

the 1080 itself is not made again. watchers who can hold it get the original packets, copied. only the smaller rungs are new encodes. re-encoding the 1080 would burn a core and make the picture worse.

```
streamer  --one vp8 1080p-->  ingest box
                                 |-- copy 1080p  --> strong watcher
                                 |-- make 720p   --> normal phone
                                 +-- make 360p   --> bad pipe, and the home card
                              fanout boxes copy whichever rung, they no decode
```

the home card use the 360. hold still on a card (`hover-preview.md`) and that tab join the 360 rung, muted, no audio. the card is small, 360 fill it, and the copy is ~0.3 Mbps instead of 2.5. a thousand people resting on cards is ~300 Mbps out of the box, not 2.5 Gbps.

that 360 already exist for the life of the stream, hover or not. the hover no ask the streamer for a keyframe. the box make the 360 keyframe itself and only the 360 watchers download it. the people on 1080 no pay for someone waving a mouse.

click keep that same connection, so the watch page already has a moving picture. then the box move that one watcher up to their real rung (1080 if the pipe can take it). the picture go sharp on the next keyframe of that rung. one peer. no second full stream beside it.

cost: a slice of a core **per live stream, all the time**, someone watching or not. `dummy.rs` already warn about this. do it **once**, on the machine that takes the upload. fanout machines only copy. `spec.md` already say: no transcode on the fanout path.

each watcher is on one rung. the box ask the watcher how full their pipe is (today twcc only talk to the streamer, so watchers need it too) or the player has a button (`auto / 360 / 720 / 1080`). on a switch, wait for a keyframe of the new size, then send. a delta frame of the wrong size is garbage. change slow: hopping every second look worse than sitting one rung too low.

the other way (browser encode 360 and 720 and 1080 itself, three uploads) stay unused. it save the box's core and cost the streamer's cpu and uplink. this plan leave that work on the box.

## 2k and 4k without melting the forest

4k on today's path is a trap. one 20 Mbps picture, copied, fill a 1 Gbps card at about **50 watchers**. today 2.5 Mbps fill it around 300. and vp8 at 4k is software on most laptops. fans scream, frames drop, and the bits are fat because vp8 is an old codec.

rules:

1. **4k is a top rung, never the only picture.** phone stay on 360 or 720. laptop stay on 1080. one strong watcher get 4k. egress stay sane because almost nobody is on the fat rung.
2. **pixels and bits move together.** 4k crammed into 2.5 Mbps look worse than a clean 1080. the screen share already refuse retina-bigger-than-1080 for this reason (`publish-atoms.ts`). raise the pixel cap only when you raise the bit cap.
3. **leave vp8 for the rungs everyone must decode.** it is why `media.rs` is opus + vp8 only: every browser eat the same bytes. vp8 is a bad 4k codec. the fat rung want h264 (hardware encode and decode almost everywhere) or av1 (fewer bits, encode still heavy unless the machine has an av1 chip). old watcher who cannot eat that codec stay on the vp8 1080 rung and still see a picture.
4. **capture only as big as the top rung you will actually send.** a 4k camera downscaled inside the encoder still cost the capture. `getUserMedia` / `getDisplayMedia` get `width`, `height`, `frameRate` caps. 30 fps. camera hint stay `motion`. screen hint stay `detail` (sharp text). screen that need sharp letters want `maintain-resolution`; a face want `maintain-framerate`.
5. **1080 stay the only upload, even later.** a 1440 or 2160 rung is still the box making it from that one upload, or a later "strong computer" upload that replaces the 1080 as the single source. the browser still send one picture. default stay 1080.
6. **keyframes get huge.** a new watcher pull one. at 4k that tax hurt. same trick as now: share one keyframe ask across joins that land together, and no ask-storm.
7. **a crowd plus 4k leave this shape.** packet copy is for a room. a crowd want the other picture in `architecture.md`: transcode once, short files, a cdn. that one is also still a non-goal.

## first build, when you build it

- publisher stay one encode. capture stay 1080p30, vp8, 2.5 Mbps. nothing new in the browser except the player button.
- video, on the ingest machine: decode the one vp8, encode 720 and 360, pass the original 1080 through. one ffmpeg per live stream.
- forward one rung per watcher. keyframe on switch. twcc or a quality message from the watcher.
- player: `auto`, and a hand pick so a person can force small when auto guess wrong.
- home card: the hover join ask for the 360 rung, muted, no audio (`hover-preview.md`). click stay on that peer and the box step it up.
- 1440 and 2160 stay off. the source is 1080, so a bigger rung would be invented pixels.
- `spec.md` "one quality" line change in the same change. until then this file is only the map.
