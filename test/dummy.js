// The fake streams: home shows them, one plays with video and audio, and the dummy- names are password-gated.
// Needs DUMMY_STREAMS >= 1 in .env. Run through ./scripts/test.sh --all, or: BASE_URL=https://<ip> node dummy.js
const { chromium, request } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const ARGS = ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function recordPcs() { window.__pcs = []; const O = window.RTCPeerConnection; window.RTCPeerConnection = new Proxy(O, { construct(t, a, n) { const pc = Reflect.construct(t, a, n); window.__pcs.push(pc); return pc; } }); }
const stats = (page) => page.evaluate(async () => { const out = {}; for (const pc of window.__pcs || []) { const r = await pc.getStats(); for (const s of r.values()) if (s.type === 'inbound-rtp') out[s.kind] = { frames: s.framesDecoded, packets: s.packetsReceived, w: s.frameWidth, h: s.frameHeight }; } return out; });

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ARGS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 900 } });
  await ctx.addInitScript(recordPcs);

  const home = await ctx.newPage();
  await home.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await home.waitForSelector('#list article');
  await sleep(500);
  await home.screenshot({ path: require('os').tmpdir() + '/stream-e2e-dummy-home.png' });
  console.log('home cards:', await home.locator('#list article').count());

  // whichever dummy- name is live: with DUMMY_STREAMS=1 that is only the first default, dummy-mango
  const live = await (await api.get('/api/streams')).json();
  const dummy = live.find((s) => /^dummy-/.test(s.name));
  if (!dummy) { console.log(`FAIL  no dummy- stream in /api/streams (DUMMY_STREAMS >= 1 and default names?): ${JSON.stringify(live)}`); await browser.close(); await api.dispose(); process.exit(1); }
  const w = await ctx.newPage();
  await w.goto(`${BASE}/watch/${dummy.name}`, { waitUntil: 'domcontentloaded' });
  await w.waitForFunction(() => /^watching$/i.test(document.querySelector('#status').textContent.trim()), null, { timeout: 20000 });
  const a = await stats(w); await sleep(2000); const b = await stats(w);
  console.log(`watch ${dummy.name}:`, JSON.stringify(a), '->', JSON.stringify(b));
  await w.screenshot({ path: require('os').tmpdir() + '/stream-e2e-dummy-watch.png' });

  // password gate
  const noPw = await api.post('/api/streams/dummy-evil/go-live');
  const badPw = await api.post('/api/streams/dummy-evil/go-live?password=wrong');
  const wsReply = await w.evaluate(() => new Promise((resolve) => {
    const ws = new WebSocket(`wss://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ role: 'publish', name: 'dummy-evil', sdp: 'v=0\r\n' }));
    ws.onmessage = (e) => resolve(e.data);
    setTimeout(() => resolve('timeout'), 5000);
  }));
  console.log(`api go-live dummy-evil: no password ${noPw.status()}, wrong password ${badPw.status()}; ws publish without password -> ${wsReply}`);
  const normal = await api.post('/api/streams/notdummy/go-live');
  console.log('normal name still free to go live:', normal.status());
  const g = await normal.json(); await api.post(`/api/streams/notdummy/stop?session=${g.session}&token=${g.token}`);

  const ok = b.video.frames > a.video.frames && b.audio.packets > a.audio.packets && noPw.status() === 403 && badPw.status() === 403 && /reserved name/.test(wsReply) && normal.status() === 200;
  await browser.close(); await api.dispose();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
