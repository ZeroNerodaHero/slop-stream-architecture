const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const NAME = 'r8';
const CLAIMED = 'rp1';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    if (info && typeof info === 'object' && info.skip) {
      results.push('skip');
      console.log(`SKIP  ${name.padEnd(70)} ${ms()} ms  ${info.skip}`);
      return;
    }
    results.push('pass');
    console.log(`PASS  ${name.padEnd(70)} ${ms()} ms  ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${name.padEnd(70)} ${ms()} ms\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (cmd) => execSync(`docker compose ${cmd}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const onlineIn = (service) => {
  const raw = compose(`exec -T ${service} bash -c 'exec 3<>/dev/tcp/127.0.0.1/4100; printf "GET /online HTTP/1.0\\r\\n\\r\\n" >&3; cat <&3'`);
  return JSON.parse(raw.slice(raw.indexOf('{')));
};
const online = () => {
  const all = {};
  for (const service of ['events', 'chat']) for (const [name, n] of Object.entries(onlineIn(service))) all[name] = (all[name] || 0) + n;
  return all;
};

async function pollUntil(fn, until, { timeout, interval = 300, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const presenceOf = async (name) => (await (await api.get(`/api/streamers/${name}`)).json()).presence;
  const presenceIs = (name, want, timeout = 5000) => pollUntil(() => presenceOf(name), (p) => p === want, { timeout, label: `${name} is ${want}` });
  const shownIs = (page, selector, want, timeout = 5000) => page.waitForSelector(`${selector}[data-presence="${want}"]`, { timeout });
  const pick = async (page, choice) => {
    await page.click(`label[for="presence-${choice}"]`);
    expect(await page.isChecked(`#presence-${choice}`), `#presence-${choice} is not checked`);
  };
  const openProfile = async (page) => {
    await page.hover('#user-panel');
    await page.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await page.click('#settings');
    await page.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await page.click('#tab-profile');
    await page.waitForSelector('#panel-profile', { timeout: 5000 });
  };
  const openInspectorFromSettings = async (page) => {
    await page.hover('#user-panel');
    await page.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await page.click('#settings');
    await page.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await page.click('#tab-advanced');
    await page.waitForSelector('#inspector-open-settings', { timeout: 15000 });
    await page.click('#inspector-open-settings');
    await page.waitForSelector('#inspector-panel[open]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    await page.waitForSelector('#inspector-panel[open]', { timeout: 5000 });
  };

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const a = await ctxA.newPage();
  const w = await ctxB.newPage();
  let watchCalls = 0;
  w.on('request', (r) => {
    if (r.method() === 'POST' && new RegExp(`/api/streams/${NAME}/watch$`).test(r.url())) watchCalls++;
  });
  const h = await ctxB.newPage();
  let listCalls = 0;
  h.on('request', (r) => {
    if (r.method() === 'GET' && /\/api\/streams(\?|$)/.test(r.url())) listCalls++;
  });
  const card = `#list article a[aria-label="watch ${NAME}"]`;

  await step(`preflight: ${NAME} is offline and not live`, async () => {
    const streams = await (await api.get('/api/streams')).json();
    expect(!streams.some((s) => s.name === NAME), `${NAME} is live already; is another run going?`);
    return `presence ${await presenceOf(NAME)}`;
  });

  await step(`watcher: /watch/${NAME} offline shows the word, asks \`watch\` once, and no player ever shows (push, not poll)`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await shownIs(w, '#presence', 'offline', 15000);
    await w.waitForFunction(() => /not live/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 15000 });
    expect((await w.$$('#video')).length === 0, 'a player is on the page while nobody is live');
    await w.evaluate(() => {
      window.__videoSeen = 0;
      new MutationObserver(() => {
        if (document.querySelector('#video')) window.__videoSeen++;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const before = watchCalls;
    await sleep(12000);
    expect(watchCalls === before, `watch was asked ${watchCalls - before} more times in 12s (the old 5s poll would make 2)`);
    const flashed = await w.evaluate(() => window.__videoSeen);
    expect(flashed === 0, `a player appeared ${flashed} time(s) while nobody is live`);
    return `${watchCalls} call(s) in all, no player`;
  });

  await step(`home: one GET /api/streams on arrival, none in the 6s after (the old poll would make 2), no card for ${NAME}`, async () => {
    await h.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await h.waitForSelector('#list, #empty', { timeout: 15000 });
    await h.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: 15000 });
    const before = listCalls;
    await sleep(6000);
    expect(listCalls === before, `home asked /api/streams ${listCalls - before} more time(s) in 6s`);
    expect((await h.$(card)) === null, `a card for ${NAME} is on home while they are offline`);
    return `${listCalls} call(s) in all`;
  });

  await step(`a tab as ${NAME}: the api says online within 5s, the square is green, the watcher is told`, async () => {
    await a.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await a.hover('#user-panel');
    await a.waitForSelector('#username', { timeout: 15000 });
    await a.fill('#username', NAME);
    await a.press('#username', 'Enter');
    await presenceIs(NAME, 'online');
    await shownIs(a, '#my-presence', 'online');
    const calls = watchCalls;
    await shownIs(w, '#presence', 'online');
    expect(watchCalls === calls, 'the watcher asked `watch` again to learn the word');
    return 'pushed';
  });

  await step('the inspector setting on: the frames are kept from here', async () => {
    await a.hover('#user-panel');
    await a.click('#settings');
    await a.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await a.click('#tab-advanced');
    await a.waitForSelector('#inspector', { timeout: 5000 });
    await a.click('#inspector');
    expect(await a.isChecked('#inspector'), '#inspector is not checked');
    await a.waitForSelector('#inspector-open-settings', { timeout: 5000 });
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
  });

  await step('do not disturb: the api, the square, the watcher, all within 3s, no reload', async () => {
    await openProfile(a);
    await pick(a, 'dnd');
    await presenceIs(NAME, 'dnd', 3000);
    await shownIs(a, '#my-presence', 'dnd', 3000);
    await shownIs(w, '#presence', 'dnd', 3000);
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
  });

  await step(`go live as ${NAME}: streaming on both, the watcher plays on the push, one \`watch\` call`, async () => {
    const calls = watchCalls;
    await a.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await a.waitForFunction(() => !document.querySelector('#start')?.disabled, null, { timeout: 20000 });
    await a.click('#start');
    await a.waitForFunction(() => /^\s*live\b/i.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 20000 });
    await presenceIs(NAME, 'streaming', 5000);
    await shownIs(a, '#my-presence', 'streaming', 5000);
    await shownIs(w, '#presence', 'streaming', 10000);
    for (const [page, sel] of [[a, '#my-presence'], [w, '#presence']]) {
      const bg = await page.$eval(sel, (el) => getComputedStyle(el).backgroundImage);
      expect(/linear-gradient/.test(bg), `${sel} is streaming with no diagonal cut (${bg})`);
    }
    const box = await w.$eval('#presence', (el) => el.getBoundingClientRect().toJSON());
    expect(Math.round(box.width) === 12 && Math.round(box.height) === 12, `#presence is ${box.width}x${box.height}, not 12x12`);
    await w.waitForFunction(() => /^watching$/.test(document.querySelector('#status')?.textContent?.trim() || ''), null, { timeout: 20000 });
    const asked = watchCalls - calls;
    expect(asked >= 1 && asked <= 2, `watch was asked ${asked} times for the start (want 1, at most 2)`);
    return `${asked} watch call(s)`;
  });

  await step(`home: the card for ${NAME} arrives by push, with its ✓ absent and a viewer count, and no new GET /api/streams`, async () => {
    const before = listCalls;
    await h.waitForSelector(card, { timeout: 10000 });
    expect(listCalls === before, `home asked /api/streams again (${before} -> ${listCalls}) to learn of the stream`);
    await h.waitForSelector(`#viewers-${NAME}[data-viewers="1"]`, { timeout: 10000 });
    return `card pushed, ${listCalls} list call(s) in all`;
  });

  await step('stop: the watcher sees ended, the home card goes by push, and the word goes back to do not disturb', async () => {
    const before = listCalls;
    await a.click('#stop');
    await w.waitForFunction(() => /ended/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 15000 });
    await h.waitForSelector(card, { state: 'detached', timeout: 10000 });
    expect(listCalls === before, `home asked /api/streams again (${before} -> ${listCalls}) to learn of the stop`);
    await shownIs(w, '#presence', 'dnd', 5000);
    await presenceIs(NAME, 'dnd', 5000);
  });

  await step('appear offline: the watcher and the api read offline while the tab is open; the chooser still knows', async () => {
    await openProfile(a);
    await pick(a, 'invisible');
    await presenceIs(NAME, 'offline', 3000);
    await shownIs(w, '#presence', 'offline', 3000);
    await shownIs(a, '#my-presence', 'offline', 3000);
    expect(await a.isChecked('#presence-invisible'), 'the card forgot the choice');
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
  });

  await step('the inspector: a me frame, a presence frame, the filter narrows, the chat socket is in it too', async () => {
    await openInspectorFromSettings(a);
    await a.waitForSelector('#inspector-frames li[data-source="/events"][data-type="me"], #inspector-frames li[data-source="/rt"][data-type="me"]', { timeout: 5000 });
    await a.fill('#inspector-filter', 'invisible');
    await a.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#inspector-frames li[data-source]')];
      return rows.length > 0 && rows.every((li) => /invisible/i.test(li.textContent || ''));
    }, null, { timeout: 5000 });
    await a.fill('#inspector-filter', '');
    const count = await a.textContent('#inspector-count');
    expect(/\d+ of the last \d+/.test(count || ''), `count line: ${count}`);
    await a.goto(`${BASE}/watch/${CLAIMED}`, { waitUntil: 'domcontentloaded' });
    await openInspectorFromSettings(a);
    await a.waitForSelector(`#inspector-frames li[data-source="/chat/${CLAIMED}"], #inspector-frames li[data-source="/rt"][data-type="count"]`, { timeout: 15000 });
    await a.click('#inspector-close');
    return count;
  });

  let a2 = null;
  await step('two tabs, one socket: the second tab knows the word at once; locally /online counts one socket', async () => {
    await openProfile(a);
    await pick(a, 'online');
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    await presenceIs(NAME, 'online', 5000);
    a2 = await ctxA.newPage();
    await a2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await shownIs(a2, '#my-presence', 'online', 5000);
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter((t) => t.type === 'shared_worker' && /events|rt\.worker/.test(t.url));
    await cdp.detach();
    expect(workers.length === 2, `${workers.length} events worker(s) for two browsers with three pages (want 2): ${workers.map((t) => t.url).join(', ')}`);
    if (!LOCAL) return `2 workers for 3 pages; /online is on the box`;
    const sockets = online();
    expect(sockets[NAME] === 1, `/online says ${JSON.stringify(sockets)} (want ${NAME}: 1)`);
    return `2 workers, ${NAME}: 1 socket`;
  });

  await step('one of two tabs closes: still online. the last one closes: offline within 5s, at once, not at the ttl', async () => {
    await a.close();
    await sleep(3000);
    expect((await presenceOf(NAME)) === 'online', 'offline after one of two tabs closed');
    await a2.close();
    await presenceIs(NAME, 'offline', 5000);
    await shownIs(w, '#presence', 'offline', 5000);
  });

  await step(`a claimed name (${CLAIMED}) is refused on hello and never online`, async () => {
    const res = await api.post('/api/signup', { data: { name: CLAIMED, password: `a password for ${RUN} 3!` } });
    expect([201, 409].includes(res.status()), `signup got ${res.status()}`);
    const c = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
    await c.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const first = await c.evaluate(
      (name) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/events`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', nick: name }));
          ws.onmessage = (e) => resolve(JSON.parse(e.data));
          ws.onerror = () => resolve({ type: 'error', error: 'socket error' });
          setTimeout(() => resolve({ type: 'timeout' }), 8000);
        }),
      CLAIMED
    );
    expect(first.type === 'error' && /account/.test(first.error), `got ${JSON.stringify(first)}`);
    await sleep(1000);
    expect((await presenceOf(CLAIMED)) === 'offline', `${CLAIMED} reads ${await presenceOf(CLAIMED)}`);
    await c.context().close();
    if (!LOCAL) return `"${first.error}"`;
    expect(compose(`exec -T redis redis-cli exists seen:${CLAIMED}`) === '0', `seen:${CLAIMED} exists`);
    return `"${first.error}", no seen key`;
  });

  await step('local: the seen set has a ttl in (0, 90], and comes back within 35s after a DEL', async () => {
    if (!LOCAL) return { skip: 'redis is on the box' };
    const ctxC = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctxC.newPage();
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.hover('#user-panel');
    await p.waitForSelector('#username', { timeout: 15000 });
    await p.fill('#username', NAME);
    await p.press('#username', 'Enter');
    await presenceIs(NAME, 'online', 5000);
    const ttl = Number(compose(`exec -T redis redis-cli ttl seen:${NAME}`));
    expect(ttl > 0 && ttl <= 90, `ttl ${ttl}`);
    compose(`exec -T redis redis-cli del seen:${NAME}`);
    expect((await presenceOf(NAME)) === 'offline', 'still online right after DEL');
    await presenceIs(NAME, 'online', 35000);
    await ctxC.close();
    await presenceIs(NAME, 'offline', 5000);
    return `ttl ${ttl}, back after the refresh`;
  });

  await browser.close();
  await api.dispose();
  const failed = results.filter((r) => r === 'fail').length;
  const skipped = results.filter((r) => r === 'skip').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed - skipped}/${results.length}${skipped ? `  (${skipped} skipped)` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
