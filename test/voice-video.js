// Video in voice (video/src/voice.rs, docs/voice.md): three headless chromes with fake devices
// (a beeping mic, the moving test picture) in one voice room of a `video voice` started with
// VOICE_DEV_OPEN=1. Each joins with the page's offer (1 sendrecv mic + 15 recvonly audio), then:
// A and B turn their cameras on (a new sendonly VP8 m-line, offered again with its mid named
// `camera`), and every one of A, B and C gets the others' audio and video with frames decoding,
// each picture on the mid its seats frame names; A shares its screen mid-call (a second sendonly
// line named `screen`) and B and C decode it next to A's camera, at the screen's size; A's camera
// goes off (its line inactive) and the others' seats frames drop it while the screen keeps
// going; B's mute and deafen show in A's seats frame; C leaves and the rest go on. How long a
// new viewer waits for its first picture (the PLI on subscribe) is printed and kept under 3s.
// Not in scripts/test.sh: it needs its own voice server. Run one first, then this:
//   VOICE_DEV_OPEN=1 PUBLIC_IP=127.0.0.1 VOICE_WS_PORT=17881 VOICE_UDP_PORT=17883 cargo run -p video -- voice
//   VOICE_URL=ws://127.0.0.1:17881/ws node test/voice-video.js
const { chromium } = require('playwright');
const VOICE_URL = process.env.VOICE_URL || 'ws://127.0.0.1:7881/ws';
const ROOM = 'vvideo/lounge';
const HEALTH_URL = new URL('/health', VOICE_URL.replace(/^ws/, 'http')).href;
const ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // getDisplayMedia with no picker: this tab is the screen
  '--auto-accept-this-tab-capture',
  '--auto-select-desktop-capture-source=Entire screen',
];
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    results.push('pass');
    console.log(`PASS  ${name.padEnd(72)} ${ms()} ms  ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${name.padEnd(72)} ${ms()} ms\n      ${String(e.message).split('\n').join('\n      ')}`);
    throw e;
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, until, { timeout, interval = 200, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}

// the page: the same protocol as frontend/src/infra/atoms/voice-video.ts, written out. the page
// is always the offerer: one offer in flight at a time, each frame naming its sending video
// mids; recvonly video lines are added when a seats frame lists more pictures than there are.
const PAGE = `<!doctype html><title>voice video</title><body><script>
window.v = { seats: [], error: null, answered: 0, offers: 0, firstFrame: {} };
const VP8 = () => (RTCRtpReceiver.getCapabilities('video')?.codecs ?? []).filter((c) => /vp8/i.test(c.mimeType));
const vp8Only = (t) => { const c = VP8(); if (c.length && t.setCodecPreferences) t.setCodecPreferences(c); };
let pc, ws, answerWaiter = null, chain = Promise.resolve();
const mine = { camera: null, screen: null };
const recvVideo = [];
function send(frame) { ws.send(JSON.stringify(frame)); }
function labels() {
  const out = {};
  for (const kind of ['camera', 'screen']) {
    const t = mine[kind];
    if (t && t.mid && t.direction === 'sendonly') out[t.mid] = kind;
  }
  return out;
}
// one offer and its answer, after the one before
function offer() {
  chain = chain.then(async () => {
    await pc.setLocalDescription(await pc.createOffer());
    const answered = new Promise((done) => (answerWaiter = done));
    v.offers++;
    send({ sdp: pc.localDescription.sdp, video: labels() });
    await pc.setRemoteDescription({ type: 'answer', sdp: await answered });
  }).catch((e) => (v.error = v.error || 'renegotiate: ' + e.message));
  return chain;
}
function grow() {
  const wanted = v.seats.reduce((n, s) => n + s.video.length, 0);
  if (wanted <= recvVideo.length) return;
  while (recvVideo.length < wanted) {
    const t = pc.addTransceiver('video', { direction: 'recvonly' });
    vp8Only(t);
    recvVideo.push(t);
  }
  void offer();
}
window.join = async (url, room, user) => {
  pc = new RTCPeerConnection();
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTransceiver(mic.getAudioTracks()[0], { direction: 'sendrecv', streams: [mic] });
  for (let i = 0; i < 15; i++) {
    const t = pc.addTransceiver('audio', { direction: 'recvonly' });
    const audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = new MediaStream([t.receiver.track]);
  }
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done();
    setTimeout(done, 3000);
  });
  ws = new WebSocket(url);
  ws.onopen = () => send({ role: 'voice', room, user, sdp: pc.localDescription.sdp });
  ws.onerror = () => (v.error = v.error || 'websocket error');
  ws.onclose = (e) => (v.error = v.error || 'websocket closed (' + e.code + ')');
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.error) v.error = msg.error;
    else if (msg.sdp) {
      if (answerWaiter) { const w = answerWaiter; answerWaiter = null; w(msg.sdp); }
      else { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); }
      v.answered++;
    } else if (msg.event === 'seats') {
      const at = performance.now();
      for (const s of msg.seats) for (const p of s.video) {
        const key = s.user + ':' + p.kind;
        if (!v.firstFrame[key]) v.firstFrame[key] = { listed: at, decoded: null };
      }
      v.seats = msg.seats;
      grow();
    }
  };
};
// a camera or the screen on: a new sendonly line the first time, the old one again after
window.show = async (kind) => {
  const stream = kind === 'camera'
    ? await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 24 } } })
    : await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } }, preferCurrentTab: true });
  const track = stream.getVideoTracks()[0];
  const enc = kind === 'camera' ? { maxBitrate: 600000, maxFramerate: 24 } : { maxBitrate: 1500000, maxFramerate: 15 };
  let t = mine[kind];
  if (!t) {
    t = pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: [enc] });
    vp8Only(t);
    mine[kind] = t;
  } else {
    await t.sender.replaceTrack(track);
    t.direction = 'sendonly';
  }
  await offer();
  const s = track.getSettings();
  return { mid: t.mid, width: s.width, height: s.height, fps: s.frameRate, maxBitrate: t.sender.getParameters().encodings[0]?.maxBitrate };
};
window.hide = async (kind) => {
  const t = mine[kind];
  if (!t) return;
  t.sender.track?.stop();
  await t.sender.replaceTrack(null);
  t.direction = 'inactive';
  await offer();
};
window.say = (mute, deaf) => send({ state: { mute, deaf } });
// what this page gets from \`user\`: audio packets on its line, and per picture the mid, frames decoded and size
window.from = async (user) => {
  const seat = v.seats.find((s) => s.user === user);
  if (!seat) return null;
  const stat = async (t, kind) => {
    let out = null;
    (await t.receiver.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === kind) out = s;
    });
    return out;
  };
  const audio = await stat(pc.getTransceivers()[seat.line], 'audio');
  const video = {};
  for (const p of seat.video) {
    const t = p.mid && pc.getTransceivers().find((x) => x.mid === p.mid);
    const s = t ? await stat(t, 'video') : null;
    const decoded = s?.framesDecoded ?? 0;
    video[p.kind] = { mid: p.mid, decoded, width: s?.frameWidth ?? 0, height: s?.frameHeight ?? 0 };
  }
  return { packets: audio?.packetsReceived ?? 0, mute: seat.mute, deaf: seat.deaf, video };
};
// the first decoded frame of each picture listed, timed in the page every 50ms
setInterval(async () => {
  if (!pc) return;
  for (const s of v.seats) for (const p of s.video) {
    const t0 = v.firstFrame[s.user + ':' + p.kind];
    const t = p.mid && t0 && t0.decoded === null && pc.getTransceivers().find((x) => x.mid === p.mid);
    if (!t) continue;
    (await t.receiver.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesDecoded > 0 && t0.decoded === null) t0.decoded = performance.now();
    });
  }
}, 50);
window.state = () => ({ connection: pc.connectionState, signaling: pc.signalingState, offers: v.offers, answered: v.answered, error: v.error, mids: pc.getTransceivers().map((t) => t.mid + ':' + t.receiver.track.kind + ':' + t.currentDirection) });
</script></body>`;

const people = {};
async function open(user) {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.log(`      ${user} page error: ${e.message}`));
  await page.goto(HEALTH_URL);
  await page.setContent(PAGE);
  await page.evaluate(([url, room, u]) => window.join(url, room, u), [VOICE_URL, ROOM, user]);
  const p = { user, browser, page };
  people[user] = p;
  const s = await pollUntil(() => page.evaluate(() => ({ error: v.error, answered: v.answered })), (s) => s.error || s.answered, { timeout: 10000, label: `${user} joins` });
  if (s.error) throw new Error(`${user}: ${s.error}`);
  return p;
}
const from = (p, other) => p.page.evaluate((u) => window.from(u), other);
const errorOf = async (p) => (await p.page.evaluate(() => window.state())).error;

/** `p` gets `other`'s audio and every picture in `kinds`, frames decoding and growing over a second */
async function sees(p, other, kinds, timeout = 8000) {
  const ok = (f) => f && f.packets > 0 && kinds.every((k) => f.video[k] && f.video[k].mid && f.video[k].decoded > 0);
  const first = await pollUntil(() => from(p, other), ok, { timeout, label: `${p.user} gets ${other}'s audio and ${kinds.join('+') || 'no video'}` });
  await sleep(1000);
  const then = await from(p, other);
  expect(then.packets > first.packets, `${p.user}: ${other}'s audio stopped at ${first.packets} packets`);
  for (const k of kinds) expect(then.video[k].decoded > first.video[k].decoded, `${p.user}: ${other}'s ${k} stopped at ${first.video[k].decoded} frames`);
  const err = await errorOf(p);
  expect(!err, `${p.user}: ${err}`);
  const pics = kinds.map((k) => `${k} mid ${then.video[k].mid} ${then.video[k].width}x${then.video[k].height} ${first.video[k].decoded}->${then.video[k].decoded}f`).join(', ');
  return `${p.user}<-${other}: audio ${first.packets}->${then.packets}p${pics ? ', ' + pics : ''}`;
}

(async () => {
  let failed = false;
  try {
    let A, B, C;
    await step('A, B and C join (audio only)', async () => {
      A = await open('A');
      B = await open('B');
      C = await open('C');
      return `seats from A: ${(await A.page.evaluate(() => v.seats)).map((s) => s.user).join(',')}`;
    });
    await step('everyone hears everyone, no video yet', async () => {
      const out = [];
      for (const [p, q] of [[A, 'B'], [A, 'C'], [B, 'A'], [C, 'B']]) out.push(await sees(p, q, []));
      return out.join('; ');
    });
    await step('A and B turn their cameras on (renegotiated, 640x360 cap)', async () => {
      const a = await A.page.evaluate(() => window.show('camera'));
      const b = await B.page.evaluate(() => window.show('camera'));
      expect(a.width <= 640 && a.height <= 360, `A's camera is ${a.width}x${a.height}`);
      expect(a.maxBitrate === 600000, `A's camera maxBitrate ${a.maxBitrate}`);
      return `A camera mid ${a.mid} ${a.width}x${a.height}@${a.fps}, B camera mid ${b.mid}`;
    });
    await step('each peer gets the others\' audio and cameras, frames decoding', async () => {
      const out = [];
      out.push(await sees(A, 'B', ['camera']));
      out.push(await sees(B, 'A', ['camera']));
      out.push(await sees(C, 'A', ['camera']));
      out.push(await sees(C, 'B', ['camera']));
      out.push(await sees(A, 'C', []));
      return out.join('; ');
    });
    await step('A shares its screen mid-call: B and C decode it beside the camera', async () => {
      const s = await A.page.evaluate(() => window.show('screen'));
      expect(s.maxBitrate === 1500000, `A's screen maxBitrate ${s.maxBitrate}`);
      const b = await sees(B, 'A', ['camera', 'screen']);
      const c = await sees(C, 'A', ['camera', 'screen']);
      const f = await from(B, 'A');
      expect(f.video.camera.mid !== f.video.screen.mid, 'camera and screen came on the same mid');
      expect(f.video.screen.width <= 1920 && f.video.screen.height <= 1080, `screen is ${f.video.screen.width}x${f.video.screen.height}`);
      return `A screen mid ${s.mid} ${s.width}x${s.height}@${s.fps}; ${b}; ${c}`;
    });
    await step('a new viewer gets each picture within 3s of it being listed (PLI)', async () => {
      const times = [];
      for (const p of [A, B, C]) {
        const ff = await p.page.evaluate(() => v.firstFrame);
        for (const [key, t] of Object.entries(ff)) {
          if (t.decoded === null) continue;
          const ms = Math.round(t.decoded - t.listed);
          times.push(`${p.user}<-${key} ${ms}ms`);
          expect(ms < 3000, `${p.user} waited ${ms}ms for ${key}`);
        }
      }
      expect(times.length >= 6, `only ${times.length} first frames timed`);
      return times.join(', ');
    });
    await step("A's camera off: B and C drop it, A's screen goes on", async () => {
      await A.page.evaluate(() => window.hide('camera'));
      for (const p of [B, C]) await pollUntil(() => from(p, 'A'), (f) => f && !f.video.camera && f.video.screen, { timeout: 5000, label: `${p.user} sees A's camera go` });
      return `${await sees(B, 'A', ['screen'])}; ${await sees(C, 'A', ['screen'])}`;
    });
    await step("A's camera on again on its old line", async () => {
      const a = await A.page.evaluate(() => window.show('camera'));
      return `mid ${a.mid}; ${await sees(B, 'A', ['camera', 'screen'])}`;
    });
    await step("B's mute and deafen show in A's seats frame", async () => {
      await B.page.evaluate(() => window.say(true, true));
      await pollUntil(() => from(A, 'B'), (f) => f && f.mute && f.deaf, { timeout: 3000, label: 'A sees B muted and deafened' });
      await B.page.evaluate(() => window.say(false, false));
      await pollUntil(() => from(A, 'B'), (f) => f && !f.mute && !f.deaf, { timeout: 3000, label: 'A sees B back' });
      return 'mute+deaf, then neither';
    });
    await step('C leaves: A and B go on with each other', async () => {
      await C.browser.close();
      delete people.C;
      for (const p of [A, B]) await pollUntil(() => p.page.evaluate(() => v.seats.map((s) => s.user)), (u) => !u.includes('C'), { timeout: 20000, label: `${p.user} sees C go` });
      return `${await sees(A, 'B', ['camera'])}; ${await sees(B, 'A', ['camera', 'screen'])}`;
    });
    await step('nothing failed on the way', async () => {
      const out = [];
      for (const p of [A, B]) {
        const s = await p.page.evaluate(() => window.state());
        expect(s.connection === 'connected' && s.signaling === 'stable' && !s.error, `${p.user}: ${JSON.stringify(s)}`);
        out.push(`${p.user}: ${s.offers} offers, ${s.answered} answers`);
      }
      return out.join('; ');
    });
  } catch (e) {
    failed = true;
    if (!results.includes('fail')) console.log(`FAIL  ${e.message}`);
  }
  for (const p of Object.values(people)) await p.browser.close().catch(() => {});
  const n = (k) => results.filter((r) => r === k).length;
  console.log(`\n${n('pass')} passed, ${n('fail')} failed`);
  process.exit(failed || n('fail') ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
