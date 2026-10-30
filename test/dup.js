// Second publisher on a live name must be refused. Run: BASE_URL=https://<ip> node dup.js
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const NAME = 'duptest';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const mk = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
    const page = await ctx.newPage();
    // no name box on /live: a guest streams as the nick in the corner panel (localstorage, json the way jotai keeps it)
    await page.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), NAME);
    await page.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#start').disabled);
    await page.click('#start');
    return page;
  };
  const a = await mk();
  await a.waitForFunction(() => /^live$/i.test(document.querySelector('#status').textContent.trim()), null, { timeout: 20000 });
  console.log('first publisher: live');

  const b = await mk();
  await b.waitForFunction(() => /already live|failed|stopped/i.test(document.querySelector('#status').textContent), null, { timeout: 20000 });
  console.log('second publisher status:', await b.textContent('#status'));
  console.log('first publisher still:', await a.textContent('#status'));

  const list = await (await a.request.get(`${BASE}/api/streams`)).json();
  console.log('api streams:', JSON.stringify(list));
  const mine = list.filter((s) => s.name === NAME).length;
  const ok = /already live/i.test(await b.textContent('#status')) && /^live$/i.test((await a.textContent('#status')).trim()) && mine === 1;
  await a.click('#stop');
  await browser.close();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
