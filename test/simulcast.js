const { chromium } = require('playwright');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_BIN = process.env.VIDEO_BIN || path.join(ROOT, 'target/release/video');
const CHROME = process.env.CHROME || undefined;
const MODE = process.env.MODE || 'simulcast';
const JOINS = Number(process.env.JOINS || 10);
const WS_PORT = Number(process.env.WS_PORT || 17880);
const UDP_PORT = Number(process.env.UDP_PORT || 17882);
const HTTP_PORT = Number(process.env.HTTP_PORT || 17900);
const CLIP = process.env.CLIP || path.join(os.tmpdir(), 'stream-simulcast-1080.y4m');
const DOWNLINK_KBPS = Number(process.env.DOWNLINK_KBPS || 800);
const RELAY_PORT = Number(process.env.RELAY_PORT || 17890);
const SQUEEZE_MS = Number(process.env.SQUEEZE_MS || 10000);
const WS_URL = `ws://127.0.0.1:${WS_PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

const results = { mode: MODE, video: VIDEO_BIN, checks: [] };
let failed = false;
function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed = true;
}

const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { sendEncodings, applyLayers } from '/simulcast.js';
const signal = (url, setup) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => ws.send(JSON.stringify(setup));
  ws.onerror = () => reject(new Error('socket error'));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.error) reject(new Error(msg.error));
    else if (msg.sdp) resolve({ ws, sdp: msg.sdp });
  };
});
const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r()); setTimeout(r, 1000); });
window.publish = async (name, url, mode) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true });
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'motion';
  const height = track.getSettings().height;
  const pc = new RTCPeerConnection();
  const encodings = mode === 'single' ? [{ maxBitrate: 2500000, scaleResolutionDownBy: height / 720 }] : sendEncodings(height);
  const sender = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: encodings }).sender;
  pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendonly', streams: [stream] });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const { ws, sdp } = await signal(url, { role: 'publish', name, sdp: pc.localDescription.sdp, session: 1, token: 1 });
  await pc.setRemoteDescription({ type: 'answer', sdp });
  if (mode !== 'single') {
    const params = sender.getParameters();
    applyLayers(params.encodings, height);
    await sender.setParameters(params);
  }
  window.__pub = { pc, ws, sender };
  return { height, offeredRids: (pc.localDescription.sdp.match(/a=rid:\\S+ send/g) || []).length };
};
window.publishStats = async () => {
  const out = [];
  for (const s of (await window.__pub.pc.getStats()).values()) if (s.type === 'outbound-rtp' && s.kind === 'video') out.push({ rid: s.rid, h: s.frameHeight, bytes: s.bytesSent, active: s.active, reason: s.qualityLimitationReason, pli: s.pliCount, kf: s.keyFramesEncoded, fps: s.framesPerSecond });
  return out.sort((a, b) => (a.rid || '').localeCompare(b.rid || ''));
};
window.views = [];
window.watch = async (name, url, preview = false, relay = 0) => {
  const view = { t0: performance.now(), firstFrame: null, firstHeight: null, samples: [], closed: false };
  const pc = new RTCPeerConnection();
  view.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  document.body.append(video);
  view.video = video;
  pc.ontrack = (e) => {
    if (e.track.kind !== 'video') return;
    video.srcObject = new MediaStream([e.track]);
    const onFrame = (_, meta) => {
      if (view.firstFrame === null) { view.firstFrame = performance.now() - view.t0; view.afterAnswer = performance.now() - view.answered; view.firstHeight = meta.height; }
    };
    video.requestVideoFrameCallback(onFrame);
  };
  await pc.setLocalDescription(await pc.createOffer());
  const { ws, sdp } = await signal(url, preview ? { role: 'watch', name, sdp: pc.localDescription.sdp, preview: true } : { role: 'watch', name, sdp: pc.localDescription.sdp });
  view.ws = ws;
  view.answered = performance.now();
  await pc.setRemoteDescription({ type: 'answer', sdp: relay ? sdp.replace(/ (\\d+) typ host/g, ' ' + relay + ' typ host') : sdp });
  const sample = async () => {
    if (view.closed) return;
    for (const s of (await pc.getStats()).values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'video') view.samples.push({ t: Math.round(performance.now() - view.t0), h: s.frameHeight || 0, frames: s.framesDecoded || 0, bytes: s.bytesReceived || 0, freeze: s.totalFreezesDuration || 0, lost: s.packetsLost || 0, kf: s.keyFramesDecoded || 0, pli: s.pliCount || 0 });
    }
    setTimeout(sample, 100);
  };
  sample();
  window.views.push(view);
  return window.views.length - 1;
};
window.view = (i) => { const v = window.views[i]; return { firstFrame: v.firstFrame, afterAnswer: v.afterAnswer, firstHeight: v.firstHeight, samples: v.samples }; };
window.unwatch = (i) => { const v = window.views[i]; v.closed = true; v.ws.close(); v.pc.close(); v.video.remove(); };
</script>`;

function serve() {
  const module = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, 'frontend/src/infra/simulcast.ts'), 'utf8'));
  return http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
      if (url.pathname === '/simulcast.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(module);
      if (req.method === 'POST' && /^\/api\/streams\/[^/]+\/go-live$/.test(url.pathname)) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session: 1, token: 1 }));
      if (req.method === 'POST' && url.pathname.startsWith('/api/streams/')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(404).end();
    })
    .listen(HTTP_PORT, '127.0.0.1');
}

function start(args, env, tag) {
  const child = spawn(VIDEO_BIN, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const take = (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(`${Date.now()} ${line}`);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('exit', (code) => lines.push(`${Date.now()} [${tag} exited ${code}]`));
  return { child, lines };
}

async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

function relay(port, target) {
  const outer = dgram.createSocket('udp4');
  const inner = dgram.createSocket('udp4');
  const state = { kbps: 0, queue: [], queued: 0, budget: 0, dropped: 0, peer: null };
  outer.on('message', (msg, from) => {
    state.peer = from;
    inner.send(msg, target, '127.0.0.1');
  });
  inner.on('message', (msg) => {
    if (!state.peer) return;
    if (!state.kbps) return outer.send(msg, state.peer.port, state.peer.address);
    if (state.queued + msg.length > (state.kbps * 1000 * 0.15) / 8) return void state.dropped++;
    state.queue.push(msg);
    state.queued += msg.length;
  });
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    state.budget = Math.min(state.budget + ((state.kbps * 1000) / 8) * ((now - last) / 1000), 4000);
    last = now;
    while (state.queue.length && state.budget >= state.queue[0].length) {
      const msg = state.queue.shift();
      state.queued -= msg.length;
      state.budget -= msg.length;
      outer.send(msg, state.peer.port, state.peer.address);
    }
  }, 2);
  outer.bind(port, '127.0.0.1');
  inner.bind(0, '127.0.0.1');
  return {
    limit(kbps) {
      state.kbps = kbps;
      if (!kbps) {
        for (const msg of state.queue) outer.send(msg, state.peer.port, state.peer.address);
        state.queue = [];
        state.queued = 0;
      }
    },
    dropped: () => state.dropped,
    close() {
      clearInterval(timer);
      outer.close();
      inner.close();
    }
  };
}

function heightsOf(samples) {
  const changes = [];
  for (const s of samples) if (s.h && (!changes.length || changes[changes.length - 1].h !== s.h)) changes.push({ t: s.t, h: s.h });
  return changes;
}

async function browser(extra = []) {
  return chromium.launch({
    executablePath: CHROME,
    channel: CHROME ? undefined : 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...extra]
  });
}

async function joinTimes(page, name, preview = false) {
  const times = [];
  const afterAnswer = [];
  const heights = [];
  for (let i = 0; i < JOINS; i++) {
    const id = await page.evaluate(([n, u, p]) => window.watch(n, u, p), [name, WS_URL, preview]);
    const v = await waitFor(() => page.evaluate((i) => window.view(i).firstFrame !== null && window.view(i), id), 8000, 20);
    await page.evaluate((i) => window.unwatch(i), id);
    if (v) {
      if (process.env.JOIN_TRACE) console.log('join', JSON.stringify({ first: Math.round(v.firstFrame), samples: v.samples.map((s) => [s.t, s.bytes, s.frames, s.pli]) }));
      times.push(Math.round(v.firstFrame));
      afterAnswer.push(Math.round(v.afterAnswer));
      heights.push(v.firstHeight);
    }
    await sleep(700);
  }
  return { times, afterAnswer, heights };
}

(async () => {
  if (!fs.existsSync(CLIP)) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30,noise=alls=10:allf=t+u', '-t', '2', '-pix_fmt', 'yuv420p', CLIP]);
  const server = serve();
  const sfu = start([], { RUST_LOG: process.env.SFU_LOG || 'warn,video=info', PUBLIC_IP: '127.0.0.1', WS_PORT: String(WS_PORT), UDP_PORT: String(UDP_PORT), API_URL: `http://127.0.0.1:${HTTP_PORT}`, DUMMY_PASSWORD: 'local-only' }, 'video');
  const procs = [sfu.child];
  const cleanup = async () => {
    for (const p of procs) p.kill('SIGTERM');
    await sleep(1500);
    for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL');
    server.close();
  };
  try {
    const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${WS_PORT}/health`).catch(() => null))?.ok, 10000);
    await sleep(300);
    check('video is up', !!up && sfu.child.exitCode === null, sfu.lines.slice(-3));
    if (sfu.child.exitCode !== null) throw new Error('video exited');

    const pubBrowser = await browser([`--use-file-for-fake-video-capture=${CLIP}`]);
    const pub = await (await pubBrowser.newContext()).newPage();
    await pub.goto(`http://localhost:${HTTP_PORT}/`);
    const published = await pub.evaluate(([u, m]) => window.publish('cam', u, m), [WS_URL, MODE]);
    check('publisher is live', published.height > 0, published);
    const ramp = { firstBytesMs: {}, kbps: [] };
    const t0 = Date.now();
    let prev = null;
    let layers = [];
    await waitFor(async () => {
      layers = await pub.evaluate(() => window.publishStats());
      const at = Date.now() - t0;
      const total = layers.reduce((a, l) => a + (l.bytes || 0), 0);
      if (prev) ramp.kbps.push({ t: at, kbps: Math.round(((total - prev.total) * 8) / (at - prev.at)) });
      prev = { total, at };
      for (const l of layers) if (l.bytes > 0 && ramp.firstBytesMs[l.rid || 'single'] === undefined) ramp.firstBytesMs[l.rid || 'single'] = at;
      const wanted = MODE === 'simulcast' ? 3 : 1;
      const tall = layers.some((l) => l.h === (MODE === 'simulcast' ? 1080 : 720));
      return tall && Object.keys(ramp.firstBytesMs).length >= wanted && ramp.kbps.length > 4 && ramp.kbps.slice(-4).every((k) => k.kbps > (MODE === 'simulcast' ? 3000 : 2000));
    }, 90000, 500);
    ramp.settledMs = Date.now() - t0;
    results.publisherRamp = ramp;
    results.publisher = layers;
    const sending = layers.filter((l) => l.bytes > 0);
    const ups = sfu.lines.filter((l) => /publish cam: slot \d+ up \(video/.test(l));
    if (MODE === 'simulcast') {
      check('the browser offers three rids', published.offeredRids === 3, published);
      check('the publisher sends three layers', sending.length === 3, layers);
      check('no layer sends more than 30fps', sending.every((l) => (l.fps || 0) <= 31), layers);
      check('video binds a layer per rid', ups.length === 3, ups.map((l) => l.replace(/^\d+ /, '')));
    } else {
      check('the publisher sends one encoding', sending.length === 1, layers);
    }

    const viewBrowser = await browser();
    const view = await (await viewBrowser.newContext()).newPage();
    await view.goto(`http://localhost:${HTTP_PORT}/`);
    const pubBefore = await pub.evaluate(() => window.publishStats());
    const joins = await joinTimes(view, 'cam');
    const pubAfter = await pub.evaluate(() => window.publishStats());
    results.publisherDuringJoins = pubAfter.map((l, i) => ({ rid: l.rid || 'single', plis: l.pli - (pubBefore[i]?.pli || 0), keyframes: l.kf - (pubBefore[i]?.kf || 0) }));
    results.firstFrame = { joins: joins.times.length, medianMs: median(joins.times), p90Ms: pct(joins.times, 0.9), minMs: Math.min(...joins.times), maxMs: Math.max(...joins.times), afterAnswerMedianMs: median(joins.afterAnswer), times: joins.times, heights: joins.heights };
    if (process.env.TIMINGS) results.timings = await (await fetch('http://127.0.0.1:9300/timings').catch(() => null))?.json().catch(() => null);
    check('every join got a first frame', joins.times.length === JOINS, results.firstFrame);

    if (MODE === 'simulcast') {
      check('new viewers start on a full-size layer', joins.heights.every((h) => h >= 720), joins.heights);
      const previews = await joinTimes(view, 'cam', true);
      results.previewFirstFrame = { medianMs: median(previews.times), p90Ms: pct(previews.times, 0.9), heights: previews.heights };
      check('previews get the 360 layer', previews.heights.length === JOINS && previews.heights.every((h) => h === 360), results.previewFirstFrame);

      const id = await view.evaluate((u) => window.watch('cam', u), WS_URL);
      await sleep(9000);
      const long = await view.evaluate((i) => window.view(i), id);
      const changes = heightsOf(long.samples);
      const last = long.samples[long.samples.length - 1];
      results.healthyViewer = { changes, freezeSec: last.freeze, keyframesDecoded: last.kf, lost: last.lost };
      check('a healthy viewer climbs from 720 to 1080', changes.length >= 2 && changes[0].h === 720 && changes[changes.length - 1].h === 1080, changes);
      check('the climb froze nothing', last.freeze === 0, last);
      await view.evaluate((i) => window.unwatch(i), id);
    }

    {
      const gate = MODE === 'simulcast' ? check : (name, ok, detail) => results.checks.push({ name, ok, detail, info: true });
      const pipe = relay(RELAY_PORT, UDP_PORT);
      const at = (i) => view.evaluate((i) => Math.round(performance.now() - window.views[i].t0), i);
      const samples = async (i) => (await view.evaluate((i) => window.view(i), i)).samples;
      const slowId = await view.evaluate(([u, r]) => window.watch('cam', u, false, r), [WS_URL, RELAY_PORT]);
      await waitFor(async () => (await samples(slowId)).at(-1)?.h === (MODE === 'simulcast' ? 1080 : 720), 15000);
      await sleep(1000);
      const before = (await samples(slowId)).at(-1);
      const throttledAt = await at(slowId);
      pipe.limit(DOWNLINK_KBPS);
      const throttledWall = Date.now();
      await sleep(SQUEEZE_MS);
      const during = (await samples(slowId)).filter((x) => x.t > throttledAt);
      pipe.limit(0);
      const freedWall = Date.now();
      const freedAt = await at(slowId);
      const tail = during.filter((x) => x.t > throttledAt + SQUEEZE_MS / 2);
      const fps = tail.length > 1 ? Math.round(((tail.at(-1).frames - tail[0].frames) * 1000) / (tail.at(-1).t - tail[0].t)) : 0;
      const on360 = during.find((x) => x.h === 360);
      const back = await waitFor(async () => {
        const s = (await samples(slowId)).filter((x) => x.t > freedAt && x.h);
        const last = s.at(-1);
        const second = s.find((x) => x.t >= (last ? last.t - 1000 : 0));
        return last && last.h >= 720 && last.t - second.t >= 800 && last.frames - second.frames >= 15 ? second : null;
      }, 45000, 200);
      const all = await samples(slowId);
      const firstLine = (re, after) => sfu.lines.map((l) => [Number(l.split(' ')[0]), l]).find(([t, l]) => t >= after && re.test(l));
      const cut = firstLine(/watch cam: slot 0 layer \d+ -> 0 \(Congested/, throttledWall);
      const lift = firstLine(/watch cam: slot 0 layer 0 -> \d \(Healthy/, freedWall);
      results.squeezedViewer = {
        kbps: DOWNLINK_KBPS,
        squeezeMs: SQUEEZE_MS,
        from: before.h,
        sfuDownAfterMs: cut ? cut[0] - throttledWall : null,
        on360AfterMs: on360 ? on360.t - throttledAt : null,
        fpsInSecondHalf: fps,
        freezeSecDuringSqueeze: Math.round((during.at(-1).freeze - before.freeze) * 1000) / 1000,
        relayDropped: pipe.dropped(),
        sfuUpAfterMs: lift ? lift[0] - freedWall : null,
        backTo720AfterMs: back ? back.t - freedAt : null,
        totalFreezeSec: all.at(-1).freeze,
        changes: heightsOf(all)
      };
      gate('a viewer squeezed to ' + DOWNLINK_KBPS + ' kbps falls to 360', !!on360, results.squeezedViewer);
      gate('the squeezed viewer keeps moving', fps >= 20, results.squeezedViewer);
      gate('the squeeze froze the picture for under a second', results.squeezedViewer.freezeSecDuringSqueeze < 1, results.squeezedViewer);
      gate('it climbs back once the squeeze ends', !!back, results.squeezedViewer);
      await view.evaluate((i) => window.unwatch(i), slowId);
      pipe.close();
    }

    if (MODE === 'simulcast') {
      const thumb = await waitFor(async () => (await fetch(`http://127.0.0.1:${WS_PORT}/thumb/cam.jpg`).catch(() => null))?.ok, 15000, 500);
      check('the thumbnail comes from the low layer', !!thumb);
    }

    results.switches = sfu.lines.filter((l) => /layer \d+ ->|on layer \d+ \d+ms/.test(l)).map((l) => l.replace(/^\d+ /, '').replace(/^\[[^\]]*\]\s*/, ''));
    const decided = sfu.lines.map((l) => /on layer (\d+) (\d+)ms after the decision/.exec(l)).filter(Boolean).map((m) => Number(m[2]));
    if (decided.length) results.switchMs = { n: decided.length, medianMs: median(decided), maxMs: Math.max(...decided), all: decided };

    if (MODE === 'simulcast' && !process.env.SKIP_DUMMY) {
      const dummy = start(['dummy'], { RUST_LOG: 'warn,video=info', DUMMY_STREAMS: '1', DUMMY_NAMES: 'dummy-a', DUMMY_PASSWORD: 'local-only', API_URL: `http://127.0.0.1:${HTTP_PORT}`, VIDEO_WS_URL: WS_URL, DUMMY_CHAT: '0', DUMMY_GIFS: path.join(ROOT, 'random-media/gifs') }, 'dummy');
      procs.push(dummy.child);
      const live = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${WS_PORT}/live`)).json()).includes('dummy-a'), 30000, 500);
      check('the dummy goes live', !!live, dummy.lines.slice(-5));
      await sleep(1500);
      const dummyJoins = await joinTimes(view, 'dummy-a');
      results.dummyFirstFrame = { medianMs: median(dummyJoins.times), p90Ms: pct(dummyJoins.times, 0.9), heights: dummyJoins.heights };
      check('dummy viewers get pictures from the single layer', dummyJoins.times.length === JOINS && dummyJoins.heights.every((h) => h === 240), results.dummyFirstFrame);
    }
    await pubBrowser.close();
    await viewBrowser.close();
  } catch (e) {
    check('no exception', false, String(e && e.stack));
  } finally {
    await cleanup();
  }
  if (process.env.LOG) fs.writeFileSync(process.env.LOG, sfu.lines.join('\n'));
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ publisherRamp: results.publisherRamp && { firstBytesMs: results.publisherRamp.firstBytesMs, settledMs: results.publisherRamp.settledMs }, firstFrame: results.firstFrame, previewFirstFrame: results.previewFirstFrame, healthyViewer: results.healthyViewer, squeezedViewer: results.squeezedViewer, switchMs: results.switchMs, dummyFirstFrame: results.dummyFirstFrame }, null, 1));
  console.log(failed ? 'FAIL' : 'PASS');
  process.exit(failed ? 1 : 0);
})();
