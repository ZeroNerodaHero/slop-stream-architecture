# test

browser tests, playwright. do not run the js files by hand unless you know the env.

```
# from the repo root
./scripts/test.sh
./scripts/test.sh https://1.2.3.4
./scripts/test.sh --all
HEADED=1 ./scripts/test.sh
```

needs node and google chrome. a fake camera is used. stream names are fixed, so one person at a time per server.

the default suite is listed in `scripts/test.sh`: e2e, dup, chat, auth, groups, follows, dms, notifications, preview, errors, pip, live-pip, screen, vtuber, presence, calendar, about, socials, prefetch, rt, voice (`VOICE=1` for its voice server part). a local docker stack also runs regress and monitor. `--all` adds redeploy and dummy.

`fixtures/` holds puppet models used by the vtuber tests.

`voice-video.js` and `voice-spike.js` are not in the default suite; `./scripts/test.sh voice-video` runs the first. `voice-spike.js` needs `video voice` running with VOICE_DEV_OPEN=1 (VOICE_URL, default ws://127.0.0.1:7881/ws) and checks two browsers hear each other.

`simulcast.js` is not in the default suite and needs no server: it starts its own `video` (a release build, `VIDEO_BIN`) on loopback with a mock api and checks the camera's simulcast layers, joins, pausing a hidden watcher and pinning a small one (`SKIP_PAUSE=1` leaves that out), layer switches under a squeeze and the dummy. `node test/simulcast.js`; `docs/simulcast.md` has the knobs. `MODE=vp9` publishes vp9 with the vp8 copy and adds vp8-only watchers (`docs/vp9.md`).

`soak.js` needs no server either: it starts `video` (`VIDEO_BIN`) and `video dummy` with `STREAMS` (4) single-layer vp8 dummies, keeps `STEADY` (3) watchers on, and churns more every `CHURN_MS` (2000, at most `MAX_CHURNERS`): previews, quick aborts, hidden/full/small toggles, and a `BLOCKED` share (0.3) whose offer has no ice candidates, so ICE never completes and video ends them as `peer gone`. it samples video's rss every `SAMPLE_MS` for `MINUTES` (20) and prints the slope after warm-up; `OUT` keeps the json, `LOG` video's output.

`codec-quality.sh` encodes clips offline with ffmpeg libvpx vp8 and vp9 at a few bitrates and prints actual kbps, psnr and ssim. `CLIPS` adds y4m files or urls (xiph's derf clips work), `RATES` and `SECONDS_LONG` set the grid.
