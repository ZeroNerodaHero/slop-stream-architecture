// Regressions for the adversarial findings. Run: BASE_URL=https://<ip> node regress.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const DOCKER_ENV = process.env;
const REPO = require('path').join(__dirname, '..');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push(true);
    console.log(`PASS  ${name.padEnd(60)} ${String(Date.now() - t0).padStart(6)} ms  ${info || ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name.padEnd(60)} ${String(Date.now() - t0).padStart(6)} ms\n      ${e.message}`);
  }
}
const status = (page) => page.evaluate(() => document.querySelector('#status').textContent.trim());
async function waitStatus(page, re, timeout = 20000) {
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#status').textContent), re.source, { timeout });
  return status(page);
}
async function framesIncrease(page, gap = 1500) {
  const read = () => page.evaluate(async () => {
    for (const pc of window.__pcs || []) {
      const r = await pc.getStats();
      for (const s of r.values()) if (s.type === 'inbound-rtp' && s.kind === 'video') return s.framesDecoded;
    }
    return -1;
  });
  const a = await read(); await sleep(gap); const b = await read();
  if (!(b > a && a >= 0)) throw new Error(`framesDecoded ${a} -> ${b}`);
  return `${a} -> ${b}`;
}
function recordPcs() {
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Orig, { construct(t, a, n) { const pc = Reflect.construct(t, a, n); window.__pcs.push(pc); return pc; } });
}

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, timeout: 5000 });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const ctx = async () => { const c = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] }); await c.addInitScript(recordPcs); return c; };
  const publisher = async (name) => {
    const page = await (await ctx()).newPage();
    await page.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', name);
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    await page.click('#start');
    await waitStatus(page, /^live$/);
    return page;
  };
  const watcher = async (path) => {
    const page = await (await ctx()).newPage();
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  // 1. third-party stop is refused; stream keeps going
  await step('stop without token -> 403, stream unaffected', async () => {
    const p = await publisher('r1');
    const w = await watcher('/watch/r1');
    await waitStatus(w, /^watching$/);
    const res = await api.post('/api/streams/r1/stop');
    const bad = await api.post('/api/streams/r1/stop?session=1&token=2');
    await sleep(500);
    const list = await (await api.get('/api/streams')).json();
    const ok = res.status() === 400 && bad.status() === 403 && list.some((s) => s.name === 'r1') && /^live$/i.test(await status(p)) && /^watching$/i.test(await status(w));
    await p.click('#stop');
    if (!ok) throw new Error(`no-token ${res.status()}, bad-token ${bad.status()}, list ${JSON.stringify(list)}, pub ${await status(p)}, watch ${await status(w)}`);
    return `no-token ${res.status()}, bad-token ${bad.status()}`;
  });

  // 2. publisher reloads -> watcher recovers on its own
  await step('publisher reload -> watcher auto-recovers', async () => {
    const p = await publisher('r2');
    const w = await watcher('/watch/r2');
    await waitStatus(w, /^watching$/);
    const t0 = Date.now();
    await p.reload({ waitUntil: 'domcontentloaded' });
    await waitStatus(w, /ended/, 5000);
    await p.fill('#name', 'r2');
    await p.waitForFunction(() => !document.querySelector('#start').disabled);
    await p.click('#start');
    await waitStatus(p, /^live$/);
    await waitStatus(w, /^watching$/, 15000);
    const f = await framesIncrease(w);
    await p.click('#stop');
    return `back to watching ${Date.now() - t0} ms after reload, frames ${f}`;
  });

  // 3. trailing slash
  await step('/watch/<name>/ with trailing slash works', async () => {
    const p = await publisher('r3');
    const w = await watcher('/watch/r3/');
    const s = await waitStatus(w, /^watching$/);
    await p.click('#stop');
    return `status "${s}"`;
  });

  // 4. video restart is fast and both pages react at once
  await step('docker restart video is quick, pages react', async () => {
    const p = await publisher('r4');
    const w = await watcher('/watch/r4');
    await waitStatus(w, /^watching$/);
    const t0 = Date.now();
    execSync('docker compose restart video', { cwd: REPO, env: DOCKER_ENV, stdio: 'ignore' });
    const restartMs = Date.now() - t0;
    const ps = await waitStatus(p, /lost|stopped|failed/, 10000);
    const ws = await waitStatus(w, /ended|checking|lost/, 10000);
    await sleep(1500);
    const health = (await api.get('/api/health')).status();
    const list = await (await api.get('/api/streams')).json();
    if (restartMs > 6000) throw new Error(`restart took ${restartMs} ms`);
    if (list.length) throw new Error(`stale list ${JSON.stringify(list)}`);
    return `restart ${restartMs} ms, pub "${ps}", watch "${ws}", health ${health}`;
  });

  // 5. start, stop fast, start again
  await step('start/stop/start race is clean', async () => {
    const page = await (await ctx()).newPage();
    await page.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await page.fill('#name', 'r5');
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    await page.click('#start');
    await sleep(150);
    await page.click('#stop');
    await sleep(300);
    await page.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 5000 });
    await page.click('#start');
    const s = await waitStatus(page, /^live$/);
    await sleep(3000);
    const still = await status(page);
    const list = await (await api.get('/api/streams')).json();
    await page.click('#stop');
    if (!/^live$/i.test(still)) throw new Error(`status drifted to "${still}"`);
    if (!list.some((x) => x.name === 'r5')) throw new Error(`not listed: ${JSON.stringify(list)}`);
    return `"${s}" and stayed live`;
  });

  // 6. heartbeat ownership
  await step('heartbeat: wrong token 404, lapsed key reclaimed', async () => {
    const grant = await (await api.post('/api/streams/r6/go-live')).json();
    const wrong = await api.post(`/api/streams/r6/heartbeat?session=${grant.session}&token=1`);
    const okRes = await api.post(`/api/streams/r6/heartbeat?session=${grant.session}&token=${grant.token}`);
    execSync('docker compose exec -T redis redis-cli del live:r6', { cwd: REPO, env: DOCKER_ENV, stdio: 'ignore' });
    const reclaimed = await (await api.post(`/api/streams/r6/heartbeat?session=${grant.session}&token=${grant.token}`)).json();
    const stopRes = await api.post(`/api/streams/r6/stop?session=${grant.session}&token=${grant.token}`);
    if (wrong.status() !== 403 || okRes.status() !== 200 || !reclaimed.reclaimed || stopRes.status() !== 200)
      throw new Error(`wrong ${wrong.status()}, ok ${okRes.status()}, reclaimed ${JSON.stringify(reclaimed)}, stop ${stopRes.status()}`);
    return `wrong ${wrong.status()}, ok ${okRes.status()}, reclaimed, stop ${stopRes.status()}`;
  });

  // 7. oversized / garbage offer is refused without touching the room
  await step('oversized offer refused, name still free', async () => {
    const page = await (await ctx()).newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const reply = await page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket(`wss://${location.host}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ role: 'publish', name: 'r7', sdp: 'v=0\r\n' + 'a=junk\r\n'.repeat(6000) }));
      ws.onmessage = (e) => resolve(e.data);
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 8000);
    }));
    const live = await (await api.get('/api/streams')).json();
    const p = await publisher('r7');
    await p.click('#stop');
    if (!/bad offer/.test(reply)) throw new Error(`reply ${reply}`);
    return `reply ${reply}, live ${JSON.stringify(live)}, then r7 went live fine`;
  });

  await browser.close();
  await api.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
