// Direct messages (docs/dms.md): a login writes a line to a friend. Nobody gets 401; a stranger
// 403 until both follows are there; the line is kept, listed with its count of what is new, read;
// a line carries pictures the room chat's way (a picture alone is kept, a bad, unknown or eleventh
// id is refused); the window in a browser gets the line pushed over the events socket and sends
// one back, draws a pushed picture and sends one picked from its picture button; a line that
// comes while the window is hidden counts on the sidebar; two tabs of one login agree; a friend's
// watch page has the line button beside the chat button, a stranger's does not.
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
/** A jpeg by its first bytes: the upload checks the magic and the size, nothing more (chat_images.rs `kind`). */
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
/** A picture for a line, the page's way: the bytes to `POST /api/chat-images`, the id back. */
const upload = (ctx, bytes) => ctx.post('/api/chat-images', { data: bytes, headers: { 'content-type': 'image/jpeg' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  /** The api's side of pictures. After the window's steps: a line of yours reads the thread for you, and those steps count on the 25 above. */
  const picturesOverTheApi = async () => {
    const up = await upload(ann, JPEG_HEAD);
    expect(up.status() === 200, `the upload got ${up.status()}: ${JSON.stringify(await body(up))}`);
    const pictureId = (await body(up)).id;
    expect(UUID.test(pictureId || ''), `the upload handed back ${JSON.stringify(pictureId)}`);
    const sent = await ann.post(`/api/dm/${BEN}`, { data: { text: '', images: [pictureId] } });
    expect(sent.status() === 201, `a picture alone got ${sent.status()}: ${JSON.stringify(await body(sent))}`);
    const line = await body(sent);
    expect(line.text === '' && Array.isArray(line.images) && line.images.length === 1 && line.images[0] === pictureId, `the line: ${JSON.stringify(line)}`);
    const thread = await body(await ben.get(`/api/dm/${ANN}`));
    const last = thread.lines[thread.lines.length - 1];
    expect(last.id === line.id && last.text === '' && last.images.length === 1 && last.images[0] === pictureId, `ben's thread ends with ${JSON.stringify(last)}`);
    expect(thread.lines.every((l) => Array.isArray(l.images)), 'every line must carry images, [] for none');
    const plain = thread.lines.find((l) => l.text === 'yes, hi');
    expect(plain && plain.images.length === 0, `a line with no picture must say images: [], got ${JSON.stringify(plain)}`);
    const list = await body(await ben.get('/api/dms'));
    expect(list[0].last.id === line.id && list[0].last.images[0] === pictureId, `ben's list ends with ${JSON.stringify(list[0].last)}`);
    // words with it, the picture named the say's old way (`image` alone)
    const both = await body(await ann.post(`/api/dm/${BEN}`, { data: { text: 'see', image: pictureId } }));
    expect(both && both.text === 'see' && both.images[0] === pictureId, `words and a picture: ${JSON.stringify(both)}`);
    const bad = await ann.post(`/api/dm/${BEN}`, { data: { text: '', images: ['nope'] } });
    const unknown = await ann.post(`/api/dm/${BEN}`, { data: { text: '', images: ['00000000-0000-4000-8000-000000000000'] } });
    const many = await ann.post(`/api/dm/${BEN}`, { data: { text: '', images: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) } });
    const nothing = await ann.post(`/api/dm/${BEN}`, { data: { text: '  ', images: [] } });
    const said = async (res) => (await body(res))?.error || '';
    expect(bad.status() === 400 && /bad picture/.test(await said(bad)), `a bad id got ${bad.status()} ${JSON.stringify(await body(bad))}`);
    expect(unknown.status() === 400 && /no such picture/.test(await said(unknown)), `an unknown id got ${unknown.status()} ${JSON.stringify(await body(unknown))}`);
    expect(many.status() === 400 && /too many pictures/.test(await said(many)), `eleven got ${many.status()} ${JSON.stringify(await body(many))}`);
    expect(nothing.status() === 400 && /nothing to say/.test(await said(nothing)), `no words and no picture got ${nothing.status()} ${JSON.stringify(await body(nothing))}`);
    const bytes = await anon.get(`/api/chat-images/${pictureId}`);
    expect(bytes.status() === 200 && /image\/jpeg/.test(bytes.headers()['content-type'] || ''), `the picture reads back ${bytes.status()} ${bytes.headers()['content-type']}`);
    return `picture ${pictureId.slice(0, 8)} on lines ${line.id} and ${both.id}`;
  };

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

  await step('pictures in the window: a pushed picture line draws its <img>; a file picked goes up, waits in the strip, and goes alone as a line', async () => {
    // real pictures, made by the browser: a jpeg for ben's upload over the api, a png for ann's pick (the page has to decode it to shrink it)
    const [jpegUrl, pngUrl] = await annPage.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 48;
      const x = c.getContext('2d');
      x.fillStyle = '#4f8bff';
      x.fillRect(0, 0, 64, 48);
      x.fillStyle = '#ff7a4f';
      x.fillRect(8, 8, 24, 24);
      return [c.toDataURL('image/jpeg', 0.9), c.toDataURL('image/png')];
    });
    const JPEG = Buffer.from(jpegUrl.split(',')[1], 'base64');
    const PNG = Buffer.from(pngUrl.split(',')[1], 'base64');
    // ben sends a picture with a word: the frame carries the id, and the open window draws it under the words, read at once
    const bensPicture = (await body(await upload(ben, JPEG))).id;
    const pushed = await body(await ben.post(`/api/dm/${ANN}`, { data: { text: 'look', images: [bensPicture] } }));
    expect(pushed && pushed.images && pushed.images[0] === bensPicture, `ben's line: ${JSON.stringify(pushed)}`);
    // the <img> on the line, and the bytes decoded in it: the frame carried the id and the picture reads back through the page
    const drawn = (sel) => {
      const img = document.querySelector(sel);
      return !!img && img.complete && img.naturalWidth > 0;
    };
    await annPage.waitForSelector(`#friend-chat-log p[data-id="${pushed.id}"] img`, { state: 'attached', timeout: 10000 });
    await annPage.waitForFunction(drawn, `#friend-chat-log p[data-id="${pushed.id}"] img`, { timeout: 10000 });
    const src = await annPage.getAttribute(`#friend-chat-log p[data-id="${pushed.id}"] img`, 'src');
    expect((src || '').endsWith(`/api/chat-images/${bensPicture}`), `the pushed picture is drawn from ${src}`);
    expect(((await annPage.textContent(`#friend-chat-log p[data-id="${pushed.id}"]`)) || '').includes('look'), 'the words stand with the picture');
    expect(!(await annPage.$(`#friend-chat-unread-${BEN}`)), 'a picture line on screen must not count as new');
    // ann picks a file from the window: it goes up at once and waits in the strip, and send comes on with nothing typed
    expect(await annPage.isDisabled('#friend-chat-send'), 'send must be off with nothing typed and no picture');
    await annPage.setInputFiles('#friend-chat-picture-file', { name: 'square.png', mimeType: 'image/png', buffer: PNG });
    await annPage.waitForSelector('#friend-chat-picture-preview img', { state: 'attached', timeout: 15000 });
    await annPage.waitForFunction(drawn, '#friend-chat-picture-preview img', { timeout: 10000 });
    await annPage.waitForFunction(() => !document.querySelector('#friend-chat-send')?.disabled, null, { timeout: 5000 });
    const annsPicture = ((await annPage.getAttribute('#friend-chat-picture-preview img', 'src')) || '').split('/').pop();
    expect(UUID.test(annsPicture || ''), `the strip shows ${annsPicture}`);
    const bytes = await anon.get(`/api/chat-images/${annsPicture}`);
    expect(bytes.status() === 200 && /^image\/(webp|jpeg)$/.test(bytes.headers()['content-type'] || ''), `the picked picture reads back ${bytes.status()} ${bytes.headers()['content-type']}`);
    // enter in the empty box: the picture goes alone, the strip empties, and the api has the line with the id and no words
    await annPage.press('#friend-chat-text', 'Enter');
    await annPage.waitForFunction(() => !document.querySelector('#friend-chat-picture-preview'), null, { timeout: 10000 });
    await annPage.waitForFunction(
      (id) => [...document.querySelectorAll('#friend-chat-log p[data-mine] img')].some((img) => (img.getAttribute('src') || '').endsWith(`/api/chat-images/${id}`)),
      annsPicture,
      { timeout: 10000 }
    );
    const bensThread = await body(await ben.get(`/api/dm/${ANN}`));
    const last = bensThread.lines[bensThread.lines.length - 1];
    expect(last.from === ANN && last.text === '' && last.images.length === 1 && last.images[0] === annsPicture, `ben's thread ends with ${JSON.stringify(last)}`);
    expect((await annPage.inputValue('#friend-chat-text')) === '', 'the box stays empty');
    expect(await annPage.isDisabled('#friend-chat-send'), 'send goes off again once the picture has gone');
    return `ben's ${bensPicture.slice(0, 8)} pushed, ann's ${annsPicture.slice(0, 8)} sent as line ${last.id}`;
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

  await step("a friend's page: beside the chat button a line button opens their thread, lit while it shows, and hides it again", async () => {
    // a fresh load of ben's page: the window is down, and ben is not live, so the chat button is on his profile
    await annPage.goto(`${BASE}/watch/${BEN}`, { waitUntil: 'domcontentloaded' });
    await annPage.waitForFunction((n) => document.querySelector('#me')?.textContent === n, ANN, { timeout: 10000 });
    await annPage.waitForSelector('#profile #chat-open', { timeout: 10000 });
    // the line button comes once the list has said ben follows back
    await annPage.waitForSelector('#profile #dm-open', { timeout: 10000 });
    expect(!(await annPage.$('#friend-chat')), 'the window must be down on a fresh page');
    const label = await annPage.getAttribute('#dm-open', 'aria-label');
    expect(label === `message ${BEN}`, `the button is named ${JSON.stringify(label)}`);
    expect((await annPage.getAttribute('#dm-open', 'aria-pressed')) === null, 'the button must not be lit while the window is down');
    await annPage.click('#dm-open');
    await annPage.waitForSelector(`#friend-chat[data-with="${BEN}"]`, { timeout: 10000 });
    await annPage.waitForFunction(() => document.querySelectorAll('#friend-chat-log p[data-id]').length === 50, null, { timeout: 10000 });
    await annPage.waitForFunction(() => document.querySelector('#dm-open')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
    expect((await annPage.getAttribute('#dm-open', 'aria-label')) === `hide the chat with ${BEN}`, 'lit, the button says it hides the chat');
    // lit, it hides the window and keeps the tab; pressed again, the thread is back
    await annPage.click('#dm-open');
    await annPage.waitForFunction(() => !document.querySelector('#friend-chat'), null, { timeout: 5000 });
    expect((await annPage.getAttribute('#dm-open', 'aria-pressed')) === null, 'hidden, the button is not lit');
    await annPage.click('#dm-open');
    await annPage.waitForSelector(`#friend-chat[data-with="${BEN}"]`, { timeout: 10000 });
    await annPage.waitForFunction(() => document.querySelectorAll('#friend-chat-log p[data-id]').length === 50, null, { timeout: 10000 });
    return 'opened, hidden, opened again';
  });

  await step("the shape of the lines: bubbles to start, yours right of theirs; the chat tab's cards make it a log or blocks, kept in the browser", async () => {
    const shape = () => annPage.evaluate(() => document.querySelector('#friend-chat-log')?.getAttribute('data-style'));
    expect((await shape()) === 'bubbles', `the log starts as ${await shape()}`);
    // a box of yours sits to the right of a box of ben's (a line is the time at the left, then the box's row)
    const [mine, theirs] = await annPage.evaluate(() => {
      const box = (p) => p?.lastElementChild?.firstElementChild?.getBoundingClientRect().toJSON();
      return [box(document.querySelector('#friend-chat-log p[data-mine]')), box(document.querySelector('#friend-chat-log p[data-id]:not([data-mine])'))];
    });
    expect(mine && theirs && mine.left > theirs.left && mine.right > theirs.right, `yours ${JSON.stringify(mine)} must sit right of theirs ${JSON.stringify(theirs)}`);
    // the first line on screen starts a minute, so its time stands at the left, HH:MM
    const clock = await annPage.evaluate(() => document.querySelector('#friend-chat-log p[data-id]')?.firstElementChild?.textContent);
    expect(/^\d\d:\d\d$/.test(clock || ''), `the first line's time reads ${JSON.stringify(clock)}`);
    // the gear opens the settings; the chat tab has the three cards, bubbles the one on
    await annPage.hover('#user-panel');
    await annPage.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await annPage.click('#settings');
    await annPage.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await annPage.click('#tab-chat');
    await annPage.waitForSelector('#dm-style-bubbles', { state: 'attached', timeout: 5000 });
    expect(await annPage.isChecked('#dm-style-bubbles'), 'the bubbles card must be the one on');
    await annPage.click('label[for="dm-style-log"]');
    await annPage.waitForFunction(() => document.querySelector('#friend-chat-log')?.getAttribute('data-style') === 'log', null, { timeout: 5000 });
    await annPage.click('label[for="dm-style-blocks"]');
    await annPage.waitForFunction(() => document.querySelector('#friend-chat-log')?.getAttribute('data-style') === 'blocks', null, { timeout: 5000 });
    const kept = await annPage.evaluate(() => localStorage.getItem('settings.dmStyle'));
    expect(kept === '"blocks"', `the browser keeps ${kept}`);
    // every line is still there in its shape, and it is still one <p> a line
    expect((await annPage.$$('#friend-chat-log p[data-id]')).length === 50, 'the lines must all be there in the new shape');
    await annPage.click('label[for="dm-style-bubbles"]');
    await annPage.waitForFunction(() => document.querySelector('#friend-chat-log')?.getAttribute('data-style') === 'bubbles', null, { timeout: 5000 });
    await annPage.click('#user-modal-close');
    await annPage.waitForFunction(() => !document.querySelector('#user-modal[open]'), null, { timeout: 5000 });
    return 'bubbles, a log, blocks, bubbles again';
  });

  await step('pictures over the api: a picture alone is a line with its id and no words, read back everywhere; a bad id, an unknown one and eleven are refused', picturesOverTheApi);

  await step('a stranger again: unfollowed, the thread still reads but a line is refused with the words under the box; the line button goes', async () => {
    const undo = await ben.post(`/api/streamers/${ANN}/unfollow`);
    expect(undo.status() === 204, `ben unfollowing ann got ${undo.status()}`);
    const thread = await body(await ann.get(`/api/dm/${BEN}`));
    expect(thread.friends === false && thread.lines.length === 50, `the thread after the unfollow: friends ${thread.friends}, ${thread.lines.length} lines`);
    await annPage.fill('#friend-chat-text', 'still there?');
    await annPage.press('#friend-chat-text', 'Enter');
    await annPage.waitForFunction(() => /not friends/.test(document.querySelector('#friend-chat-notice')?.textContent || ''), null, { timeout: 10000 });
    expect((await annPage.inputValue('#friend-chat-text')) === 'still there?', 'a refused line stays in the box');
    // ben's page again: the list now has him among the rest ann follows, not the friends, and the line button is not beside the chat button
    await annPage.goto(`${BASE}/watch/${BEN}`, { waitUntil: 'domcontentloaded' });
    await annPage.waitForSelector('#profile #chat-open', { timeout: 10000 });
    await annPage.waitForSelector(`#friends-list #friend-${BEN}`, { state: 'attached', timeout: 10000 });
    expect(!(await annPage.$('#dm-open')), 'a one-way follow must not get the line button');
    return 'refused, the words shown; no button for a stranger';
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
