// The inbox (docs/notifications.md): a login's last 30 things. Nobody gets 401; the settings read all
// on and a switch saves; a follow is a row in the followed login's inbox, once; a go-live over the api
// is one `live` row per follower who keeps it, however many times video says `attached`; a friend's
// line is a `dm` row, the newest line the one unread row, read with the thread; dm switched off
// keeps that unread row and writes none, and a row already read stays; two lines at once from one
// friend leave one unread row; in a browser the bell counts, opening the list reads everything (a
// second tab's bell drops by push), a row pushed into the open list is read at once, the settings
// tab's switch saves; 40 go-lives leave 30 rows; an inbox GET still in flight across logout and a
// client-side login is not applied as the next account, and opening the list does not mark rows
// it did not show; the tab's inbox GET, held until a switch has saved, leaves that switch off
// and the note still saying saved; a failed inbox GET stays unloaded, a follow pushed after
// it is not the whole list, and opening the bell asks again and lists the older unread rows
// before anything is marked read; a follow that lands while the first inbox GET is in flight
// is in the list when that GET lands; a line that lands while its chat is on screen is read at
// once, and the other tab's bell does not count it; after the sender renames, the next line
// replaces that unread dm on the open tab under the new name, and the bell does not go up;
// a dm that lands while a second inbox GET is in flight stays on the bell and in the list
// when that GET lands. a switch clicked before the inbox GET has applied this login's
// settings does not save the default, so a kind that was off stays off. a line that arrives
// after a friend renames, while that chat is on screen, is in the open log under one tab,
// and the inbox row is read. an older settings PUT, held until a newer save says saved,
// leaves both switches off and the note still saying saved. a read PUT that answers 500
// leaves that row unread, and opening the list again sends it again. a thread GET held
// across logout and a client-side login is not the next account's chat: opening that
// friend shows their lines, and the previous login's line ids are absent. the same hold
// after the renames, with the friend's name from GET /api/me, still opens the next
// login's own lines and asks for them again.
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

  await step('dm switched off keeps the unread row and writes nothing; a row already read stays', async () => {
    const { items: prior } = await inbox(fan);
    const history = prior.filter((n) => n.kind === 'dm' && n.read);
    expect(history.length === 1 && history[0].name === PAL, `the read dm row: ${JSON.stringify(history)}`);
    const historyId = history[0].id;
    const first = await pal.post(`/api/dm/${FAN}`, { data: { text: 'remember this' } });
    expect(first.status() === 201, `pal's line got ${first.status()}: ${JSON.stringify(await body(first))}`);
    let { items } = await inbox(fan);
    let unread = items.filter((n) => n.kind === 'dm' && !n.read);
    expect(unread.length === 1 && unread[0].text === 'remember this' && unread[0].id !== historyId, `the unread dm row: ${JSON.stringify(unread)}`);
    const keptId = unread[0].id;
    const off = await fan.put('/api/notifications/settings', { data: { dm: false } });
    expect(off.status() === 200, `switching dm off got ${off.status()}`);
    const second = await pal.post(`/api/dm/${FAN}`, { data: { text: 'should not erase the row' } });
    const line = await body(second);
    expect(second.status() === 201, `a line while dm is off got ${second.status()}: ${JSON.stringify(line)}`);
    ({ items } = await inbox(fan));
    const dms = items.filter((n) => n.kind === 'dm');
    const kept = dms.find((n) => n.id === keptId);
    expect(kept && kept.read === false && kept.text === 'remember this', `the unread row after a line while dm is off: ${JSON.stringify(dms)}`);
    expect(!dms.some((n) => n.text === 'should not erase the row'), `a new dm row was written: ${JSON.stringify(dms)}`);
    const still = dms.find((n) => n.id === historyId);
    expect(still && still.read === true, `the row already read: ${JSON.stringify(still)}`);
    const on = await body(await fan.put('/api/notifications/settings', { data: { live: true, follow: true, dm: true } }));
    expect(on.dm === true && on.live === true && on.follow === true, `switching dm back on: ${JSON.stringify(on)}`);
    const read = await fan.put(`/api/dm/${PAL}/read`, { data: { id: line.id } });
    expect(read.status() === 204, `reading the thread got ${read.status()}`);
    ({ items } = await inbox(fan));
    const stillUnread = items.filter((n) => !n.read);
    expect(stillUnread.length === 2 && stillUnread.every((n) => n.kind !== 'dm'), `unread left for the bell: ${JSON.stringify(stillUnread)}`);
    return `row ${keptId} stayed while dm was off`;
  });

  await step('two lines at once from one friend leave one unread dm row', async () => {
    const [a, b] = await Promise.all([
      pal.post(`/api/dm/${FAN}`, { data: { text: 'at once a' } }),
      pal.post(`/api/dm/${FAN}`, { data: { text: 'at once b' } })
    ]);
    const aLine = await body(a);
    const bLine = await body(b);
    expect(a.status() === 201 && b.status() === 201, `two lines got ${a.status()} ${JSON.stringify(aLine)} and ${b.status()} ${JSON.stringify(bLine)}`);
    const { items } = await inbox(fan);
    const unreadDm = items.filter((n) => n.kind === 'dm' && !n.read);
    expect(
      unreadDm.length === 1 && unreadDm[0].name === PAL && (unreadDm[0].text === 'at once a' || unreadDm[0].text === 'at once b'),
      `one unread dm from ${PAL}: ${JSON.stringify(unreadDm)}`
    );
    const lineId = Math.max(aLine.id, bLine.id);
    const read = await fan.put(`/api/dm/${PAL}/read`, { data: { id: lineId } });
    expect(read.status() === 204, `reading the thread got ${read.status()}`);
    const settled = await inbox(fan);
    const stillUnread = settled.items.filter((n) => !n.read);
    expect(stillUnread.length === 2 && stillUnread.every((n) => n.kind !== 'dm'), `unread left for the bell: ${JSON.stringify(stillUnread)}`);
    expect(settled.settings.dm === true, `dm stays on: ${JSON.stringify(settled.settings)}`);
    return `row ${unreadDm[0].id} was the one unread line`;
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

  await step("a held inbox stays with the login that asked; after logout and a client-side login the panel lists that account's rows, and opening it marks none it did not show", async () => {
    // its own page, closed at the end: `page` stays fan, and the `fan` request context keeps its cookie
    const mine = await inbox(star);
    const theirs = await inbox(fan);
    const starRow = mine.items.find((n) => n.kind === 'follow' && n.name === FAN && !n.read);
    const fanNewest = theirs.items[0];
    const unread = mine.items.filter((n) => !n.read).length;
    expect(starRow && fanNewest && fanNewest.id >= starRow.id, `star's follow and fan's newest must be able to overlap a leaked read: ${JSON.stringify(starRow)} / ${JSON.stringify(fanNewest)}`);
    expect(unread >= 1 && theirs.items.filter((n) => !n.read).length > unread, `the two inboxes are not distinct: star ${unread}, fan ${JSON.stringify(theirs.items.map((n) => [n.kind, n.read]))}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let inboxGets = 0;
    let holding = false;
    let heldStatus = 0;
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let readSettled = false;
    try {
      // the first inbox GET (this login) stays unanswered across logout and the next login on this same page
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        inboxGets += 1;
        if (!holding) {
          holding = true;
          const response = await route.fetch();
          heldStatus = response.status();
          await gate;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await p.route(/\/api\/notifications\/read$/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response });
        readSettled = true;
      });
      await login(p, FAN);
      const untilHeld = Date.now() + 10000;
      while (heldStatus === 0) {
        if (Date.now() > untilHeld) throw new Error('the first login sent no inbox GET');
        await sleep(50);
      }
      expect(heldStatus === 200, `the held inbox GET got ${heldStatus}`);
      const atSwitch = inboxGets;
      await p.evaluate(() => {
        window.__inboxPage = 1;
      });
      await p.hover('#user-panel');
      await p.waitForSelector('#logout', { timeout: 10000 });
      await p.click('#logout');
      await p.hover('#user-panel');
      await p.waitForSelector('#login-link', { timeout: 10000 });
      await p.click('#login-link');
      await p.waitForSelector('#auth-name', { timeout: 10000 });
      await p.fill('#auth-name', STAR);
      await p.fill('#auth-password', PW);
      await p.click('#auth-submit');
      await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, STAR, { timeout: 10000 });
      expect((await p.evaluate(() => window.__inboxPage)) === 1, 'the second login reloaded the page');
      const untilNext = Date.now() + 10000;
      while (inboxGets <= atSwitch) {
        if (Date.now() > untilNext) throw new Error(`the next login sent no inbox GET of its own (${inboxGets} total)`);
        await sleep(50);
      }
      await p.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), unread, { timeout: 10000 });
      release();
      await sleep(300);
      const bell = await p.textContent('#notifications-unread');
      expect(bell === String(unread), `after the held inbox arrived the bell says ${bell} (want ${unread})`);
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      await p.waitForSelector('#notifications-list [id^="notification-"]', { timeout: 10000 });
      const shown = await p.$$eval('#notifications-list [id^="notification-"]', (els) =>
        els.map((e) => ({ id: Number(e.id.replace('notification-', '')), kind: e.dataset.kind, text: e.textContent || '' }))
      );
      const ids = new Set(mine.items.map((n) => n.id));
      expect(
        shown.length === mine.items.length && shown.every((r) => ids.has(r.id)),
        `the panel listed ${JSON.stringify(shown)} (want ${STAR}'s rows ${JSON.stringify([...ids])})`
      );
      expect(
        shown.some((r) => r.kind === 'follow' && r.text.includes(FAN) && r.text.includes('followed you')),
        `the panel does not list ${FAN}'s follow: ${JSON.stringify(shown)}`
      );
      expect(!shown.some((r) => r.kind === 'live'), `the previous login's live rows are on the panel: ${JSON.stringify(shown)}`);
      const untilRead = Date.now() + 10000;
      while (!readSettled) {
        if (Date.now() > untilRead) throw new Error('opening the list sent no read');
        await sleep(50);
      }
      const after = await inbox(star);
      const shownIds = new Set(shown.map((r) => r.id));
      const marked = after.items.filter((n) => {
        if (shownIds.has(n.id)) return false;
        const prior = mine.items.find((b) => b.id === n.id);
        return prior && !prior.read && n.read;
      });
      expect(marked.length === 0, `opening marked rows the panel did not show: ${JSON.stringify(marked)}`);
      return `${FAN}'s inbox held across login as ${STAR}; the panel listed ${shown.map((r) => r.id).join(',')}`;
    } finally {
      release();
      await p.close();
      await ctx.close();
    }
  });

  await step("the tab's inbox GET, held until a switch has saved, leaves the switch off and the note saved", async () => {
    // its own page, closed at the end: `page` stays logged in as fan. dm is turned back on through the api before this returns
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let arm = false;
    let holding = false;
    let snapshotted = false;
    let turnedOff = false;
    try {
      await login(p, FAN);
      // the login's inbox GET has landed (the bell has the rows). the next GET is the tab's, and it is the one held
      await p.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), KEEP, { timeout: 10000 });
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET' || !arm || holding) {
          await route.continue();
          return;
        }
        holding = true;
        const response = await route.fetch();
        snapshotted = true;
        await gate;
        await route.fulfill({ response });
      });
      await p.click('#notifications');
      await p.waitForSelector('#notifications-settings', { timeout: 5000 });
      arm = true;
      await p.click('#notifications-settings');
      await p.waitForSelector('#user-modal[open]', { timeout: 5000 });
      expect((await p.getAttribute('#tab-notifications', 'aria-selected')) === 'true', 'the notifications tab is the open one');
      const untilSnap = Date.now() + 10000;
      while (!snapshotted) {
        if (Date.now() > untilSnap) throw new Error('the notifications tab sent no inbox GET');
        await sleep(50);
      }
      expect(await p.isChecked('#notify-dm'), 'dm reads on');
      turnedOff = true;
      await p.click('#notify-dm');
      await p.waitForFunction(() => document.querySelector('#notify-settings-note')?.textContent === 'saved', null, { timeout: 5000 });
      expect((await p.isChecked('#notify-dm')) === false, 'dm reads off once saved');
      const { settings } = await inbox(fan);
      expect(settings.dm === false, `the api after the switch: ${JSON.stringify(settings)}`);
      release();
      // the held document was fetched before the click, so it still says dm on. long enough for it to have been applied
      await sleep(300);
      expect((await p.isChecked('#notify-dm')) === false, 'dm stays off after the held inbox GET');
      const note = await p.textContent('#notify-settings-note');
      expect(note === 'saved', `the note after the held inbox GET: ${JSON.stringify(note)}`);
      return 'switch stayed off, note saved';
    } finally {
      release();
      try {
        if (turnedOff) {
          const back = await body(await fan.put('/api/notifications/settings', { data: { dm: true } }));
          expect(back && back.dm === true && back.live === true && back.follow === true, `dm back on: ${JSON.stringify(back)}`);
        }
      } finally {
        await p.close();
        await ctx.close();
      }
    }
  });

  await step('a failed inbox GET stays unloaded: a pushed follow is not the list, and opening asks again before anything is marked read', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. the inbox here is the 30 live rows, all read
    // (the tab step opened the list). two go-lives are the older unread rows. star already follows fan and that
    // row was clipped, so unfollow and follow again is the push, and star is left following for cleanup
    const sessions = [];
    for (let i = 0; i < 2; i++) sessions.push(await streamOnce());
    const prior = await inbox(fan);
    const older = prior.items.filter((n) => n.kind === 'live' && sessions.includes(n.session));
    expect(older.length === 2 && older.every((n) => !n.read), `the older unread rows: ${JSON.stringify(older)}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let gets = 0;
    let failedOnce = false;
    let reads = 0;
    let releaseFail = () => {};
    const failGate = new Promise((resolve) => {
      releaseFail = resolve;
    });
    try {
      // the first inbox GET stays unanswered while the events socket is made again on login, so that
      // reconnect joins this ask instead of loading the list. then it is a 500, once
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        gets += 1;
        if (!failedOnce) {
          failedOnce = true;
          await failGate;
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) });
          return;
        }
        await route.continue();
      });
      await p.route(/\/api\/notifications\/read$/, async (route) => {
        reads += 1;
        await route.continue();
      });
      await login(p, FAN);
      const untilFail = Date.now() + 10000;
      while (!failedOnce) {
        if (Date.now() > untilFail) throw new Error('login sent no inbox GET');
        await sleep(50);
      }
      await sleep(1000);
      releaseFail();
      await sleep(300);
      expect(gets === 1, `inbox GETs before the push: ${gets}`);
      const off = await star.post(`/api/streamers/${FAN}/unfollow`);
      expect(off.status() === 204, `unfollow got ${off.status()}`);
      const follow = await star.post(`/api/streamers/${FAN}/follow`);
      expect(follow.status() === 204, `star following fan got ${follow.status()}`);
      // long enough for the frame to have been applied, the way a row pushed into the open list shows up
      await sleep(1000);
      const pushed = await inbox(fan);
      const followRow = pushed.items.find((n) => n.kind === 'follow' && n.name === STAR && !n.read);
      expect(followRow, `the pushed follow: ${JSON.stringify(pushed.items.filter((n) => n.kind === 'follow'))}`);
      const still = pushed.items.filter((n) => older.some((o) => o.id === n.id));
      expect(still.length === 2 && still.every((n) => !n.read), `the older rows after the push: ${JSON.stringify(still)}`);
      expect(reads === 0, `a read PUT landed before the bell was opened (${reads})`);
      expect(!(await p.$('#notifications-unread')), 'the bell counted a list that was never loaded');
      const getsBeforeOpen = gets;
      const wantOlder = older.map((n) => n.id);
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      let listed = false;
      let readTooSoon = false;
      let lastIds = [];
      const untilShown = Date.now() + 10000;
      while (Date.now() < untilShown) {
        lastIds = await p.$$eval('#notifications-list [id^="notification-"]', (els) => els.map((e) => Number(e.id.replace('notification-', ''))));
        let hasOlder = wantOlder.every((id) => lastIds.includes(id));
        if (reads > 0 && lastIds.length > 0 && !hasOlder) {
          await sleep(50);
          lastIds = await p.$$eval('#notifications-list [id^="notification-"]', (els) => els.map((e) => Number(e.id.replace('notification-', ''))));
          hasOlder = wantOlder.every((id) => lastIds.includes(id));
          if (!hasOlder) readTooSoon = true;
        }
        if (readTooSoon) break;
        if (hasOlder && lastIds.includes(followRow.id)) {
          listed = true;
          break;
        }
        await sleep(50);
      }
      expect(!readTooSoon, `a read PUT landed while the panel showed ${JSON.stringify(lastIds)} and not the older rows ${JSON.stringify(wantOlder)}`);
      expect(listed, `the panel listed ${JSON.stringify(lastIds)} (want ${JSON.stringify([...wantOlder, followRow.id])})`);
      expect(gets > getsBeforeOpen, `opening the list sent no inbox GET (${gets} total)`);
      return `older rows ${wantOlder.join(',')} listed after a failed GET`;
    } finally {
      releaseFail();
      await p.close();
      await ctx.close();
    }
  });

  await step('a follow that lands while the first inbox GET is in flight is in the list when that GET lands', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. pal already follows fan and that
    // row was clipped by the 40 go-lives, so unfollow and follow again is a new row, and pal is left
    // following. the follow is sent only after the login's inbox GET has been fetched, and the body
    // is applied only after that frame has had time to arrive
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let gets = 0;
    let holding = false;
    let fetched = 0;
    let needFollow = false;
    try {
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        gets += 1;
        if (holding) {
          await route.continue();
          return;
        }
        holding = true;
        const response = await route.fetch();
        fetched = response.status();
        await gate;
        await route.fulfill({ response });
      });
      await login(p, FAN);
      const untilFetched = Date.now() + 10000;
      while (!fetched) {
        if (Date.now() > untilFetched) throw new Error('login sent no inbox GET');
        await sleep(50);
      }
      expect(fetched === 200, `the held inbox GET got ${fetched}`);
      await p.waitForSelector('#my-presence[data-presence="online"]', { timeout: 10000 });
      const prior = new Set((await inbox(fan)).items.map((n) => n.id));
      const off = await pal.post(`/api/streamers/${FAN}/unfollow`);
      expect(off.status() === 204, `unfollow got ${off.status()}`);
      needFollow = true;
      const follow = await pal.post(`/api/streamers/${FAN}/follow`);
      expect(follow.status() === 204, `pal following fan got ${follow.status()}`);
      needFollow = false;
      let row = null;
      const untilRow = Date.now() + 10000;
      while (!row) {
        if (Date.now() > untilRow) throw new Error(`pal's follow wrote no new row: ${JSON.stringify((await inbox(fan)).items.filter((n) => n.kind === 'follow'))}`);
        const { items } = await inbox(fan);
        row = items.find((n) => n.kind === 'follow' && n.name === PAL && !n.read && !prior.has(n.id));
        if (!row) await sleep(50);
      }
      // long enough for the frame to arrive while the list is still unloaded. a frame that landed
      // after the body was applied would show up either way
      await sleep(1000);
      const during = await inbox(fan);
      const still = during.items.find((n) => n.id === row.id);
      expect(still && still.read === false, `the follow was marked read while the list was loading: ${JSON.stringify(still)}`);
      expect(!(await p.$('#notifications-unread')), 'the bell counted a list that was still loading');
      expect(gets === 1, `inbox GETs while the first was held: ${gets}`);
      release();
      const untilBell = Date.now() + 10000;
      while (!(await p.$('#notifications-unread'))) {
        if (Date.now() > untilBell) break;
        await sleep(50);
      }
      const getsBeforeOpen = gets;
      expect(getsBeforeOpen === 1, `inbox GETs before the list was opened: ${gets}`);
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      let listed = false;
      let lastText = '';
      const untilShown = Date.now() + 10000;
      while (Date.now() < untilShown) {
        const el = await p.$(`#notification-${row.id}[data-kind="follow"]`);
        if (el) {
          lastText = (await el.textContent()) || '';
          if (lastText.includes(PAL) && lastText.includes('followed you')) {
            listed = true;
            break;
          }
        }
        await sleep(50);
      }
      expect(listed, `the panel does not list follow ${row.id} from ${PAL}: ${JSON.stringify(lastText)}`);
      expect(gets === getsBeforeOpen, `opening the list sent another inbox GET (${gets})`);
      return `follow ${row.id} listed`;
    } finally {
      release();
      if (needFollow) await pal.post(`/api/streamers/${FAN}/follow`);
      await p.close();
      await ctx.close();
    }
  });

  await step("a line that arrives while its chat is on screen is read, and the other tab's bell does not count it", async () => {
    // its own pages, closed at the end: `page` stays logged in as fan. the inbox is whatever the
    // steps above left (not empty). a read dm row left here is the point; nothing else is marked read
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    const other = await ctx.newPage();
    const bell = async (pg) => {
      const el = await pg.$('#notifications-unread');
      return el ? (await el.textContent()) || '' : '';
    };
    try {
      await login(p, FAN);
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-${PAL}`, { state: 'visible', timeout: 10000 });
      await p.click(`#friend-chat-${PAL}`);
      await p.mouse.move(700, 300);
      await p.waitForSelector('#friend-chat', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-tab-${PAL}[aria-selected="true"]`, { timeout: 10000 });
      await p.waitForFunction(() => document.querySelectorAll('#friend-chat-log p[data-id]').length > 0, null, { timeout: 10000 });
      const visible = await p.evaluate(() => document.visibilityState);
      expect(visible === 'visible', `visibility is ${visible}`);
      expect(!(await p.$(`#friend-chat-unread-${PAL}`)), 'the open thread already counts a line as new');
      await other.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await other.waitForFunction((n) => document.querySelector('#me')?.textContent === n, FAN, { timeout: 10000 });
      let unreadBefore = -1;
      let shown = ['', ''];
      const untilBells = Date.now() + 10000;
      while (Date.now() < untilBells) {
        const { items } = await inbox(fan);
        unreadBefore = items.filter((n) => !n.read).length;
        const want = unreadBefore === 0 ? '' : String(unreadBefore);
        shown = [await bell(p), await bell(other)];
        if (shown[0] === want && shown[1] === want) break;
        await sleep(50);
      }
      const wantBefore = unreadBefore === 0 ? '' : String(unreadBefore);
      expect(
        shown[0] === wantBefore && shown[1] === wantBefore,
        `bells before the line: ${JSON.stringify(shown)} (want ${JSON.stringify(wantBefore)}, ${unreadBefore} unread)`
      );
      // the other tab can leave this one in the background; the line has to arrive while it is showing
      await p.bringToFront();
      const visibleNow = await p.evaluate(() => document.visibilityState);
      expect(visibleNow === 'visible', `visibility is ${visibleNow}`);
      expect(!(await p.$(`#friend-chat-unread-${PAL}`)), 'the open thread counted a line as new while the bells settled');
      const text = 'while you watch';
      const sent = await body(await pal.post(`/api/dm/${FAN}`, { data: { text } }));
      expect(sent && sent.id, `pal's line: ${JSON.stringify(sent)}`);
      await p.waitForSelector(`#friend-chat-log p[data-id="${sent.id}"]`, { timeout: 10000 });
      expect(!(await p.$(`#friend-chat-unread-${PAL}`)), 'a line on screen counted as new');
      let row = null;
      const untilRead = Date.now() + 5000;
      while (Date.now() < untilRead) {
        const { items } = await inbox(fan);
        row = items.find((n) => n.kind === 'dm' && n.name === PAL && n.text === text);
        if (row && row.read === true) break;
        await sleep(50);
      }
      expect(row && row.read === true, `the dm on the api: ${JSON.stringify(row)}`);
      const after = await inbox(fan);
      const still = after.items.find((n) => n.id === row.id);
      expect(still && still.read === true, `the dm row after it was read: ${JSON.stringify(still)}`);
      const unread = after.items.filter((n) => !n.read).length;
      const want = unread === 0 ? '' : String(unread);
      const untilOther = Date.now() + 5000;
      let otherBell = await bell(other);
      while (otherBell !== want && Date.now() < untilOther) {
        await sleep(50);
        otherBell = await bell(other);
      }
      expect(otherBell === want, `the other tab's bell says ${JSON.stringify(otherBell)} (want ${JSON.stringify(want)}; the dm is read)`);
      const here = await bell(p);
      expect(here === want, `this tab's bell says ${JSON.stringify(here)} (want ${JSON.stringify(want)})`);
      return `line ${sent.id} read while the chat was open`;
    } finally {
      await other.close();
      await p.close();
      await ctx.close();
    }
  });

  await step("a held thread, released after logout and a client-side login, is not the next account's open chat", async () => {
    // before either rename, so pal and star still wear the names this file signed them up with.
    // its own page, closed at the end: `page` stays logged in as fan. star and pal are friends
    // only for this step, and that is undone before return, so the rename steps still see them apart
    const aText = `secret-for-${FAN}-only`;
    const bText = `${STAR} can see this`;
    const starFollows = await star.post(`/api/streamers/${PAL}/follow`);
    expect(starFollows.status() === 204, `star following pal got ${starFollows.status()}`);
    const palFollows = await pal.post(`/api/streamers/${STAR}/follow`);
    expect(palFollows.status() === 204, `pal following star got ${palFollows.status()}`);
    let linked = true;
    const aSent = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: aText } }));
    const bSent = await body(await pal.post(`/api/dm/${STAR}`, { data: { text: bText } }));
    expect(aSent && aSent.id && bSent && bSent.id && aSent.id !== bSent.id, `the two lines: ${JSON.stringify(aSent)} and ${JSON.stringify(bSent)}`);
    const aThread = await body(await fan.get(`/api/dm/${PAL}`));
    const bThread = await body(await star.get(`/api/dm/${PAL}`));
    const aIds = new Set((aThread?.lines || []).map((l) => String(l.id)));
    const bIds = new Set((bThread?.lines || []).map((l) => String(l.id)));
    expect(aIds.has(String(aSent.id)) && bIds.has(String(bSent.id)), `threads: ${JSON.stringify(aThread?.lines)} / ${JSON.stringify(bThread?.lines)}`);
    expect(!bIds.has(String(aSent.id)) && ![...aIds].some((id) => bIds.has(id)), `the threads share a line: ${JSON.stringify([...aIds].filter((id) => bIds.has(id)))}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = false;
    let held = 0;
    let gets = 0;
    const openFriend = async (name) => {
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-${name}`, { state: 'visible', timeout: 10000 });
      await p.click(`#friend-chat-${name}`);
      await p.mouse.move(700, 300);
      await p.waitForSelector('#friend-chat', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-tab-${name}[aria-selected="true"]`, { timeout: 10000 });
    };
    try {
      await login(p, FAN);
      await p.evaluate(() => {
        window.__threadPage = 1;
      });
      // fan's thread GET stays unanswered across logout and star's login on this same page
      await p.route(new RegExp(`/api/dm/${PAL}$`), async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        gets += 1;
        if (!holding) {
          holding = true;
          const response = await route.fetch();
          held = response.status();
          await gate;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await openFriend(PAL);
      const untilHeld = Date.now() + 10000;
      while (!held) {
        if (Date.now() > untilHeld) throw new Error(`opening ${PAL}'s chat sent no thread GET`);
        await sleep(50);
      }
      expect(held === 200, `the held thread GET got ${held}`);
      expect(gets === 1, `thread GETs while ${FAN} was opening: ${gets}`);
      await p.hover('#user-panel');
      await p.waitForSelector('#logout', { timeout: 10000 });
      await p.click('#logout');
      await p.hover('#user-panel');
      await p.waitForSelector('#login-link', { timeout: 10000 });
      await p.click('#login-link');
      await p.waitForSelector('#auth-name', { timeout: 10000 });
      await p.fill('#auth-name', STAR);
      await p.fill('#auth-password', PW);
      await p.click('#auth-submit');
      await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, STAR, { timeout: 10000 });
      expect((await p.evaluate(() => window.__threadPage)) === 1, 'the second login reloaded the page');
      expect(gets === 1, `the next login fetched the thread before the held body was released (${gets})`);
      release();
      // long enough for the held page to have been applied, if it were still this login's
      await sleep(300);
      expect(gets === 1, `releasing the held thread GET sent another (${gets})`);
      await openFriend(PAL);
      let ids = [];
      const untilLines = Date.now() + 10000;
      while (Date.now() < untilLines) {
        ids = await p.$$eval('#friend-chat-log p[data-id]', (els) => els.map((e) => e.getAttribute('data-id')));
        if (ids.includes(String(bSent.id)) || ids.some((id) => aIds.has(id))) break;
        await sleep(50);
      }
      const me = await p.textContent('#me');
      const withName = await p.getAttribute('#friend-chat', 'data-with');
      expect(me === STAR && withName === PAL, `the open chat is ${JSON.stringify(withName)} while #me is ${JSON.stringify(me)}`);
      expect(ids.includes(String(bSent.id)), `${STAR}'s line ${bSent.id} is not in the log: ${JSON.stringify(ids)}`);
      expect(!ids.some((id) => aIds.has(id)), `${FAN}'s line ids are in the log: ${JSON.stringify(ids)}`);
      const log = await p.textContent('#friend-chat-log');
      expect(log.includes(bText) && !log.includes(aText), `the log text: ${JSON.stringify(log)}`);
      expect(gets === 2, `opening as ${STAR} sent no thread GET of their own (${gets})`);
      return `${FAN}'s line ${aSent.id} held across login as ${STAR}; the log is ${bSent.id}`;
    } finally {
      release();
      try {
        if (linked) {
          const undoStar = await star.post(`/api/streamers/${PAL}/unfollow`);
          const undoPal = await pal.post(`/api/streamers/${STAR}/unfollow`);
          expect(undoStar.status() === 204 && undoPal.status() === 204, `unfollowing got ${undoStar.status()} and ${undoPal.status()}`);
        }
      } finally {
        await p.close();
        await ctx.close();
      }
    }
  });

  await step('after a friend renames, the next line stays one unread dm under the new name and the bell does not go up', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. the inbox already holds the
    // rows the steps above left, so the bell is not 1. one unread dm from pal is loaded with it.
    // pal renames once (a name changes only every 30 days) and writes again. the old line goes.
    const firstText = 'before rename';
    const secondText = 'after rename';
    const renamed = 'px' + RUN;
    const first = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: firstText } }));
    expect(first && first.id, `pal's line: ${JSON.stringify(first)}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    const bell = async () => {
      const el = await p.$('#notifications-unread');
      return el ? (await el.textContent()) || '' : '';
    };
    try {
      await login(p, FAN);
      const loaded = await inbox(fan);
      const unreadDm = loaded.items.filter((n) => n.kind === 'dm' && !n.read);
      expect(unreadDm.length === 1 && unreadDm[0].name === PAL && unreadDm[0].text === firstText, `the loaded unread dm: ${JSON.stringify(unreadDm)}`);
      const unread = loaded.items.filter((n) => !n.read).length;
      const want = String(unread);
      await p.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === n, want, { timeout: 10000 });
      // the socket is who delivers the next frame onto this loaded list
      await p.waitForSelector('#my-presence[data-presence="online"]', { timeout: 10000 });
      const bellBefore = await bell();
      expect(bellBefore === want, `bell before the rename: ${JSON.stringify(bellBefore)} (want ${JSON.stringify(want)})`);
      const nameRes = await pal.post('/api/name', { data: { name: renamed, password: PW } });
      const nameBody = await body(nameRes);
      expect(nameRes.status() === 200 && nameBody && nameBody.name === renamed, `rename got ${nameRes.status()} ${JSON.stringify(nameBody)}`);
      const again = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: secondText } }));
      expect(again && again.id && again.id !== first.id, `pal's line after the rename: ${JSON.stringify(again)}`);
      const untilBell = Date.now() + 3000;
      let bellAfter = await bell();
      while (Date.now() < untilBell) {
        bellAfter = await bell();
        if (bellAfter !== bellBefore) break;
        await sleep(50);
      }
      expect(bellAfter === bellBefore, `the bell went from ${JSON.stringify(bellBefore)} to ${JSON.stringify(bellAfter)}`);
      const after = await inbox(fan);
      const apiUnreadDm = after.items.filter((n) => n.kind === 'dm' && !n.read);
      expect(
        apiUnreadDm.length === 1 && apiUnreadDm[0].name === renamed && apiUnreadDm[0].text === secondText,
        `unread dms on the api: ${JSON.stringify(apiUnreadDm)}`
      );
      expect(!after.items.some((n) => n.text === firstText), `the old line is still in the inbox: ${JSON.stringify(after.items.filter((n) => n.kind === 'dm'))}`);
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      let shown = [];
      const untilRows = Date.now() + 5000;
      while (Date.now() < untilRows) {
        shown = await p.$$eval('#notifications-list [data-kind="dm"]', (els) => els.map((e) => ({ fresh: e.hasAttribute('data-fresh'), text: e.textContent || '' })));
        const fresh = shown.filter((r) => r.fresh);
        const one = fresh.length === 1 && fresh[0].text.includes(renamed) && fresh[0].text.includes(secondText);
        const gone = !shown.some((r) => r.text.includes(firstText) || r.text.includes(PAL));
        if (one && gone) break;
        await sleep(50);
      }
      const fresh = shown.filter((r) => r.fresh);
      expect(
        fresh.length === 1 && fresh[0].text.includes(renamed) && fresh[0].text.includes(secondText) && !fresh[0].text.includes(firstText),
        `unread dm rows: ${JSON.stringify(shown)}`
      );
      expect(!shown.some((r) => r.text.includes(firstText)), `the old line is still on screen: ${JSON.stringify(shown)}`);
      expect(shown.every((r) => !r.text.includes(PAL)), `a dm row still shows ${PAL}: ${JSON.stringify(shown)}`);
      return `bell stayed ${bellBefore}; ${renamed} once`;
    } finally {
      await p.close();
      await ctx.close();
    }
  });

  await step('a dm that lands while a second inbox GET is in flight stays on the bell and in the list', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. the inbox is already loaded.
    // the login's rows are read first, so the snapshot the notifications tab fetches has nothing
    // new: the line is the one the bell counts, and that snapshot applied alone would clear it.
    // pal may have been renamed; the row wears the name the api has now
    const who = await body(await pal.get('/api/me'));
    expect(who && who.name, `pal's name: ${JSON.stringify(who)}`);
    const palName = who.name;
    // the steps above leave the inbox read. opening the list marks whatever is unread, so this
    // step needs one unread row of its own first. pal may already have been renamed.
    const seeded = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: `unread from ${palName}` } }));
    expect(seeded && seeded.id, `a line from ${palName}: ${JSON.stringify(seeded)}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    const bell = async () => {
      const el = await p.$('#notifications-unread');
      return el ? (await el.textContent()) || '' : '';
    };
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let arm = false;
    let holding = false;
    let fetched = 0;
    let gets = 0;
    try {
      await login(p, FAN);
      await p.waitForSelector('#my-presence[data-presence="online"]', { timeout: 10000 });
      const loaded = await inbox(fan);
      const unread = loaded.items.filter((n) => !n.read).length;
      expect(unread >= 1, `fan has nothing unread, so the bell cannot show the inbox loaded: ${JSON.stringify(loaded.items.map((n) => [n.kind, n.read]))}`);
      await p.waitForFunction((n) => document.querySelector('#notifications-unread')?.textContent === String(n), unread, { timeout: 10000 });
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      await p.waitForFunction(() => !document.querySelector('#notifications-unread'), null, { timeout: 10000 });
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('#notifications-panel'), null, { timeout: 5000 });
      let cleared = false;
      const untilClear = Date.now() + 10000;
      while (!cleared) {
        if (Date.now() > untilClear) throw new Error('the inbox did not read');
        cleared = (await inbox(fan)).items.every((n) => n.read);
        if (!cleared) await sleep(50);
      }
      expect((await bell()) === '', `the bell still counts after the list was read: ${JSON.stringify(await bell())}`);
      // the next GET is the tab's, held until the line has been pushed onto the loaded list
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET' || !arm) {
          await route.continue();
          return;
        }
        gets += 1;
        if (holding) {
          await route.continue();
          return;
        }
        holding = true;
        const response = await route.fetch();
        fetched = response.status();
        await gate;
        await route.fulfill({ response });
      });
      arm = true;
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.click('#settings');
      await p.waitForSelector('#user-modal[open]', { timeout: 5000 });
      await p.click('#tab-notifications');
      expect((await p.getAttribute('#tab-notifications', 'aria-selected')) === 'true', 'the notifications tab is the open one');
      const untilFetched = Date.now() + 10000;
      while (!fetched) {
        if (Date.now() > untilFetched) throw new Error('the notifications tab sent no inbox GET');
        await sleep(50);
      }
      expect(fetched === 200, `the held inbox GET got ${fetched}`);
      expect(gets === 1, `inbox GETs while the refresh was held: ${gets}`);
      expect((await bell()) === '', `the bell counted something before the line: ${JSON.stringify(await bell())}`);
      const text = 'while the list reloads';
      const sent = await body(await pal.post(`/api/dm/${FAN}`, { data: { text } }));
      expect(sent && sent.id, `pal's line: ${JSON.stringify(sent)}`);
      const untilBell = Date.now() + 10000;
      let during = '';
      while (Date.now() < untilBell) {
        during = await bell();
        if (during === '1') break;
        await sleep(50);
      }
      expect(during === '1', `the bell while the refresh was held: ${JSON.stringify(during)}`);
      let row = null;
      const untilRow = Date.now() + 10000;
      while (!row) {
        if (Date.now() > untilRow) throw new Error(`the line wrote no unread dm: ${JSON.stringify((await inbox(fan)).items.filter((n) => n.kind === 'dm'))}`);
        row = (await inbox(fan)).items.find((n) => n.kind === 'dm' && n.name === palName && n.text === text && !n.read);
        if (!row) await sleep(50);
      }
      expect(gets === 1, `a second inbox GET landed before the held body was applied (${gets})`);
      release();
      // long enough for the held body to have been applied. a body that dropped the line clears the bell
      await sleep(300);
      const after = await bell();
      expect(after === '1', `the bell after the held inbox GET: ${JSON.stringify(after)}`);
      await p.click('#user-modal-close');
      await p.waitForFunction(() => !document.querySelector('#user-modal'), null, { timeout: 5000 });
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      let listed = false;
      let lastText = '';
      const untilShown = Date.now() + 10000;
      while (Date.now() < untilShown) {
        const el = await p.$(`#notification-${row.id}[data-kind="dm"]`);
        if (el) {
          lastText = (await el.textContent()) || '';
          if (lastText.includes(palName) && lastText.includes(text)) {
            listed = true;
            break;
          }
        }
        await sleep(50);
      }
      expect(listed, `the panel does not list dm ${row.id} from ${palName}: ${JSON.stringify(lastText)}`);
      return `line ${row.id} stayed`;
    } finally {
      release();
      await p.close();
      await ctx.close();
    }
  });

  await step('a switch clicked before settings have loaded does not turn the other kinds on', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. dm is saved off, then the
    // login's inbox GET is held, so the switches are still the default. turning live off must
    // not PUT that default with dm on. settings go back to all on before this returns
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = false;
    let fetched = 0;
    let puts = 0;
    try {
      const off = await body(await fan.put('/api/notifications/settings', { data: { dm: false } }));
      expect(off && off.dm === false && off.live === true && off.follow === true, `saving dm off: ${JSON.stringify(off)}`);
      await p.route(/\/api\/notifications$/, async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        if (holding) {
          await route.continue();
          return;
        }
        holding = true;
        const response = await route.fetch();
        fetched = response.status();
        await gate;
        await route.fulfill({ response });
      });
      await p.route(/\/api\/notifications\/settings$/, async (route) => {
        if (route.request().method() === 'PUT') puts += 1;
        await route.continue();
      });
      await login(p, FAN);
      const untilFetched = Date.now() + 10000;
      while (!fetched) {
        if (Date.now() > untilFetched) throw new Error('login sent no inbox GET');
        await sleep(50);
      }
      expect(fetched === 200, `the held inbox GET got ${fetched}`);
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.click('#settings');
      await p.waitForSelector('#user-modal[open]', { timeout: 5000 });
      await p.click('#tab-notifications');
      expect((await p.getAttribute('#tab-notifications', 'aria-selected')) === 'true', 'the notifications tab is the open one');
      await p.waitForSelector('#notify-live', { timeout: 5000 });
      const liveDisabled = await p.isDisabled('#notify-live');
      if (liveDisabled) {
        expect(await p.isDisabled('#notify-dm'), 'the dm switch is disabled while the inbox GET is held');
        expect(await p.isDisabled('#notify-follow'), 'the follow switch is disabled while the inbox GET is held');
        // a disabled box takes no click. a change event, as a script would send, must not PUT the default
        await p.$eval('#notify-live', (el) => {
          el.checked = false;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } else {
        await p.click('#notify-live');
      }
      // long enough for a PUT of the default to have landed and the note to say saved
      await sleep(300);
      expect(puts === 0, `a settings PUT landed while the inbox GET was held (${puts})`);
      const during = await inbox(fan);
      expect(
        during.settings && during.settings.dm === false && during.settings.live === true && during.settings.follow === true,
        `the api while the GET is held: ${JSON.stringify(during.settings)}`
      );
      const noteHeld = await p.textContent('#notify-settings-note');
      expect(noteHeld === '', `the note while the GET is held: ${JSON.stringify(noteHeld)}`);
      release();
      await p.waitForFunction(
        () => {
          const dm = document.querySelector('#notify-dm');
          return !!dm && dm.disabled === false && dm.checked === false;
        },
        null,
        { timeout: 10000 }
      );
      expect((await p.isChecked('#notify-dm')) === false, 'dm stays off after the held inbox GET');
      expect(await p.isChecked('#notify-live'), 'live stays on after the held inbox GET');
      expect(await p.isChecked('#notify-follow'), 'follow stays on after the held inbox GET');
      const note = await p.textContent('#notify-settings-note');
      expect(note === '', `the note after the held inbox GET: ${JSON.stringify(note)}`);
      const after = await inbox(fan);
      expect(
        after.settings && after.settings.dm === false && after.settings.live === true && after.settings.follow === true,
        `the api after the held GET: ${JSON.stringify(after.settings)}`
      );
      expect(puts === 0, `a settings PUT landed after the GET (${puts})`);
      return 'dm stayed off';
    } finally {
      release();
      try {
        const back = await body(await fan.put('/api/notifications/settings', { data: { live: true, follow: true, dm: true } }));
        expect(back && back.dm === true && back.live === true && back.follow === true, `settings back to all on: ${JSON.stringify(back)}`);
      } finally {
        await p.close();
        await ctx.close();
      }
    }
  });

  await step('a line after a friend renames is in the open chat, one tab, and the inbox row is read', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. pal already renamed once this
    // run (a name changes only every 30 days), so the friend is star, who has not. the chat is
    // selected and the page is visible before the rename; the line after it is in that log
    const who = await body(await star.get('/api/me'));
    expect(who && who.name === STAR && !who.renamed_at, `star has not been renamed: ${JSON.stringify(who)}`);
    const firstText = 'open this chat';
    const text = 'on the open chat';
    const renamed = 'sx' + RUN;
    const first = await body(await star.post(`/api/dm/${FAN}`, { data: { text: firstText } }));
    expect(first && first.id, `star's line: ${JSON.stringify(first)}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    try {
      await login(p, FAN);
      await p.waitForSelector('#my-presence[data-presence="online"]', { timeout: 10000 });
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-${STAR}`, { state: 'visible', timeout: 10000 });
      await p.click(`#friend-chat-${STAR}`);
      await p.mouse.move(700, 300);
      await p.waitForSelector('#friend-chat', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-tab-${STAR}[aria-selected="true"]`, { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-log p[data-id="${first.id}"]`, { timeout: 10000 });
      await p.bringToFront();
      const visible = await p.evaluate(() => document.visibilityState);
      expect(visible === 'visible', `visibility is ${visible}`);
      const nameRes = await star.post('/api/name', { data: { name: renamed, password: PW } });
      const nameBody = await body(nameRes);
      expect(nameRes.status() === 200 && nameBody && nameBody.name === renamed, `rename got ${nameRes.status()} ${JSON.stringify(nameBody)}`);
      const sent = await body(await star.post(`/api/dm/${FAN}`, { data: { text } }));
      expect(sent && sent.id && sent.id !== first.id, `star's line after the rename: ${JSON.stringify(sent)}`);
      await p.waitForSelector(`#friend-chat-log p[data-id="${sent.id}"]`, { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-tab-${renamed}[aria-selected="true"]`, { timeout: 10000 });
      expect(await p.$(`#friend-chat-log p[data-id="${first.id}"]`), 'the lines that were open left with the old name');
      const tabs = await p.$$eval('#friend-chat-tabs [role="tab"]', (els) => els.map((e) => ({ id: e.id, selected: e.getAttribute('aria-selected') })));
      const theirs = tabs.filter((t) => t.id === `friend-chat-tab-${STAR}` || t.id === `friend-chat-tab-${renamed}`);
      expect(
        theirs.length === 1 && theirs[0].id === `friend-chat-tab-${renamed}` && theirs[0].selected === 'true',
        `tabs for star: ${JSON.stringify(theirs)} (all ${JSON.stringify(tabs)})`
      );
      let row = null;
      const untilRead = Date.now() + 5000;
      while (Date.now() < untilRead) {
        const { items } = await inbox(fan);
        row = items.find((n) => n.kind === 'dm' && n.name === renamed && n.text === text);
        if (row && row.read === true) break;
        await sleep(50);
      }
      expect(row && row.read === true, `the dm on the api: ${JSON.stringify(row)}`);
      return `line ${sent.id} in ${renamed}'s open chat, read`;
    } finally {
      await p.close();
      await ctx.close();
    }
  });

  await step('an older settings response, released after a newer save, leaves both switches off and the note saved', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. dm is turned off and that
    // PUT is held; follow is turned off and that save says saved; the older response must not
    // turn follow back on. settings go back to all on before this returns
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = false;
    let held = 0;
    try {
      await login(p, FAN);
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.click('#settings');
      await p.waitForSelector('#user-modal[open]', { timeout: 5000 });
      await p.click('#tab-notifications');
      expect((await p.getAttribute('#tab-notifications', 'aria-selected')) === 'true', 'the notifications tab is the open one');
      await p.waitForFunction(
        () => {
          const dm = document.querySelector('#notify-dm');
          const follow = document.querySelector('#notify-follow');
          return !!dm && !!follow && dm.disabled === false && follow.disabled === false && dm.checked === true && follow.checked === true;
        },
        null,
        { timeout: 10000 }
      );
      await p.route(/\/api\/notifications\/settings$/, async (route) => {
        if (route.request().method() !== 'PUT' || holding) {
          await route.continue();
          return;
        }
        holding = true;
        const response = await route.fetch();
        held = response.status();
        await gate;
        await route.fulfill({ response });
      });
      await p.click('#notify-dm');
      const untilHeld = Date.now() + 10000;
      while (!held) {
        if (Date.now() > untilHeld) throw new Error('turning dm off sent no settings PUT');
        await sleep(50);
      }
      expect(held === 200, `the held settings PUT got ${held}`);
      await p.click('#notify-follow');
      await p.waitForFunction(() => document.querySelector('#notify-settings-note')?.textContent === 'saved', null, { timeout: 5000 });
      expect((await p.isChecked('#notify-dm')) === false, 'dm reads off once follow has saved');
      expect((await p.isChecked('#notify-follow')) === false, 'follow reads off once saved');
      const during = await inbox(fan);
      expect(
        during.settings && during.settings.dm === false && during.settings.follow === false && during.settings.live === true,
        `the api after the second save: ${JSON.stringify(during.settings)}`
      );
      release();
      // the held document was saved before follow went off, so it still says follow on. long enough for it to have been applied
      await sleep(300);
      expect((await p.isChecked('#notify-dm')) === false, 'dm stays off after the older settings response');
      expect((await p.isChecked('#notify-follow')) === false, 'follow stays off after the older settings response');
      const note = await p.textContent('#notify-settings-note');
      expect(note === 'saved', `the note after the older settings response: ${JSON.stringify(note)}`);
      const after = await inbox(fan);
      expect(
        after.settings && after.settings.dm === false && after.settings.follow === false && after.settings.live === true,
        `the api after the older response: ${JSON.stringify(after.settings)}`
      );
      return 'both switches stayed off, note saved';
    } finally {
      release();
      try {
        const back = await body(await fan.put('/api/notifications/settings', { data: { live: true, follow: true, dm: true } }));
        expect(back && back.dm === true && back.live === true && back.follow === true, `settings back to all on: ${JSON.stringify(back)}`);
      } finally {
        await p.close();
        await ctx.close();
      }
    }
  });

  await step('a failed read is sent again when the list is opened again', async () => {
    // its own page, closed at the end: `page` stays logged in as fan. the inbox is read through
    // the api first, so pal's line is the one unread row. the read PUT answers 500. opening the
    // list, closing it, and opening it again sends a second one. the route dies with the page
    const prior = await inbox(fan);
    if (prior.items.some((n) => !n.read)) {
      const cleared = await fan.put('/api/notifications/read', { data: { id: prior.items[0].id } });
      expect(cleared.status() === 204, `reading the inbox got ${cleared.status()}`);
    }
    const who = await body(await pal.get('/api/me'));
    expect(who && who.name, `pal's name: ${JSON.stringify(who)}`);
    const text = 'read me twice';
    const sent = await body(await pal.post(`/api/dm/${FAN}`, { data: { text } }));
    expect(sent && sent.id, `pal's line: ${JSON.stringify(sent)}`);
    let row = null;
    const untilRow = Date.now() + 10000;
    while (!row) {
      if (Date.now() > untilRow) throw new Error(`the line is not the one unread row: ${JSON.stringify((await inbox(fan)).items.filter((n) => !n.read))}`);
      const unread = (await inbox(fan)).items.filter((n) => !n.read);
      if (unread.length === 1 && unread[0].kind === 'dm' && unread[0].name === who.name && unread[0].text === text) row = unread[0];
      else await sleep(50);
    }
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    const bell = async () => {
      const el = await p.$('#notifications-unread');
      return el ? (await el.textContent()) || '' : '';
    };
    let reads = 0;
    try {
      await login(p, FAN);
      await p.waitForFunction(() => document.querySelector('#notifications-unread')?.textContent === '1', null, { timeout: 10000 });
      await p.route(/\/api\/notifications\/read$/, async (route) => {
        if (route.request().method() !== 'PUT') {
          await route.continue();
          return;
        }
        reads += 1;
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) });
      });
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      const untilBack = Date.now() + 10000;
      let back = '';
      while (Date.now() < untilBack) {
        back = await bell();
        if (reads === 1 && back === '1') break;
        await sleep(50);
      }
      expect(reads === 1, `reads before the list was closed: ${reads}`);
      expect(back === '1', `the bell after the refused read: ${JSON.stringify(back)}`);
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('#notifications-panel'), null, { timeout: 5000 });
      await p.click('#notifications');
      await p.waitForSelector('#notifications-panel[open]', { timeout: 10000 });
      const untilSecond = Date.now() + 10000;
      while (reads < 2) {
        if (Date.now() > untilSecond) throw new Error(`opening the list again sent no second read (${reads})`);
        await sleep(50);
      }
      expect(reads === 2, `reads after opening again: ${reads}`);
      const still = (await inbox(fan)).items.find((n) => n.id === row.id);
      expect(still && still.read === false, `the row on the api: ${JSON.stringify(still)}`);
      return `row ${row.id} refused, then sent again`;
    } finally {
      await p.close();
      await ctx.close();
    }
  });

  await step('after the renames, a held thread released across logout and a client-side login is the next account\'s own lines', async () => {
    // immediately before cleanup. pal and star may already wear new names, so both come from
    // GET /api/me. its own page, closed at the end: `page` stays logged in as fan. star and pal
    // are friends only when this step makes them so, and that is undone before return
    const palWho = await body(await pal.get('/api/me'));
    const starWho = await body(await star.get('/api/me'));
    expect(palWho && palWho.name && starWho && starWho.name, `names now: ${JSON.stringify(palWho)} ${JSON.stringify(starWho)}`);
    const friend = palWho.name;
    const other = starWho.name;
    const starList = await body(await star.get('/api/following'));
    const already = Array.isArray(starList) && starList.some((f) => f.name === friend && f.mutual === true);
    let linked = false;
    if (!already) {
      const starFollows = await star.post(`/api/streamers/${friend}/follow`);
      const palFollows = await pal.post(`/api/streamers/${other}/follow`);
      expect(starFollows.status() === 204 && palFollows.status() === 204, `making them friends got ${starFollows.status()} and ${palFollows.status()}`);
      linked = true;
    }
    const aText = `only-${FAN}-after-rename`;
    const bText = `only-${other}-after-rename`;
    const aSent = await body(await pal.post(`/api/dm/${FAN}`, { data: { text: aText } }));
    const bSent = await body(await pal.post(`/api/dm/${other}`, { data: { text: bText } }));
    expect(aSent && aSent.id && bSent && bSent.id && aSent.id !== bSent.id, `the two lines: ${JSON.stringify(aSent)} and ${JSON.stringify(bSent)}`);
    const aThread = await body(await fan.get(`/api/dm/${friend}`));
    const bThread = await body(await star.get(`/api/dm/${friend}`));
    const aIds = new Set((aThread?.lines || []).map((l) => String(l.id)));
    const bIds = new Set((bThread?.lines || []).map((l) => String(l.id)));
    expect(aIds.has(String(aSent.id)) && bIds.has(String(bSent.id)), `threads: ${JSON.stringify(aThread?.lines)} / ${JSON.stringify(bThread?.lines)}`);
    expect(!bIds.has(String(aSent.id)) && ![...aIds].some((id) => bIds.has(id)), `the threads share a line: ${JSON.stringify([...aIds].filter((id) => bIds.has(id)))}`);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let holding = false;
    let held = 0;
    let gets = 0;
    const openFriend = async () => {
      await p.hover('#user-panel');
      await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-${friend}`, { state: 'visible', timeout: 10000 });
      await p.click(`#friend-chat-${friend}`);
      await p.mouse.move(700, 300);
      await p.waitForSelector('#friend-chat', { timeout: 10000 });
      await p.waitForSelector(`#friend-chat-tab-${friend}[aria-selected="true"]`, { timeout: 10000 });
    };
    try {
      await login(p, FAN);
      await p.evaluate(() => {
        window.__threadPage = 1;
      });
      // the newest page only: a `?before=` query is a later page and is not this hold
      await p.route(new RegExp(`/api/dm/${friend}$`), async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        gets += 1;
        if (!holding) {
          holding = true;
          const response = await route.fetch();
          held = response.status();
          await gate;
          await route.fulfill({ response });
          return;
        }
        await route.continue();
      });
      await openFriend();
      const untilHeld = Date.now() + 10000;
      while (!held) {
        if (Date.now() > untilHeld) throw new Error(`opening ${friend}'s chat sent no thread GET`);
        await sleep(50);
      }
      expect(held === 200, `the held thread GET got ${held}`);
      expect(gets === 1, `thread GETs while ${FAN} was opening: ${gets}`);
      await p.hover('#user-panel');
      await p.waitForSelector('#logout', { timeout: 10000 });
      await p.click('#logout');
      await p.hover('#user-panel');
      await p.waitForSelector('#login-link', { timeout: 10000 });
      await p.click('#login-link');
      await p.waitForSelector('#auth-name', { timeout: 10000 });
      await p.fill('#auth-name', other);
      await p.fill('#auth-password', PW);
      await p.click('#auth-submit');
      await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, other, { timeout: 10000 });
      expect((await p.evaluate(() => window.__threadPage)) === 1, 'the second login reloaded the page');
      expect(gets === 1, `the next login fetched the thread before the held body was released (${gets})`);
      release();
      // long enough for the held page to have been applied, if it were still this login's
      await sleep(300);
      expect(gets === 1, `releasing the held thread GET sent another (${gets})`);
      await openFriend();
      let ids = [];
      const untilLines = Date.now() + 10000;
      while (Date.now() < untilLines) {
        ids = await p.$$eval('#friend-chat-log p[data-id]', (els) => els.map((e) => e.getAttribute('data-id')));
        if (ids.includes(String(bSent.id)) || ids.some((id) => aIds.has(id))) break;
        await sleep(50);
      }
      const me = await p.textContent('#me');
      const withName = await p.getAttribute('#friend-chat', 'data-with');
      expect(me === other && withName === friend, `the open chat is ${JSON.stringify(withName)} while #me is ${JSON.stringify(me)}`);
      expect(ids.includes(String(bSent.id)), `${other}'s line ${bSent.id} is not in the log: ${JSON.stringify(ids)}`);
      expect(!ids.some((id) => aIds.has(id)), `${FAN}'s line ids are in the log: ${JSON.stringify(ids)}`);
      const log = await p.textContent('#friend-chat-log');
      expect(log.includes(bText) && !log.includes(aText), `the log text: ${JSON.stringify(log)}`);
      expect(gets === 2, `opening as ${other} sent no thread GET of their own (${gets})`);
      return `${FAN}'s line ${aSent.id} held across login as ${other}; the log is ${bSent.id}`;
    } finally {
      release();
      try {
        if (linked) {
          const undoStar = await star.post(`/api/streamers/${friend}/unfollow`);
          const undoPal = await pal.post(`/api/streamers/${other}/unfollow`);
          expect(undoStar.status() === 204 && undoPal.status() === 204, `unfollowing got ${undoStar.status()} and ${undoPal.status()}`);
        }
      } finally {
        await p.close();
        await ctx.close();
      }
    }
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
