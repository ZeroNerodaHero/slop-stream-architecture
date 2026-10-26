// Presence (docs/status.md, docs/transition.md): a tab open as a name makes it `online` through the
// events socket (one per browser, in a shared worker), the choice (`dnd`, `appear offline`) reaches a
// watcher's page pushed and the api's word agrees, going live is `streaming` on both and stopping
// goes back to the choice, two tabs of one browser share one socket and the last one closing is
// `offline` at once, a claimed name is refused on hello, the watch page waits by push and not by
// poll, and the messages inspector shows the frames. Run through ./scripts/test.sh, or:
// BASE_URL=https://<ip> node presence.js   (LOCAL=1 reads redis and the gateway's /online too)
// The local-only steps say SKIP off-box, not PASS.
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
/** the guest; unclaimed, like r1..r7. */
const NAME = 'r8';
/** a claimed name. not r9: regress.js needs that one free, and a signup is for good. 201 or 409 both do. */
const CLAIMED = 'rp1';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const results = []; // 'pass' | 'fail' | 'skip'
// fn returns a string (shown after PASS) or { skip: 'why' } when it could not check anything
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
/** GET /online on the chat container: no curl in the image, bash's /dev/tcp instead. `{ "<name>": <sockets> }`. */
const online = () => {
  const raw = compose(`exec -T chat bash -c 'exec 3<>/dev/tcp/127.0.0.1/4100; printf "GET /online HTTP/1.0\\r\\n\\r\\n" >&3; cat <&3'`);
  return JSON.parse(raw.slice(raw.indexOf('{')));
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
  /** the word a page shows, read off the dom: `#my-presence` in the corner panel, `#presence` beside a streamer's name. */
  const shownIs = (page, selector, want, timeout = 5000) => page.waitForSelector(`${selector}[data-presence="${want}"]`, { timeout });
  const pick = async (page, choice) => {
    await page.click(`label[for="presence-${choice}"]`);
    expect(await page.isChecked(`#presence-${choice}`), `#presence-${choice} is not checked`);
  };

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
  const a = await ctxA.newPage();
  const w = await ctxB.newPage();
  // every POST /api/streams/<name>/watch the watcher makes: with the socket open, `live` arrives pushed and the poll is the 60s fallback
  let watchCalls = 0;
  w.on('request', (r) => {
    if (r.method() === 'POST' && new RegExp(`/api/streams/${NAME}/watch$`).test(r.url())) watchCalls++;
  });

  await step(`preflight: ${NAME} is offline and not live`, async () => {
    const streams = await (await api.get('/api/streams')).json();
    expect(!streams.some((s) => s.name === NAME), `${NAME} is live already; is another run going?`);
    // a run that died at dnd leaves the choice; the first tab resets it below
    return `presence ${await presenceOf(NAME)}`;
  });

  await step(`watcher: /watch/${NAME} offline shows the word, and asks \`watch\` once in 12s (push, not poll)`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await shownIs(w, '#presence', 'offline', 15000);
    await w.waitForFunction(() => /not live/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 15000 });
    const before = watchCalls;
    await sleep(12000);
    expect(watchCalls === before, `watch was asked ${watchCalls - before} more times in 12s (the old 5s poll would make 2)`);
    return `${watchCalls} call(s) in all`;
  });

  await step(`a tab as ${NAME}: the api says online within 5s, the square is green, the watcher is told`, async () => {
    await a.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await a.hover('#user-panel');
    await a.waitForSelector('#username', { timeout: 15000 });
    await a.fill('#username', NAME);
    await a.press('#username', 'Enter'); // blur: the nick is committed and the socket says hello as it
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
    await a.click('#inspector');
    expect(await a.isChecked('#inspector'), '#inspector is not checked');
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    await a.hover('#user-panel');
    await a.waitForSelector('#inspector-open', { timeout: 5000 });
  });

  await step('do not disturb: the api, the square, the watcher, all within 3s, no reload', async () => {
    await a.click('#you');
    await a.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await pick(a, 'dnd');
    await presenceIs(NAME, 'dnd', 3000);
    await shownIs(a, '#my-presence', 'dnd', 3000);
    await shownIs(w, '#presence', 'dnd', 3000);
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
  });

  await step(`go live as ${NAME}: streaming on both, the watcher plays, a \`watch\` call or two (the push, then video catching up)`, async () => {
    const calls = watchCalls;
    await a.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await a.waitForSelector('#name', { timeout: 15000 });
    await a.fill('#name', NAME);
    await a.waitForFunction(() => !document.querySelector('#start')?.disabled, null, { timeout: 20000 });
    await a.click('#start');
    await a.waitForFunction(() => /^\s*live\b/i.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 20000 });
    await presenceIs(NAME, 'streaming', 5000);
    await shownIs(a, '#my-presence', 'streaming', 5000);
    await shownIs(w, '#presence', 'streaming', 10000);
    await w.waitForFunction(() => /^watching$/.test(document.querySelector('#status')?.textContent?.trim() || ''), null, { timeout: 20000 });
    // the push lands before video has the publisher, so the first grant can say not live and the quick retry asks once more
    const asked = watchCalls - calls;
    expect(asked >= 1 && asked <= 3, `watch was asked ${asked} times for the start (want 1 to 3)`);
    return `${asked} watch call(s)`;
  });

  await step('stop: the watcher sees ended and the word goes back to do not disturb', async () => {
    await a.click('#stop');
    await w.waitForFunction(() => /ended/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 15000 });
    await shownIs(w, '#presence', 'dnd', 5000);
    await presenceIs(NAME, 'dnd', 5000);
  });

  await step('appear offline: the watcher and the api read offline while the tab is open; the chooser still knows', async () => {
    await a.click('#you');
    await a.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await pick(a, 'invisible');
    await presenceIs(NAME, 'offline', 3000);
    await shownIs(w, '#presence', 'offline', 3000);
    await shownIs(a, '#my-presence', 'offline', 3000);
    expect(await a.isChecked('#presence-invisible'), 'the card forgot the choice');
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
  });

  await step('the inspector: a me frame, a presence frame, the filter narrows, the chat socket is in it too', async () => {
    await a.hover('#user-panel');
    await a.click('#inspector-open');
    await a.waitForSelector('#inspector-panel[open]', { timeout: 5000 });
    await a.waitForSelector('#inspector-frames li[data-source="/events"][data-type="me"]', { timeout: 5000 });
    await a.fill('#inspector-filter', 'invisible');
    await a.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#inspector-frames li[data-source]')];
      return rows.length > 0 && rows.every((li) => /invisible/i.test(li.textContent || ''));
    }, null, { timeout: 5000 });
    await a.fill('#inspector-filter', '');
    const count = await a.textContent('#inspector-count');
    expect(/\d+ of the last \d+/.test(count || ''), `count line: ${count}`);
    // the chat's frames ride in too: watching a room as r8 says hello to its chat
    await a.goto(`${BASE}/watch/${CLAIMED}`, { waitUntil: 'domcontentloaded' });
    await a.hover('#user-panel');
    await a.waitForSelector('#inspector-open', { timeout: 15000 });
    await a.click('#inspector-open');
    await a.waitForSelector(`#inspector-frames li[data-source="/chat/${CLAIMED}"]`, { timeout: 15000 });
    await a.click('#inspector-close');
    return count;
  });

  let a2 = null;
  await step('two tabs, one socket: the second tab knows the word at once; locally /online counts one socket', async () => {
    // back to online first: also the reset the next run counts on
    await a.click('#you');
    await a.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await pick(a, 'online');
    await a.keyboard.press('Escape');
    await a.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    await presenceIs(NAME, 'online', 5000);
    a2 = await ctxA.newPage();
    await a2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await shownIs(a2, '#my-presence', 'online', 5000);
    // playwright does not expose shared workers; the browser does, over a raw cdp session
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter((t) => t.type === 'shared_worker' && /events/.test(t.url));
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
    const res = await api.post('/api/signup', { data: { name: CLAIMED, password: `a password for ${RUN}` } });
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
    // its own browser: the watcher's context shares a worker (and a nick) with any page in it, and must stay nobody
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
