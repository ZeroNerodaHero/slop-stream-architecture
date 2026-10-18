// Partial redeploys while a stream is live. Run: BASE_URL=https://<ip> node redeploy.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const REPO = require('path').join(__dirname, '..');
const ENV = process.env;
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (p) => p.evaluate(() => document.querySelector('#status').textContent.trim());
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); results.push(true); console.log(`PASS  ${name.padEnd(52)} ${String(Date.now() - t0).padStart(6)} ms  ${info || ''}`); }
  catch (e) { results.push(false); console.log(`FAIL  ${name.padEnd(52)} ${String(Date.now() - t0).padStart(6)} ms\n      ${e.message}`); }
}
function recordPcs() { window.__pcs = []; const O = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(O, { construct(t, a, n) { const pc = Reflect.construct(t, a, n); window.__pcs.push(pc); return pc; } }); }
async function frames(page) {
  return page.evaluate(async () => { for (const pc of window.__pcs || []) { const r = await pc.getStats(); for (const s of r.values()) if (s.type === 'inbound-rtp' && s.kind === 'video') return s.framesDecoded; } return -1; });
}
function deploy(target) {
  const t0 = Date.now();
  const out = execSync(`./deploy.sh ${target} 2>&1`, { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ms: Date.now() - t0, out };
}

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, timeout: 5000 });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const ctx = async () => { const c = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] }); await c.addInitScript(recordPcs); return c; };
  const pub = await (await ctx()).newPage();
  await pub.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
  await pub.fill('#name', 'rd1');
  await pub.waitForFunction(() => !document.querySelector('#start').disabled);
  await pub.click('#start');
  await pub.waitForFunction(() => /^live$/i.test(document.querySelector('#status').textContent.trim()), null, { timeout: 20000 });
  const w = await (await ctx()).newPage();
  await w.goto(`${BASE}/watch/rd1`, { waitUntil: 'domcontentloaded' });
  await w.waitForFunction(() => /^watching$/i.test(document.querySelector('#status').textContent.trim()), null, { timeout: 20000 });
  console.log('stream rd1 is live, watcher watching\n');

  await step('./deploy.sh frontend keeps the stream alive', async () => {
    const before = await frames(w);
    const { ms, out } = deploy('frontend');
    await sleep(1500);
    const after = await frames(w);
    const home = await (await api.get('/')).text();
    const ok = /^live$/i.test(await status(pub)) && /^watching$/i.test(await status(w)) && after > before && /pages published/.test(out) && /<div id="root">/.test(home);
    if (!ok) throw new Error(`pub "${await status(pub)}" watch "${await status(w)}" frames ${before}->${after}\n${out.slice(-600)}`);
    return `${ms} ms, frames ${before} -> ${after}, pages published, caddy untouched`;
  });

  await step('./deploy.sh api keeps the stream alive', async () => {
    const before = await frames(w);
    const { ms } = deploy('api');
    await sleep(1500);
    const after = await frames(w);
    const health = (await api.get('/api/health')).status();
    const list = await (await api.get('/api/streams')).json();
    const ok = /^live$/i.test(await status(pub)) && /^watching$/i.test(await status(w)) && after > before && health === 200 && list.some((s) => s.name === 'rd1');
    if (!ok) throw new Error(`pub "${await status(pub)}" watch "${await status(w)}" frames ${before}->${after} health ${health} list ${JSON.stringify(list)}`);
    return `${ms} ms, frames ${before} -> ${after}, api healthy, still listed`;
  });

  await step('./deploy.sh video warns and ends streams cleanly', async () => {
    const { ms, out } = deploy('video');
    await pub.waitForFunction(() => /lost|stopped|failed/i.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
    await w.waitForFunction(() => /ended|checking/i.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
    if (!/ends every live stream/.test(out)) throw new Error('no warning printed');
    return `${ms} ms, pub "${await status(pub)}", watch "${await status(w)}", warning printed`;
  });

  await pub.close().catch(() => {});
  await browser.close();
  await api.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
