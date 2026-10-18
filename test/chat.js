// The text chat: two viewers talk, history survives a reload, 501 chars is refused,
// the streamer's lines are marked. Run through ./test.sh, or: BASE_URL=https://<ip> node chat.js
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const ROOM = 'chattest' + Date.now().toString(36).slice(-4);
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push(true);
    console.log(`PASS  ${name.padEnd(56)} ${String(Date.now() - t0).padStart(6)} ms  ${info || ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name.padEnd(56)} ${String(Date.now() - t0).padStart(6)} ms\n      ${e.message}`);
  }
}
const lines = (page) => page.$$eval('#chat-lines p[data-streamer], #chat-lines p', (ps) => ps.map((p) => ({ text: p.textContent, streamer: p.dataset.streamer === 'true' })));
async function joinAs(page, nick) {
  await page.waitForSelector('#chat-nick', { timeout: 10000 });
  await page.fill('#chat-nick', nick);
  await page.click('#chat-join');
  await page.waitForSelector('#chat-text', { timeout: 10000 });
  await page.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, { timeout: 10000 });
}
async function say(page, text) {
  await page.fill('#chat-text', text);
  await page.click('#chat-send');
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] })).newPage();

  const a = await fresh();
  const b = await fresh();
  await a.goto(`${BASE}/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });
  await b.goto(`${BASE}/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });

  await step('two viewers join an empty room (nobody live)', async () => {
    await joinAs(a, 'alice');
    await joinAs(b, 'bob');
    await a.waitForFunction(() => /^2 here/.test(document.querySelector('#chat-count').textContent), null, { timeout: 10000 });
    return `count "${await a.textContent('#chat-count')}"`;
  });

  await step('a says, b sees it, a sees its own line', async () => {
    await say(a, 'hello from alice');
    await b.waitForFunction(() => /alice.*hello from alice/.test(document.querySelector('#chat-lines').textContent), null, { timeout: 10000 });
    await a.waitForFunction(() => /hello from alice/.test(document.querySelector('#chat-lines').textContent), null, { timeout: 10000 });
    await say(b, 'hey alice');
    await a.waitForFunction(() => /bob.*hey alice/.test(document.querySelector('#chat-lines').textContent), null, { timeout: 10000 });
    return `${(await lines(a)).length} lines on a`;
  });

  await step('reload keeps the history', async () => {
    await b.reload({ waitUntil: 'domcontentloaded' });
    await b.waitForSelector('#chat-text', { timeout: 10000 }); // nick remembered, auto-joins
    await b.waitForFunction(() => /hello from alice/.test(document.querySelector('#chat-lines').textContent) && /hey alice/.test(document.querySelector('#chat-lines').textContent), null, { timeout: 10000 });
    return `${(await lines(b)).length} lines after reload`;
  });

  await step('501 characters is refused, 500 is fine', async () => {
    const before = (await lines(a)).length;
    await a.fill('#chat-text', 'x'.repeat(501));
    const disabled = await a.$eval('#chat-send', (b) => b.disabled);
    await a.press('#chat-text', 'Enter'); // the keyboard path hits the server rule
    await sleep(700);
    const after = (await lines(a)).length;
    await say(a, 'y'.repeat(500));
    await b.waitForFunction(() => /y{500}/.test(document.querySelector('#chat-lines').textContent), null, { timeout: 10000 });
    if (!disabled || after !== before) throw new Error(`send disabled=${disabled}, lines ${before}->${after}`);
    return 'button disabled at 501, 500 delivered';
  });

  await step('the streamer\'s lines are marked', async () => {
    const s = await fresh();
    await s.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await s.fill('#name', ROOM);
    await s.waitForFunction(() => !document.querySelector('#start').disabled, null, { timeout: 15000 });
    await s.click('#start');
    await s.waitForFunction(() => /^live$/i.test(document.querySelector('#status').textContent.trim()), null, { timeout: 20000 });
    await s.waitForSelector('#chat-text', { timeout: 10000 });
    await s.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, { timeout: 10000 });
    await say(s, 'streamer here');
    await a.waitForFunction((room) => [...document.querySelectorAll('#chat-lines p')].some((p) => p.dataset.streamer === 'true' && p.textContent.includes(room) && p.textContent.includes('streamer here')), ROOM, { timeout: 10000 });
    await s.click('#stop');
    return 'marked on a viewer\'s screen';
  });

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
