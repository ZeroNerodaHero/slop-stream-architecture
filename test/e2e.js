#!/usr/bin/env node
// End-to-end WebRTC live-stream test: publisher (/live) -> video server -> watcher (/watch/<name>).
//
// Run through ./test.sh at the repo root, or: BASE_URL=https://<ip> node e2e.js
// HEADED=1 to watch it. Exit code 0 when every step passes. Screenshots land in $TMPDIR/stream-e2e.

const fs = require('fs');
const { chromium, request } = require('playwright');

const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const NAME = process.env.STREAM_NAME || 'e2etest';
const HEADLESS = !process.env.HEADED;
const OUT = require('path').join(require('os').tmpdir(), 'stream-e2e');

// What the pages print. Tune here if the frontend wording differs.
const LIVE_RE = /^\s*live\b/i;      // publisher #status while publishing ("live", "live - watch at ...")
const ENDED_RE = /\bended\b/i;      // watcher #status after the publisher stops

const T = {               // timeouts, ms
  pageReady: 20000,       // /live loaded, #start enabled
  goLive: 20000,          // publisher #status -> live
  listed: 15000,          // GET /api/streams lists the name
  firstFrame: 20000,      // watcher <video>.videoWidth > 0
  statsGap: 2000,         // gap between the two framesDecoded samples
  ended: 15000,           // watcher #status -> ended
  unlisted: 15000,        // GET /api/streams no longer lists the name
};

const CHROME_ARGS = [
  '--use-fake-device-for-media-stream',      // synthetic camera (moving pattern, 640x480@20fps) + synthetic mics
  '--use-fake-ui-for-media-stream',          // auto-accept the getUserMedia prompt
  '--ignore-certificate-errors',             // self-signed cert: covers page loads AND the wss:// signaling socket
  '--autoplay-policy=no-user-gesture-required',
];

// ---------- step runner -------------------------------------------------------------------------
const results = [];
let aborted = false;
async function step(name, fn) {
  if (aborted) { results.push({ name, status: 'SKIP', ms: 0 }); console.log(`SKIP  ${name}`); return; }
  const t0 = Date.now();
  try {
    const info = await fn();
    const ms = Date.now() - t0;
    results.push({ name, status: 'PASS', ms });
    console.log(`PASS  ${name.padEnd(66)} ${String(ms).padStart(6)} ms${info ? '   ' + info : ''}`);
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ name, status: 'FAIL', ms, error: e.message });
    console.log(`FAIL  ${name.padEnd(66)} ${String(ms).padStart(6)} ms\n      ${String(e.message).split('\n').join('\n      ')}`);
    aborted = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a Node-side async fn until `until(value)` is true.
async function pollUntil(fn, until, { timeout, interval = 500, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}

// Poll a function evaluated inside the page until `until(value)` is true. Reports the last value on timeout.
async function pollPage(page, pageFn, until, { timeout, interval = 250, label }, arg) {
  return pollUntil(() => page.evaluate(pageFn, arg), until, { timeout, interval, label });
}

// Does the /api/streams JSON mention the name anywhere (array of strings, [{name}], {streams:[...]}, {name:{...}})?
function listsName(value, name) {
  const want = name.toLowerCase();
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === 'string') return v.toLowerCase() === want;
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) return v.some(walk);
    return Object.entries(v).some(([k, x]) => k.toLowerCase() === want || walk(x));
  };
  return walk(value);
}

// Record every RTCPeerConnection the page creates so the test can call getStats() on it,
// whether or not the page exposes `window.pc`. Must be installed before navigation (context.addInitScript).
function recordPeerConnections() {
  window.__pcs = [];
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Orig = window[key];
    if (!Orig) continue;
    window[key] = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        window.__pcs.push(pc);
        return pc;
      },
    });
  }
}

// Runs in the watcher page: find the inbound video RTP stats on whichever PC has them.
async function inboundVideoStats() {
  const pcs = [];
  if (window.pc && typeof window.pc.getStats === 'function') pcs.push(window.pc);
  for (const pc of window.__pcs || []) if (!pcs.includes(pc)) pcs.push(pc);
  for (const pc of pcs) {
    const report = await pc.getStats();
    for (const s of report.values()) {
      if (s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'video') {
        const codec = s.codecId ? report.get(s.codecId) : null;
        return {
          pcs: pcs.length, connectionState: pc.connectionState, framesDecoded: s.framesDecoded,
          framesPerSecond: s.framesPerSecond, bytesReceived: s.bytesReceived, packetsLost: s.packetsLost,
          frameWidth: s.frameWidth, frameHeight: s.frameHeight, codec: codec ? codec.mimeType : null,
        };
      }
    }
  }
  return { pcs: pcs.length, framesDecoded: null };
}

function videoState() {
  const v = document.querySelector('#video');
  const s = document.querySelector('#status');
  return v ? { videoWidth: v.videoWidth, videoHeight: v.videoHeight, paused: v.paused, readyState: v.readyState,
               currentTime: +v.currentTime.toFixed(2), hasSrcObject: !!v.srcObject, status: s && s.textContent.trim() }
           : { missing: '#video' };
}

function statusText() { const s = document.querySelector('#status'); return s ? s.textContent.trim() : null; }

// Keep console / websocket chatter per page; printed only when something fails.
function tap(page, tag) {
  const log = [];
  page.on('console', (m) => log.push(`[${tag} console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => log.push(`[${tag} pageerror] ${e.message}`));
  page.on('requestfailed', (r) => log.push(`[${tag} requestfailed] ${r.method()} ${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('websocket', (ws) => {
    log.push(`[${tag} ws open] ${ws.url()}`);
    ws.on('framesent', (f) => log.push(`[${tag} ws ->] ${String(f.payload).slice(0, 160)}`));
    ws.on('framereceived', (f) => log.push(`[${tag} ws <-] ${String(f.payload).slice(0, 160)}`));
    ws.on('close', () => log.push(`[${tag} ws close]`));
    ws.on('socketerror', (e) => log.push(`[${tag} ws error] ${e}`));
  });
  return log;
}

// ---------- the test ----------------------------------------------------------------------------
(async () => {
  const tStart = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`e2e  base=${BASE}  name=${NAME}  headless=${HEADLESS}\n`);

  let browser, api, publisher, watcher, pubLog = [], watchLog = [];
  const getStreams = async () => {
    const r = await api.get('/api/streams');
    if (!r.ok()) throw new Error(`GET /api/streams -> HTTP ${r.status()}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  try {
    api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, timeout: 5000 });

    await step('0. preflight: GET /api/streams reachable, name not already live', async () => {
      let list = await getStreams();
      if (listsName(list, NAME)) {               // stale key from an aborted run: clear it and re-check
        await api.post(`/api/streams/${NAME}/stop`).catch(() => {});
        await sleep(500);
        list = await getStreams();
        if (listsName(list, NAME)) throw new Error(`${NAME} is already live and could not be cleared: ${JSON.stringify(list)}`);
      }
      return `streams=${JSON.stringify(list).slice(0, 80)}`;
    });

    await step('1. launch system Chrome (channel=chrome) + 2 contexts', async () => {
      browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: HEADLESS, args: CHROME_ARGS });
      const pubCtx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
      const watchCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      await pubCtx.addInitScript(recordPeerConnections);
      await watchCtx.addInitScript(recordPeerConnections);
      publisher = await pubCtx.newPage();
      watcher = await watchCtx.newPage();
      pubLog = tap(publisher, 'publisher');
      watchLog = tap(watcher, 'watcher');
      return browser.version();
    });

    await step('2. publisher: open /live, fill #name, wait #start enabled', async () => {
      await publisher.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded', timeout: T.pageReady });
      await publisher.locator('#name').waitFor({ state: 'visible', timeout: T.pageReady });
      await publisher.fill('#name', NAME);      // name first: the page may keep #start disabled until a name exists
      await pollPage(publisher,
        () => { const b = document.querySelector('#start'), s = document.querySelector('#status');
                return b ? { disabled: b.disabled, status: s ? s.textContent.trim() : null } : { missing: '#start' }; },
        (v) => v.disabled === false, { timeout: T.pageReady, label: '#start enabled' });
    });

    await step(`3. publisher: click #start, #status becomes 'live' (<= ${T.goLive / 1000}s)`, async () => {
      await publisher.click('#start');
      const v = await pollPage(publisher, statusText, (t) => LIVE_RE.test(t || ''), { timeout: T.goLive, label: `#status ${LIVE_RE}` });
      return `status="${v}"`;
    });

    await step(`4. api: GET /api/streams lists ${NAME}`, async () => {
      const v = await pollUntil(getStreams, (l) => listsName(l, NAME), { timeout: T.listed, label: `/api/streams lists ${NAME}` });
      return JSON.stringify(v).slice(0, 100);
    });

    await step(`4b. api: a thumbnail jpeg appears for ${NAME} (<= 15s)`, async () => {
      const r = await pollUntil(
        async () => {
          const res = await api.get(`/thumb/${NAME}.jpg`);
          return { status: res.status(), type: res.headers()['content-type'], bytes: res.ok() ? (await res.body()).length : 0 };
        },
        (r) => r.status === 200 && /image\/jpeg/.test(r.type) && r.bytes > 500,
        { timeout: 15000, interval: 1000, label: 'thumbnail' }
      );
      return `${r.bytes} bytes, ${r.type}`;
    });

    await step(`5. watcher: open /watch/${NAME}, #video.videoWidth > 0 (<= ${T.firstFrame / 1000}s)`, async () => {
      await watcher.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded', timeout: T.firstFrame });
      const v = await pollPage(watcher, videoState, (s) => s.videoWidth > 0, { timeout: T.firstFrame, label: '#video.videoWidth > 0' });
      return `${v.videoWidth}x${v.videoHeight} paused=${v.paused} status="${v.status}"`;
    });

    await step(`6. watcher: inbound-rtp video framesDecoded increases over ${T.statsGap / 1000}s`, async () => {
      const s1 = await pollPage(watcher, inboundVideoStats, (s) => s.framesDecoded != null, { timeout: 5000, label: 'inbound-rtp video stat present' });
      await sleep(T.statsGap);
      const s2 = await watcher.evaluate(inboundVideoStats);
      if (!(s2.framesDecoded > s1.framesDecoded))
        throw new Error(`framesDecoded did not increase: ${s1.framesDecoded} -> ${s2.framesDecoded} (${JSON.stringify(s2)})`);
      return `framesDecoded ${s1.framesDecoded} -> ${s2.framesDecoded}  fps=${s2.framesPerSecond}  ${s2.codec}  ${s2.frameWidth}x${s2.frameHeight}  bytes=${s2.bytesReceived}  lost=${s2.packetsLost}  pcs=${s2.pcs}`;
    });

    await step('7. watcher: screenshot', async () => {
      await watcher.screenshot({ path: `${OUT}/watcher.png` });                      // whole page
      await watcher.locator('#video').screenshot({ path: `${OUT}/watcher-video.png` }); // just the frame
      return `${OUT}/watcher.png, ${OUT}/watcher-video.png`;
    });

    await step(`8. publisher: click #stop, watcher #status becomes 'ended' (<= ${T.ended / 1000}s)`, async () => {
      await publisher.click('#stop');
      const v = await pollPage(watcher, statusText, (t) => ENDED_RE.test(t || ''), { timeout: T.ended, label: `watcher #status ${ENDED_RE}` });
      return `status="${v}"`;
    });

    await step(`9. api: GET /api/streams no longer lists ${NAME}`, async () => {
      const v = await pollUntil(getStreams, (l) => !listsName(l, NAME), { timeout: T.unlisted, label: `/api/streams drops ${NAME}` });
      return JSON.stringify(v).slice(0, 100);
    });
  } catch (e) {
    aborted = true;
    results.push({ name: 'unexpected error', status: 'FAIL', ms: 0, error: e.stack || e.message });
    console.log(`FAIL  unexpected error\n      ${e.stack || e.message}`);
  } finally {
    const failed = results.some((r) => r.status !== 'PASS');
    if (failed) {
      // Leave the lab clean and keep evidence.
      if (publisher && !publisher.isClosed()) {
        await publisher.click('#stop', { timeout: 2000 }).catch(() => {});
        await publisher.screenshot({ path: `${OUT}/fail-publisher.png` }).catch(() => {});
      }
      if (watcher && !watcher.isClosed()) await watcher.screenshot({ path: `${OUT}/fail-watcher.png` }).catch(() => {});
      const lines = [...pubLog, ...watchLog];
      if (lines.length) console.log('\n--- browser log (last 40 lines) ---\n' + lines.slice(-40).join('\n'));
    }
    if (browser) await browser.close().catch(() => {});
    if (api) await api.dispose().catch(() => {});

    console.log(`\n${'='.repeat(78)}`);
    for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name.padEnd(66)} ${String(r.ms).padStart(6)} ms`);
    console.log(`${'='.repeat(78)}\n${failed ? 'FAIL' : 'PASS'}  ${results.filter((r) => r.status === 'PASS').length}/${results.length} steps passed in ${Date.now() - tStart} ms`);
    process.exit(failed ? 1 : 0);
  }
})();
