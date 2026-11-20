// Voice spike (video/src/voice.rs): two browsers hear each other through `video voice`. A and B
// join spike/lounge, each offering one sendrecv m-line (the fake mic) and 15 recvonly ones; each
// hears the other on the m-line the seats frame names, and getStats shows those packets growing.
// C comes and goes without anyone renegotiating (negotiationneeded and signalingState are
// counted), and A and B keep hearing each other while their seats frames show C come and go.
// Closing B's browser frees B's seat: A's seats frame drops it and the next comer sits there.
// Not in scripts/test.sh. Run a server first, then:
//   VOICE_DEV_OPEN=1 PUBLIC_IP=127.0.0.1 cargo run -p video -- voice
//   node test/voice-spike.js            (VOICE_URL=ws://127.0.0.1:7881/ws by default)
// A server without VOICE_DEV_OPEN turns the join away and this fails with 'voice is not open'.
const { chromium } = require('playwright');
const VOICE_URL = process.env.VOICE_URL || 'ws://127.0.0.1:7881/ws';
const ROOM = 'spike/lounge';
/** where each page starts, for its origin: the voice server's own /health (ws -> http) */
const HEALTH_URL = new URL('/health', VOICE_URL.replace(/^ws/, 'http')).href;
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const T0 = Date.now();
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    results.push('pass');
    console.log(`PASS  ${name.padEnd(64)} ${ms()} ms  ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${name.padEnd(64)} ${ms()} ms\n      ${String(e.message).split('\n').join('\n      ')}`);
    throw e;
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollUntil(fn, until, { timeout, interval = 250, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}

// the page: no server of ours, just this. window.join offers 1 sendrecv + 15 recvonly, sends the
// join frame, applies the answer and keeps every seats frame and every renegotiation sign.
const PAGE = `<!doctype html><title>voice spike</title><body><script>
window.v = { seats: [], frames: [], error: null, answered: false, negotiationneeded: 0, signaling: [] };
window.join = async (url, room, user) => {
  const pc = new RTCPeerConnection();
  window.pc = pc;
  pc.onnegotiationneeded = () => v.negotiationneeded++;
  pc.onsignalingstatechange = () => v.signaling.push(pc.signalingState);
  pc.ontrack = (e) => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = new MediaStream([e.track]);
    document.body.append(audio);
  };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTransceiver(mic.getAudioTracks()[0], { direction: 'sendrecv', streams: [mic] });
  for (let i = 0; i < 15; i++) pc.addTransceiver('audio', { direction: 'recvonly' });
  await pc.setLocalDescription(await pc.createOffer());
  // no trickle: the join frame carries the candidates
  await new Promise((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done();
    setTimeout(done, 3000);
  });
  const ws = new WebSocket(url);
  window.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ role: 'voice', room, user, sdp: pc.localDescription.sdp }));
  ws.onerror = () => (v.error = v.error || 'websocket error');
  ws.onclose = (e) => (v.error = v.error || 'websocket closed (' + e.code + ')');
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.error) v.error = msg.error;
    else if (msg.sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      v.answered = true;
    } else if (msg.event === 'seats') {
      v.seats = msg.seats;
      v.frames.push({ at: Date.now(), seats: msg.seats });
    }
  };
};
// inbound-rtp packetsReceived on m-line n (transceivers are in m-line order: they were added so)
window.packets = async (n) => {
  const t = pc.getTransceivers()[n];
  if (!t) return -1;
  let got = 0;
  (await t.receiver.getStats()).forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') got = Math.max(got, s.packetsReceived || 0);
  });
  return got;
};
window.state = () => ({ connection: pc && pc.connectionState, negotiationneeded: v.negotiationneeded, signaling: v.signaling.slice() });
</script></body>`;

const people = {};
async function open(user) {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const page = await (await browser.newContext()).newPage();
  // about:blank is not a secure context and has no getUserMedia. the server's own /health is
  // (127.0.0.1), and chrome lets it open a socket to its own address; a page faked with
  // page.route would count as public and be blocked. setContent then replaces it
  await page.goto(HEALTH_URL);
  await page.setContent(PAGE);
  await page.evaluate(([url, room, u]) => window.join(url, room, u), [VOICE_URL, ROOM, user]);
  const person = { user, browser, page, frames: [] };
  people[user] = person;
  // answered, or the server's error word
  const v = await pollUntil(() => page.evaluate(() => ({ error: v.error, answered: v.answered })), (v) => v.error || v.answered, {
    timeout: 10000,
    label: `${user} joins ${ROOM}`,
  });
  if (v.error) throw new Error(`${user}: ${v.error}`);
  return person;
}
const seatsOf = (p) => p.page.evaluate(() => v.seats);
/** the m-line `p`'s seats frame gives `other`, waiting for it to appear */
const lineFor = async (p, other, timeout = 5000) =>
  (await pollUntil(() => seatsOf(p), (s) => s.some((x) => x.user === other), { timeout, label: `${p.user} sees ${other} in the seats frame` })).find(
    (x) => x.user === other,
  ).line;
const packets = (p, line) => p.page.evaluate((n) => window.packets(n), line);
/** packets on `line` above 0 within `timeout`, then growing over the next second */
async function hears(p, other, timeout = 5000) {
  const line = await lineFor(p, other, timeout);
  const first = await pollUntil(() => packets(p, line), (n) => n > 0, { timeout, label: `${p.user} gets packets from ${other} on m-line ${line}` });
  await sleep(1000);
  const then = await packets(p, line);
  expect(then > first, `${p.user}: packets from ${other} on m-line ${line} stopped at ${first} (then ${then})`);
  return `${p.user} hears ${other} on m-line ${line}: ${first} -> ${then} packets`;
}
const stateOf = (p) => p.page.evaluate(() => window.state());

function timeline() {
  console.log('\nseat timeline (ms since start: seats each one was told about)');
  const rows = [];
  for (const p of Object.values(people)) {
    for (const f of p.frames) rows.push({ at: f.at, who: p.user, seats: f.seats });
  }
  rows.sort((a, b) => a.at - b.at);
  for (const r of rows) {
    const seats = r.seats.map((s) => `${s.user}@${s.seat}/line${s.line}`).join(' ') || '(alone)';
    console.log(`  ${String(r.at - T0).padStart(6)}  ${r.who.padEnd(2)} ${seats}`);
  }
}
async function grabFrames(p) {
  try {
    p.frames = await p.page.evaluate(() => v.frames);
  } catch {
    // a closed browser keeps what was grabbed last
  }
}

(async () => {
  let failed = false;
  try {
    let A, B, C;
    await step('A and B join spike/lounge (1 sendrecv + 15 recvonly)', async () => {
      A = await open('A');
      B = await open('B');
      return `A ${JSON.stringify(await seatsOf(A))}`;
    });
    await step('A hears B within 5s, packets growing', () => hears(A, 'B'));
    await step('B hears A within 5s, packets growing', () => hears(B, 'A'));

    const before = { A: await stateOf(A), B: await stateOf(B) };
    await step('C joins: A and B see C, and C hears A', async () => {
      C = await open('C');
      const a = await lineFor(A, 'C');
      const b = await lineFor(B, 'C');
      return `C on A's m-line ${a}, B's m-line ${b}; ${await hears(C, 'A')}`;
    });
    await step('A and B still hear each other with C in', async () => `${await hears(A, 'B', 2000)}; ${await hears(B, 'A', 2000)}`);
    await step('C leaves: A and B see C go', async () => {
      await grabFrames(C);
      await C.browser.close();
      for (const p of [A, B]) {
        await pollUntil(() => seatsOf(p), (s) => !s.some((x) => x.user === 'C'), { timeout: 20000, label: `${p.user} sees C leave` });
      }
      return `A ${JSON.stringify(await seatsOf(A))}`;
    });
    await step('A and B still hear each other after C left', async () => `${await hears(A, 'B', 2000)}; ${await hears(B, 'A', 2000)}`);
    await step('nobody renegotiated while C came and went', async () => {
      const out = [];
      for (const p of [A, B]) {
        const now = await stateOf(p);
        const was = before[p.user];
        expect(now.connection === 'connected', `${p.user}: connection is ${now.connection}`);
        expect(now.negotiationneeded === was.negotiationneeded, `${p.user}: negotiationneeded ${was.negotiationneeded} -> ${now.negotiationneeded}`);
        expect(now.signaling.length === was.signaling.length, `${p.user}: signaling ${was.signaling.join(',')} -> ${now.signaling.join(',')}`);
        out.push(`${p.user}: negotiationneeded ${now.negotiationneeded}, signaling ${now.signaling.join('>')}`);
      }
      return out.join('; ');
    });
    await step("closing B frees B's seat for A within 20s", async () => {
      const seatB = (await seatsOf(A)).find((x) => x.user === 'B').seat;
      await grabFrames(B);
      await B.browser.close();
      await pollUntil(() => seatsOf(A), (s) => !s.some((x) => x.user === 'B'), { timeout: 20000, label: 'A sees B leave' });
      // the freed seat is the lowest free one, so the next comer takes it
      const D = await open('D');
      await lineFor(A, 'D');
      const seat = (await seatsOf(A)).find((x) => x.user === 'D').seat;
      expect(seat === seatB, `D sat in seat ${seat}, not B's seat ${seatB}`);
      await grabFrames(D);
      await D.browser.close();
      return `B's seat ${seatB} went to D`;
    });
    await grabFrames(A);
  } catch (e) {
    failed = true;
    if (!results.includes('fail')) console.log(`FAIL  ${e.message}`);
  }
  for (const p of Object.values(people)) {
    await grabFrames(p);
    await p.browser.close().catch(() => {});
  }
  timeline();
  const n = (k) => results.filter((r) => r === k).length;
  console.log(`\n${n('pass')} passed, ${n('fail')} failed`);
  process.exit(failed || n('fail') ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
