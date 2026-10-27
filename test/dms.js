// Direct messages (docs/dms.md): a login writes a line to a friend. Nobody gets 401; a stranger
// 403 until both follows are there; the line is kept, listed with its count of what is new, read;
// the window in a browser gets the line pushed over the events socket and sends one back; a line
// that comes while the window is hidden counts on the sidebar; two tabs of one login agree.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node dms.js
const { chromium, request } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const RUN = Date.now().toString(36).slice(-5);
const ANN = 'ann' + RUN;
const BEN = 'ben' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--ignore-certificate-errors'];
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

(async () => {
  const ann = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const ben = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  let firstId = 0;

  await step('nobody: the list 401, a line 401; a stranger 403 until both follows are there', async () => {
    for (const [ctx, name] of [
      [ann, ANN],
      [ben, BEN]
    ]) {
      const up = await ctx.post('/api/signup', { data: { name, password: PW } });
      expect(up.status() === 201, `signup of ${name} got ${up.status()}`);
    }
    const list = await anon.get('/api/dms');
    const line = await anon.post(`/api/dm/${BEN}`, { data: { text: 'hi' } });
    expect(list.status() === 401 && line.status() === 401, `nobody got ${list.status()} and ${line.status()}`);
    const stranger = await ann.post(`/api/dm/${BEN}`, { data: { text: 'hi' } });
    expect(stranger.status() === 403, `a stranger's line got ${stranger.status()}`);
    expect(/not friends/.test((await body(stranger))?.error || ''), `the refusal says ${JSON.stringify(await body(stranger))}`);
    const follow = await ann.post(`/api/streamers/${BEN}/follow`);
    expect(follow.status() === 204, `ann following ben got ${follow.status()}`);
    const oneWay = await ann.post(`/api/dm/${BEN}`, { data: { text: 'hi' } });
    expect(oneWay.status() === 403, `a one-way follow's line got ${oneWay.status()}`);
    const self = await ann.post(`/api/dm/${ANN}`, { data: { text: 'hi' } });
    expect(self.status() === 400, `a line to yourself got ${self.status()}`);
    const nobody = await ann.post(`/api/dm/nobody${RUN}`, { data: { text: 'hi' } });
    expect(nobody.status() === 403, `a line to a name with no account got ${nobody.status()}`);
    return 'two accounts, one follow';
  });

  await step('friends: 201 with the line; the thread and the list, with 1 new for ben; the limits', async () => {
    const back = await ben.post(`/api/streamers/${ANN}/follow`);
    expect(back.status() === 204, `ben following ann got ${back.status()}`);
    const sent = await ann.post(`/api/dm/${BEN}`, { data: { text: '  hi ben \u200b ' } });
    expect(sent.status() === 201, `a friend's line got ${sent.status()}: ${JSON.stringify(await body(sent))}`);
    const line = await body(sent);
    expect(line.from === ANN && line.to === BEN && line.text === 'hi ben' && typeof line.id === 'number' && line.at > 0, `the line: ${JSON.stringify(line)}`);
    firstId = line.id;
    const thread = await body(await ben.get(`/api/dm/${ANN}`));
    expect(thread.friends === true && thread.lines.length === 1 && thread.lines[0].id === firstId && thread.lines[0].from === ANN, `ben's thread: ${JSON.stringify(thread)}`);
    const mine = await body(await ann.get(`/api/dm/${BEN}`));
    expect(mine.lines.length === 1 && mine.lines[0].text === 'hi ben', `ann's thread: ${JSON.stringify(mine)}`);
    const list = await body(await ben.get('/api/dms'));
    expect(Array.isArray(list) && list.length === 1 && list[0].name === ANN && list[0].unread === 1 && list[0].last.id === firstId, `ben's list: ${JSON.stringify(list)}`);
    const annList = await body(await ann.get('/api/dms'));
    expect(annList.length === 1 && annList[0].name === BEN && annList[0].unread === 0, `ann's list (her own line is not new to her): ${JSON.stringify(annList)}`);
    const long = await ann.post(`/api/dm/${BEN}`, { data: { text: 'x'.repeat(501) } });
    const empty = await ann.post(`/api/dm/${BEN}`, { data: { text: '   ' } });
    const bad = await ann.post(`/api/dm/${BEN}`, { data: { nope: 1 } });
    expect(long.status() === 400 && empty.status() === 400 && bad.status() === 400, `501 chars ${long.status()}, blank ${empty.status()}, bad json ${bad.status()}`);
    return `line ${firstId}, 1 new for ben`;
  });

  await step('read: PUT read drops the count; a sent line reads what came before; a page of older lines', async () => {
    const read = await ben.put(`/api/dm/${ANN}/read`, { data: { id: firstId } });
    expect(read.status() === 204, `read got ${read.status()}`);
    const list = await body(await ben.get('/api/dms'));
    expect(list[0].unread === 0, `after reading: ${JSON.stringify(list)}`);
    // 29 from ann, then 25 from ben: 55 lines, so the thread pages at 50 and the oldest page holds
    // the first six. ben's own lines read ann's for him (you are in the thread when you write);
    // ann has not looked since, so ben's 25 are new to her
    for (let i = 0; i < 29; i++) {
      const r = await ann.post(`/api/dm/${BEN}`, { data: { text: `ann ${i}` } });
      expect(r.status() === 201, `ann's line ${i} got ${r.status()}`);
    }
    for (let i = 0; i < 25; i++) {
      const r = await ben.post(`/api/dm/${ANN}`, { data: { text: `ben ${i}` } });
      expect(r.status() === 201, `ben's line ${i} got ${r.status()}`);
    }
    const newest = await body(await ann.get(`/api/dm/${BEN}`));
    expect(newest.lines.length === 50, `the newest page has ${newest.lines.length} lines`);
    const older = await body(await ann.get(`/api/dm/${BEN}?before=${newest.lines[0].id}`));
    expect(older.lines.length === 5 && older.lines[0].id === firstId, `the older page has ${older.lines.length} lines, first ${older.lines[0]?.id} (want ${firstId})`);
    const annList = await body(await ann.get('/api/dms'));
    expect(annList[0].unread === 25, `ann has ${annList[0].unread} new (want 25)`);
    const benList = await body(await ben.get('/api/dms'));
    expect(benList[0].unread === 0, `ben has ${benList[0].unread} new (want 0: he wrote last)`);
    const stale = await ben.put(`/api/dm/${ANN}/read`, { data: { id: firstId - 1 } });
    expect(stale.status() === 204, `a read behind the mark got ${stale.status()}`);
    return '55 lines, two pages, 25 new for ann';
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
  const openChats = async (p) => {
    await p.hover('#user-panel');
    await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await p.waitForSelector('#chats-open', { state: 'visible', timeout: 10000 });
    await p.click('#chats-open');
    await p.waitForSelector('#friend-chat', { timeout: 10000 });
    await p.mouse.move(700, 300);
  };
  let annPage;

  await step('the window: the thread loads with the count, reading clears it, a pushed line lands, a sent one is kept', async () => {
    annPage = await context.newPage();
    await login(annPage, ANN);
    // the sidebar says 25 new before the window opens
    await annPage.waitForFunction(() => document.querySelector('#friends-unread')?.textContent === '25', null, { timeout: 10000 });
    await openChats(annPage);
    await annPage.waitForSelector(`#friend-chat-tab-${BEN}`, { timeout: 10000 });
    // the thread with ben is the shown one (the newest), its lines on screen, and it is read now
    await annPage.waitForFunction(() => document.querySelectorAll('#friend-chat-log p[data-id]').length === 50, null, { timeout: 10000 });
    await annPage.waitForFunction(() => !document.querySelector('#friends-unread'), null, { timeout: 10000 });
    const list = await body(await ann.get('/api/dms'));
    expect(list[0].unread === 0, `after the window showed the thread the api says ${list[0].unread} new`);
    // ben writes: the line is pushed into the open window, and is not new (it is on screen)
    const pushed = await body(await ben.post(`/api/dm/${ANN}`, { data: { text: 'are you there' } }));
    await annPage.waitForSelector(`#friend-chat-log p[data-id="${pushed.id}"]`, { timeout: 10000 });
    expect(!(await annPage.$(`#friend-chat-unread-${BEN}`)), 'a line on screen must not count as new');
    // ann answers from the box
    await annPage.fill('#friend-chat-text', 'yes, hi');
    await annPage.press('#friend-chat-text', 'Enter');
    await annPage.waitForFunction(() => [...document.querySelectorAll('#friend-chat-log p[data-mine]')].some((p) => p.textContent.includes('yes, hi')), null, { timeout: 10000 });
    const bensThread = await body(await ben.get(`/api/dm/${ANN}`));
    const last = bensThread.lines[bensThread.lines.length - 1];
    expect(last.from === ANN && last.text === 'yes, hi', `ben's thread ends with ${JSON.stringify(last)}`);
    expect((await annPage.inputValue('#friend-chat-text')) === '', 'the box empties after a send');
    return `line ${pushed.id} pushed, ${last.id} sent`;
  });

  await step('hidden: a line that comes counts on the face, the sidebar and the api; shown again, it is read everywhere', async () => {
    await annPage.click('#friend-chat-close');
    await annPage.waitForFunction(() => !document.querySelector('#friend-chat'), null, { timeout: 5000 });
    await ben.post(`/api/dm/${ANN}`, { data: { text: 'one more' } });
    await ben.post(`/api/dm/${ANN}`, { data: { text: 'and another' } });
    await annPage.waitForFunction(() => document.querySelector('#friends-unread')?.textContent === '2', null, { timeout: 10000 });
    const list = await body(await ann.get('/api/dms'));
    expect(list[0].unread === 2, `the api says ${list[0].unread} new (want 2)`);
    // a second tab of ann: the count is there too, from the api, and drops when the first tab reads
    const second = await context.newPage();
    await second.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await second.waitForFunction(() => document.querySelector('#friends-unread')?.textContent === '2', null, { timeout: 10000 });
    await openChats(annPage);
    await annPage.waitForFunction(() => !document.querySelector('#friends-unread'), null, { timeout: 10000 });
    await annPage.waitForFunction(() => [...document.querySelectorAll('#friend-chat-log p')].some((p) => p.textContent.includes('and another')), null, { timeout: 10000 });
    await second.waitForFunction(() => !document.querySelector('#friends-unread'), null, { timeout: 10000 });
    const after = await body(await ann.get('/api/dms'));
    expect(after[0].unread === 0, `after reading the api says ${after[0].unread} new`);
    await second.close();
    return 'count 2 on both tabs, 0 on both after one reads';
  });

  await step('a stranger again: unfollowed, the thread still reads but a line is refused with the words under the box', async () => {
    const undo = await ben.post(`/api/streamers/${ANN}/unfollow`);
    expect(undo.status() === 204, `ben unfollowing ann got ${undo.status()}`);
    const thread = await body(await ann.get(`/api/dm/${BEN}`));
    expect(thread.friends === false && thread.lines.length === 50, `the thread after the unfollow: friends ${thread.friends}, ${thread.lines.length} lines`);
    await annPage.fill('#friend-chat-text', 'still there?');
    await annPage.press('#friend-chat-text', 'Enter');
    await annPage.waitForFunction(() => /not friends/.test(document.querySelector('#friend-chat-notice')?.textContent || ''), null, { timeout: 10000 });
    expect((await annPage.inputValue('#friend-chat-text')) === 'still there?', 'a refused line stays in the box');
    return 'refused, the words shown';
  });

  await step('cleanup', async () => {
    await ann.post(`/api/streamers/${BEN}/unfollow`);
    await browser.close();
    return 'unfollowed';
  });

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
