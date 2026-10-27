// The inbox (docs/notifications.md): a login's last 30 things. Nobody gets 401; the settings read all
// on and a switch saves; a follow is a row in the followed login's inbox, once; a go-live over the api
// is one `live` row per follower who keeps it, however many times video says `attached`; a friend's
// line is a `dm` row, the newest line the one unread row, read with the thread; in a browser the bell
// counts, opening the list reads everything (a second tab's bell drops by push), a row pushed into
// the open list is read at once, the settings tab's switch saves; 40 go-lives leave 30 rows.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node notifications.js
const { chromium, request } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const RUN = Date.now().toString(36).slice(-5);
const STAR = 'star' + RUN;
const FAN = 'fan' + RUN;
const PAL = 'pal' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--ignore-certificate-errors'];
const KEEP = 30;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push(true);
    console.log(`PASS  ${name.padEnd(62)} ${String(Date.now() - t0).padStart(6)} ms  ${info || ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name.padEnd(62)} ${String(Date.now() - t0).padStart(6)} ms\n      ${e.message}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const body = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const star = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const fan = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const pal = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const inbox = async (ctx) => (await body(await ctx.get('/api/notifications'))) || { settings: null, items: [] };
  /** A stream over the api, as the page and video would do it: go-live, then `attached` (twice, as video retries), then stop. The session. */
  const streamOnce = async () => {
    const grant = await body(await star.post(`/api/streams/${STAR}/go-live`));
    expect(grant && grant.session && grant.token, `go-live said ${JSON.stringify(grant)}`);
    const q = `session=${grant.session}&token=${grant.token}`;
    for (let i = 0; i < 2; i++) {
      const at = await star.post(`/api/streams/${STAR}/attached?${q}`);
      expect(at.status() === 200, `attached got ${at.status()}: ${JSON.stringify(await body(at))}`);
    }
    const stop = await star.post(`/api/streams/${STAR}/stop?${q}`);
    expect(stop.status() === 200, `stop got ${stop.status()}`);
    return grant.session;
  };
  let liveSession = 0;

  await step('nobody: the list, read and the settings 401; three accounts; the settings read all on, save, and refuse a non-boolean', async () => {
    const list = await anon.get('/api/notifications');
    const read = await anon.put('/api/notifications/read', { data: { id: 1 } });
    const set = await anon.put('/api/notifications/settings', { data: { live: false } });
    expect(list.status() === 401 && read.status() === 401 && set.status() === 401, `nobody got ${list.status()}, ${read.status()}, ${set.status()}`);
    for (const [ctx, name] of [
      [star, STAR],
      [fan, FAN],
      [pal, PAL]
    ]) {
      const up = await ctx.post('/api/signup', { data: { name, password: PW } });
      expect(up.status() === 201, `signup of ${name} got ${up.status()}`);
    }
    const fresh = await inbox(fan);
    expect(
      fresh.settings && fresh.settings.live === true && fresh.settings.follow === true && fresh.settings.dm === true && fresh.items.length === 0,
      `a new account's inbox: ${JSON.stringify(fresh)}`
    );
    const saved = await fan.put('/api/notifications/settings', { data: { dm: false } });
    const kept = await body(saved);
    expect(saved.status() === 200 && kept.live === true && kept.follow === true && kept.dm === false, `saving dm off got ${saved.status()} ${JSON.stringify(kept)}`);
    const again = await inbox(fan);
    expect(again.settings.dm === false && again.settings.live === true, `read back: ${JSON.stringify(again.settings)}`);
    const bad = await fan.put('/api/notifications/settings', { data: { live: 'yes' } });
    expect(bad.status() === 400, `a non-boolean got ${bad.status()}`);
    const back = await body(await fan.put('/api/notifications/settings', { data: {} }));
    expect(back.dm === true && back.live === true && back.follow === true, `an empty save is all on: ${JSON.stringify(back)}`);
    return 'three accounts, settings round-trip';
  });

  await step('a follow is a row in the followed inbox, unread, once: an unfollow and a follow again add none', async () => {
    const follow = await fan.post(`/api/streamers/${STAR}/follow`);
    expect(follow.status() === 204, `fan following star got ${follow.status()}`);
    const { items } = await inbox(star);
    expect(items.length === 1, `star's inbox has ${items.length} rows (want 1): ${JSON.stringify(items)}`);
    const row = items[0];
    expect(
      row.kind === 'follow' && row.name === FAN && row.verified === true && row.read === false && row.text === '' && row.session === null && row.at > 0,
      `the follow row: ${JSON.stringify(row)}`
    );
    await fan.post(`/api/streamers/${STAR}/unfollow`);
    await fan.post(`/api/streamers/${STAR}/follow`);
    const after = await inbox(star);
    expect(after.items.length === 1 && after.items[0].id === row.id, `after unfollow and follow again: ${JSON.stringify(after.items)}`);
    const fansOwn = await inbox(fan);
    expect(fansOwn.items.length === 0, `the follower's own inbox has ${fansOwn.items.length} rows (want 0)`);
    return `row ${row.id} in ${STAR}'s inbox`;
  });

  await step('a go-live is one live row per follower, with the session, however many times attached is called; a stranger gets none', async () => {
    liveSession = await streamOnce();
    const { items } = await inbox(fan);
    const live = items.filter((n) => n.kind === 'live');
    expect(live.length === 1, `fan has ${live.length} live rows (want 1): ${JSON.stringify(items)}`);
    expect(live[0].name === STAR && live[0].session === liveSession && live[0].read === false, `the live row: ${JSON.stringify(live[0])}`);
    const palsInbox = await inbox(pal);
    expect(palsInbox.items.length === 0, `pal, who does not follow star, has ${palsInbox.items.length} rows`);
    return `session ${liveSession}`;
  });

  await step('live switched off keeps no live row for the next go-live, while a follow still lands', async () => {
    const off = await fan.put('/api/notifications/settings', { data: { live: false } });
    expect(off.status() === 200, `switching live off got ${off.status()}`);
    const second = await streamOnce();
    const follow = await pal.post(`/api/streamers/${FAN}/follow`);
    expect(follow.status() === 204, `pal following fan got ${follow.status()}`);
    const { items } = await inbox(fan);
    const live = items.filter((n) => n.kind === 'live');
    expect(live.length === 1 && live[0].session === liveSession, `with live off, fan has ${live.length} live rows, sessions ${JSON.stringify(live.map((n) => n.session))} (want only ${liveSession}, not ${second})`);
    const follows = items.filter((n) => n.kind === 'follow');
    expect(follows.length === 1 && follows[0].name === PAL, `the follow row from pal: ${JSON.stringify(follows)}`);
    const on = await body(await fan.put('/api/notifications/settings', { data: { live: true, follow: true, dm: true } }));
    expect(on.live === true, `switching live back on: ${JSON.stringify(on)}`);
    return `session ${second} left no row`;
  });

  let lastLine = 0;
  await step("a friend's line is a dm row; the next line replaces it (one unread row, the newest words); reading the thread reads it", async () => {
    const back = await fan.post(`/api/streamers/${PAL}/follow`);
    expect(back.status() === 204, `fan following pal got ${back.status()}`);
    const first = await pal.post(`/api/dm/${FAN}`, { data: { text: 'hi fan' } });
    expect(first.status() === 201, `pal's line got ${first.status()}: ${JSON.stringify(await body(first))}`);
    let { items } = await inbox(fan);
    let dms = items.filter((n) => n.kind === 'dm');
    expect(dms.length === 1 && dms[0].name === PAL && dms[0].text === 'hi fan' && dms[0].read === false, `the dm row: ${JSON.stringify(dms)}`);
    const firstId = dms[0].id;
    const second = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: 'are you there' } }));
    lastLine = second.id;
    ({ items } = await inbox(fan));
    dms = items.filter((n) => n.kind === 'dm');
    expect(dms.length === 1 && dms[0].id !== firstId && dms[0].text === 'are you there' && dms[0].read === false, `after a second line: ${JSON.stringify(dms)}`);
    expect(items[0].kind === 'dm', `the newest row is the dm: ${JSON.stringify(items[0])}`);
    // the writer's own inbox: a line of yours is not news, and pal keeps dm rows (fan wrote nothing)
    const read = await fan.put(`/api/dm/${PAL}/read`, { data: { id: lastLine } });
    expect(read.status() === 204, `reading the thread got ${read.status()}`);
    ({ items } = await inbox(fan));
    dms = items.filter((n) => n.kind === 'dm');
    expect(dms.length === 1 && dms[0].read === true, `after reading the thread: ${JSON.stringify(dms)}`);
    return `dm row ${dms[0].id} read with the thread`;
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = async (p, name) => {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', name);
    await p.fill('#auth-password', PW);
    await p.click('#auth-submit');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, name, { timeout: 10000 });
  };
  let page;
  let second;

  await step('the bell counts what is new on two tabs; opening the list reads everything, the api agrees and the other tab drops by push', async () => {
    const before = await inbox(fan);
    const unread = before.items.filter((n) => !n.read).length;
    expect(unread === 2, `fan has ${unread} unread (want 2: the live row and pal's follow): ${JSON.stringify(before.items)}`);
    page = await context.newPage();
    await login(page, FAN);
    await page.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), unread, { timeout: 10000 });
    second = await context.newPage();
    await second.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await second.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), unread, { timeout: 10000 });
    await page.click('#notifications');
    await page.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
    await page.waitForFunction((n) => document.querySelectorAll('#notifications-list [id^="notification-"]').length === n, before.items.length, { timeout: 10000 });
    // every row that was new wears the mark, the read one does not
    const marked = await page.$$eval('#notifications-list [id^="notification-"][data-fresh]', (els) => els.map((e) => e.dataset.kind).sort());
    expect(JSON.stringify(marked) === JSON.stringify(['follow', 'live']), `the marked rows are ${JSON.stringify(marked)}`);
    // the live row is the way to the stream, the follow row to the person's page
    const live = before.items.find((n) => n.kind === 'live');
    const href = await page.getAttribute(`#notification-${live.id}`, 'href');
    expect(href === `/watch/${STAR}`, `the live row links to ${href}`);
    await page.waitForFunction(() => !document.querySelector('#notifications-unread'), null, { timeout: 10000 });
    await second.waitForFunction(() => !document.querySelector('#notifications-unread'), null, { timeout: 10000 });
    const after = await inbox(fan);
    expect(after.items.every((n) => n.read), `the api after opening the list: ${JSON.stringify(after.items.map((n) => [n.kind, n.read]))}`);
    return `${unread} new on both tabs, 0 after one opened the list`;
  });

  await step('a row pushed into the open list is there within 5s, marked, and read at once; escape closes the list', async () => {
    const follow = await star.post(`/api/streamers/${FAN}/follow`);
    expect(follow.status() === 204, `star following fan got ${follow.status()}`);
    await page.waitForFunction((n) => [...document.querySelectorAll('#notifications-list [data-kind="follow"]')].some((e) => e.textContent.includes(n) && e.dataset.fresh), STAR, {
      timeout: 5000
    });
    await sleep(300);
    expect(!(await page.$('#notifications-unread')), 'a row that lands in the open list must not count as new');
    // the other tab counted it for a moment and dropped it on the `notify_read` the open list's read made
    await second.waitForFunction(() => !document.querySelector('#notifications-unread'), null, { timeout: 5000 });
    const { items } = await inbox(fan);
    const row = items.find((n) => n.kind === 'follow' && n.name === STAR);
    expect(row && row.read === true, `the pushed row on the api: ${JSON.stringify(row)}`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#notifications-panel'), null, { timeout: 5000 });
    expect((await page.getAttribute('#notifications', 'aria-expanded')) === 'false', 'the bell says the list is closed');
    return `row ${row.id} pushed and read`;
  });

  await step('the gear in the list opens the notifications tab; a switch saves to the api and back', async () => {
    await page.click('#notifications');
    await page.waitForSelector('#notifications-settings', { timeout: 5000 });
    await page.click('#notifications-settings');
    await page.waitForSelector('#user-modal[open]', { timeout: 5000 });
    expect((await page.getAttribute('#tab-notifications', 'aria-selected')) === 'true', 'the notifications tab is the open one');
    expect(await page.isChecked('#notify-dm'), 'dm reads on');
    await page.click('#notify-dm');
    await page.waitForFunction(() => document.querySelector('#notify-settings-note')?.textContent === 'saved', null, { timeout: 5000 });
    let { settings } = await inbox(fan);
    expect(settings.dm === false && settings.live === true, `after the switch: ${JSON.stringify(settings)}`);
    await page.click('#notify-dm');
    await page.waitForFunction(() => document.querySelector('#notify-dm')?.checked === true, null, { timeout: 5000 });
    await sleep(300);
    ({ settings } = await inbox(fan));
    expect(settings.dm === true, `switched back: ${JSON.stringify(settings)}`);
    await page.click('#user-modal-close');
    await page.waitForFunction(() => !document.querySelector('#user-modal'), null, { timeout: 5000 });
    return 'dm off, then on';
  });

  await step(`${KEEP} are kept: 40 go-lives leave ${KEEP} rows, the newest first`, async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = await streamOnce();
    const { items } = await inbox(fan);
    expect(items.length === KEEP, `fan has ${items.length} rows (want ${KEEP})`);
    expect(items[0].kind === 'live' && items[0].session === last, `the newest row: ${JSON.stringify(items[0])} (want session ${last})`);
    expect(items.every((n) => n.kind === 'live'), `older rows of other kinds should have gone: ${JSON.stringify(items.map((n) => n.kind))}`);
    for (let i = 1; i < items.length; i++) expect(items[i].id < items[i - 1].id, 'newest first');
    // the bell says so too
    await page.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), KEEP, { timeout: 10000 });
    return `${items.length} rows, newest session ${last}`;
  });

  await step('cleanup', async () => {
    await fan.post(`/api/streamers/${STAR}/unfollow`);
    await fan.post(`/api/streamers/${PAL}/unfollow`);
    await pal.post(`/api/streamers/${FAN}/unfollow`);
    await star.post(`/api/streamers/${FAN}/unfollow`);
    await browser.close();
    for (const ctx of [star, fan, pal, anon]) await ctx.dispose();
    return 'unfollowed';
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
