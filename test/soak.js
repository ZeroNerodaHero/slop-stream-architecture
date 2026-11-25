const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_BIN = process.env.VIDEO_BIN || path.join(ROOT, 'target/release/video');
const CHROME = process.env.CHROME || undefined;
const MINUTES = Number(process.env.MINUTES || 20);
const STREAMS = Number(process.env.STREAMS || 4);
const STEADY = Number(process.env.STEADY || 3);
const CHURN_MS = Number(process.env.CHURN_MS || 2000);
const MAX_CHURNERS = Number(process.env.MAX_CHURNERS || 6);
const BLOCKED = Number(process.env.BLOCKED || 0.3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 15000);
const WS_PORT = Number(process.env.WS_PORT || 17880);
const UDP_PORT = Number(process.env.UDP_PORT || 17882);
const HTTP_PORT = Number(process.env.HTTP_PORT || 17900);
const OUT = process.env.OUT;
const LOG = process.env.LOG;
const WS_URL = `ws://127.0.0.1:${WS_PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

const PAGE = `<!doctype html><meta charset="utf-8"><body><script>
window.views = {};
let next = 0;
window.watch = async (name, url, preview, blocked) => {
  const id = next++;
  const pc = new RTCPeerConnection();
  const view = { pc, ws: null, frames: 0 };
  window.views[id] = view;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  document.body.append(video);
  view.video = video;
  pc.ontrack = (e) => { if (e.track.kind === 'video') video.srcObject = new MediaStream([e.track]); };
  await pc.setLocalDescription(await pc.createOffer());
  const ws = new WebSocket(url);
  view.ws = ws;
  const sdp = blocked ? pc.localDescription.sdp.split('\\r\\n').filter((l) => !l.startsWith('a=candidate') && !l.startsWith('a=end-of-candidates')).join('\\r\\n') : pc.localDescription.sdp;
  if (blocked) pc.close();
  view.closedAt = null;
  ws.onclose = () => { view.closedAt = Date.now(); };
  ws.onopen = () => ws.send(JSON.stringify(preview ? { role: 'watch', name, sdp, preview: true } : { role: 'watch', name, sdp }));
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.sdp && !blocked && pc.signalingState !== 'closed') await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
  };
  return id;
};
window.say = (id, text) => { const v = window.views[id]; if (v && v.ws && v.ws.readyState === 1) v.ws.send(text); };
window.frames = async (id) => {
  const v = window.views[id];
  if (!v) return 0;
  const stats = await v.pc.getStats();
  for (const s of stats.values()) if (s.type === 'inbound-rtp' && s.kind === 'video') return s.framesDecoded || 0;
  return 0;
};
window.gone = (id) => { const v = window.views[id]; return !v || v.closedAt !== null; };
window.unwatch = (id) => { const v = window.views[id]; if (!v) return; delete window.views[id]; if (v.ws) v.ws.close(); v.pc.close(); v.video.remove(); };
</script>`;

function serve() {
  return http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
      if (req.method === 'POST' && /^\/api\/streams\/[^/]+\/go-live$/.test(url.pathname)) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session: 1, token: 1 }));
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(404).end();
    })
    .listen(HTTP_PORT, '127.0.0.1');
}

function start(args, env, log) {
  const child = spawn(VIDEO_BIN, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const take = (chunk) => {
    if (log) fs.appendFileSync(log, chunk);
    for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(line);
    if (lines.length > 2000) lines.splice(0, 1000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  return { child, lines };
}

function rss(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key) => Number((status.match(new RegExp(`${key}:\\s+(\\d+)`)) || [0, 0])[1]);
  return { rssMiB: +(kb('VmRSS') / 1024).toFixed(1), threads: kb('Threads') };
}

function slope(samples) {
  const xs = samples.map((s) => s.min);
  const ys = samples.map((s) => s.rssMiB);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? +(num / den).toFixed(3) : 0;
}

(async () => {
  const server = serve();
  const sfu = start([], { RUST_LOG: 'warn', PUBLIC_IP: '127.0.0.1', WS_PORT: String(WS_PORT), UDP_PORT: String(UDP_PORT), API_URL: `http://127.0.0.1:${HTTP_PORT}`, DUMMY_PASSWORD: 'local-only' }, LOG);
  const names = Array.from({ length: STREAMS }, (_, i) => `dummy-${String.fromCharCode(97 + i)}`);
  await sleep(1000);
  const dummy = start(['dummy'], { RUST_LOG: 'warn', DUMMY_STREAMS: String(STREAMS), DUMMY_NAMES: names.join(','), DUMMY_PASSWORD: 'local-only', API_URL: `http://127.0.0.1:${HTTP_PORT}`, VIDEO_WS_URL: WS_URL, DUMMY_CHAT: '0', DUMMY_GIFS: path.join(ROOT, 'random-media/gifs') });
  const browser = await chromium.launch({ executablePath: CHROME, channel: CHROME ? undefined : 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const stop = async (code) => {
    await browser.close().catch(() => {});
    dummy.child.kill('SIGTERM');
    sfu.child.kill('SIGTERM');
    server.close();
    process.exit(code);
  };
  process.on('SIGINT', () => stop(130));

  for (let i = 0; i < 60; i++) {
    const live = await fetch(`http://127.0.0.1:${WS_PORT}/live`).then((r) => r.json()).catch(() => []);
    if (names.every((n) => live.includes(n))) break;
    await sleep(500);
  }
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${HTTP_PORT}/`);

  const steady = [];
  for (let i = 0; i < STEADY; i++) steady.push(await page.evaluate(([n, u]) => window.watch(n, u, false), [names[i % names.length], WS_URL]));

  const counts = { joins: 0, previews: 0, aborts: 0, pauses: 0, blocked: 0, blockedGone: 0 };
  let churners = 0;
  let running = true;
  const churn = async () => {
    churners++;
    try {
      const preview = Math.random() < 0.4;
      const blocked = Math.random() < BLOCKED;
      const id = await page.evaluate(([n, u, p, b]) => window.watch(n, u, p, b), [pick(names), WS_URL, preview, blocked]);
      counts.joins++;
      if (preview) counts.previews++;
      if (blocked) {
        counts.blocked++;
        const end = Date.now() + 40000;
        while (Date.now() < end && running && !(await page.evaluate((i) => window.gone(i), id))) await sleep(1000);
        if (await page.evaluate((i) => window.gone(i), id)) counts.blockedGone++;
      } else if (Math.random() < 0.25) {
        await sleep(50 + Math.random() * 250);
        counts.aborts++;
      } else {
        const end = Date.now() + 2000 + Math.random() * 13000;
        while (Date.now() < end && running) {
          await sleep(1000 + Math.random() * 2000);
          if (Math.random() < 0.5) {
            counts.pauses++;
            await page.evaluate((i) => window.say(i, '{"view":"hidden"}'), id);
            await sleep(500 + Math.random() * 2500);
            await page.evaluate((i) => window.say(i, pick(['{"view":"full"}', '{"view":"small"}'])), id).catch(() => page.evaluate((i) => window.say(i, '{"view":"full"}'), id));
          }
        }
      }
      await page.evaluate((i) => window.unwatch(i), id);
    } catch (e) {
      console.error('churn', e.message);
    } finally {
      churners--;
    }
  };
  await page.evaluate(() => { window.pick = (xs) => xs[Math.floor(Math.random() * xs.length)]; });

  const t0 = Date.now();
  const samples = [];
  const sample = async () => {
    const s = { min: +((Date.now() - t0) / 60000).toFixed(2), ...rss(sfu.child.pid), churners, joins: counts.joins };
    s.steadyFrames = await page.evaluate(async (ids) => Promise.all(ids.map((i) => window.frames(i))), steady);
    samples.push(s);
    console.log(JSON.stringify(s));
  };
  await sample();
  const sampler = setInterval(sample, SAMPLE_MS);
  const churner = setInterval(() => {
    if (CHURN_MS > 0 && churners < MAX_CHURNERS) churn();
  }, CHURN_MS || 1e9);
  await sleep(MINUTES * 60000);
  running = false;
  clearInterval(churner);
  clearInterval(sampler);
  while (churners > 0) await sleep(200);
  await sleep(5000);
  await sample();

  const warm = samples.filter((s) => s.min >= Math.min(3, MINUTES / 4));
  const result = { video: VIDEO_BIN, minutes: MINUTES, streams: STREAMS, steady: STEADY, counts, startMiB: samples[0].rssMiB, endMiB: samples.at(-1).rssMiB, maxMiB: Math.max(...samples.map((s) => s.rssMiB)), slopeMiBPerMin: slope(warm), samples };
  console.log(JSON.stringify({ ...result, samples: undefined }));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  await stop(0);
})();
