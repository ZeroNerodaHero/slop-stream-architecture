// Follows (docs/follows.md): a login follows names, the counts and the flags on a profile read
// (with when they joined and were last live, which stay on the wire), the list with its words,
// search, a free name gets a row, the box over the corner panel (hover shows who you follow,
// streaming first; a row's card is the face with the word on it and their status; the search box finds and follows),
// the watch page's button and count, a rename keeps the followers, home's recently offline once
// star stops, unfollow.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node follows.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const FAN = 'fan' + RUN;
const STAR = 'star' + RUN;
const FREE = 'free' + RUN;
const RENAMED = 'nova' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
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
const find = (list, name) => (Array.isArray(list) ? list.find((f) => f.name === name) : undefined);

(async () => {
  // three http clients: the one who follows, the one followed, and nobody
  const fan = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const star = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });

  await step('nobody: follow 401, the list 401, a profile says 0 followers and not following, search answers', async () => {
    const up = await star.post('/api/signup', { data: { name: STAR, password: PW } });
    expect(up.status() === 201, `signup of ${STAR} got ${up.status()}`);
    const f = await anon.post(`/api/streamers/${STAR}/follow`);
    const l = await anon.get('/api/following');
    expect(f.status() === 401 && l.status() === 401, `nobody got ${f.status()} and ${l.status()}`);
    const p = await body(await anon.get(`/api/streamers/${STAR}`));
    expect(p.followers === 0 && p.following === false, `profile says ${JSON.stringify(p)}`);
    const hits = await body(await anon.get(`/api/search?q=${STAR.slice(0, 6)}`));
    expect(Array.isArray(hits) && find(hits, STAR) && find(hits, STAR).following === false, `search says ${JSON.stringify(hits)}`);
    return `${hits.length} hit(s) for ${STAR.slice(0, 6)}`;
  });

  await step('fan follows star: 204, twice 204, self 400; the counts and the flag', async () => {
    const up = await fan.post('/api/signup', { data: { name: FAN, password: PW } });
    expect(up.status() === 201, `signup of ${FAN} got ${up.status()}`);
    const one = await fan.post(`/api/streamers/${STAR}/follow`);
    const two = await fan.post(`/api/streamers/${STAR}/follow`);
    const self = await fan.post(`/api/streamers/${FAN}/follow`);
    expect(one.status() === 204 && two.status() === 204, `follow got ${one.status()} then ${two.status()}`);
    expect(self.status() === 400, `following yourself got ${self.status()}`);
    const mine = await body(await fan.get(`/api/streamers/${STAR}`));
    const theirs = await body(await anon.get(`/api/streamers/${STAR}`));
    expect(mine.followers === 1 && mine.following === true, `as fan: ${JSON.stringify(mine)}`);
    expect(theirs.followers === 1 && theirs.following === false, `as nobody: ${JSON.stringify(theirs)}`);
    // the profile read's flags: star follows nobody yet, has never streamed, and was made a moment ago
    expect(mine.follows_you === false && theirs.follows_you === false, `follows_you: ${mine.follows_you} / ${theirs.follows_you}`);
    expect(mine.last_live === null, `last_live before any stream: ${JSON.stringify(mine.last_live)}`);
    const made = Date.now() - new Date(mine.joined_at).getTime();
    expect(made >= 0 && made < 60 * 1000, `joined_at ${mine.joined_at} is ${Math.round(made / 1000)}s old`);
    const grant = await body(await fan.post(`/api/streams/${STAR}/watch`));
    expect(grant.followers === 1 && grant.following === true, `the grant: ${JSON.stringify(grant)}`);
    return `followers 1, following true (the grant too); joined just now`;
  });

  await step('the list has star with a word; a free name with no row is followable and gets one', async () => {
    const list = await body(await fan.get('/api/following'));
    const s = find(list, STAR);
    expect(s && typeof s.presence === 'string' && s.live === false && s.verified === true && s.mutual === false, `the list: ${JSON.stringify(list)}`);
    const before = await body(await anon.get(`/api/streamers/${FREE}`));
    expect(before.verified === false && before.followers === 0, `free before: ${JSON.stringify(before)}`);
    const f = await fan.post(`/api/streamers/${FREE}/follow`);
    expect(f.status() === 204, `following a free name got ${f.status()}`);
    const after = await body(await anon.get(`/api/streamers/${FREE}`));
    expect(after.followers === 1, `free after: ${JSON.stringify(after)}`);
    // a free name's row is not a person: no joined date
    expect(after.joined_at === null, `a free name says joined_at ${JSON.stringify(after.joined_at)}`);
    const again = await body(await fan.get('/api/following'));
    expect(again.length === 2 && find(again, FREE), `the list now: ${again.map((f) => f.name).join(' ')}`);
    const back = await star.post(`/api/streamers/${FAN}/follow`);
    expect(back.status() === 204, `star following fan got ${back.status()}`);
    const mutual = find(await body(await fan.get('/api/following')), STAR);
    const freeMutual = find(await body(await fan.get('/api/following')), FREE);
    expect(mutual && mutual.mutual === true, `star should be a friend: ${JSON.stringify(mutual)}`);
    expect(freeMutual && freeMutual.mutual === false, `a free name cannot follow back: ${JSON.stringify(freeMutual)}`);
    // the profile read says the same: star follows fan, as fan reads it; not as nobody
    const friend = await body(await fan.get(`/api/streamers/${STAR}`));
    const stranger = await body(await anon.get(`/api/streamers/${STAR}`));
    expect(friend.follows_you === true && stranger.follows_you === false, `follows_you as fan ${friend.follows_you}, as nobody ${stranger.follows_you}`);
    const undo = await star.post(`/api/streamers/${FAN}/unfollow`);
    expect(undo.status() === 204, `star unfollowing fan got ${undo.status()}`);
    const plain = find(await body(await fan.get('/api/following')), STAR);
    expect(plain && plain.mutual === false, `after star unfollows: ${JSON.stringify(plain)}`);
    const unfriended = await body(await fan.get(`/api/streamers/${STAR}`));
    expect(unfriended.follows_you === false, `after star unfollows the profile says follows_you ${unfriended.follows_you}`);
    return `${STAR} is ${s.presence}; ${FREE} has a row and 1 follower; mutual and follows_you flip`;
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const login = async (p, name) => {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', name);
    await p.fill('#auth-password', PW);
    await p.click('#auth-submit');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, name, { timeout: 10000 });
  };
  let fanPage;
  let starPage;

  await step('the corner: hovering the panel shows who fan follows, streaming first once star is live', async () => {
    fanPage = await fresh();
    await login(fanPage, FAN);
    await fanPage.hover('#user-panel');
    await fanPage.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await fanPage.waitForSelector(`#friend-${STAR}`, { timeout: 10000 });
    await fanPage.waitForSelector(`#friend-${FREE}`, { timeout: 10000 });
    // star goes live, for real, in a second browser
    starPage = await fresh();
    await login(starPage, STAR);
    await starPage.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await starPage.waitForFunction(() => !document.querySelector('#start')?.disabled, null, { timeout: 20000 });
    await starPage.click('#start');
    await starPage.waitForFunction(() => /^\s*live\b/i.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 20000 });
    // the panel asks again every time it opens: closed, then open, and star is streaming at the top
    await fanPage.mouse.move(600, 100);
    await fanPage.waitForSelector('#user-panel[data-open="false"]', { timeout: 5000 });
    let word = '';
    for (let i = 0; i < 10 && word !== 'streaming'; i++) {
      await fanPage.hover('#user-panel');
      await fanPage.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
      await fanPage.waitForSelector(`#friend-${STAR}`, { timeout: 10000 });
      word = await fanPage.$eval(`#friend-${STAR}`, (el) => el.closest('li')?.dataset.presence || '');
      if (word !== 'streaming') {
        await fanPage.mouse.move(600, 100);
        await fanPage.waitForSelector('#user-panel[data-open="false"]', { timeout: 5000 });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(word === 'streaming', `star reads ${word}`);
    const first = await fanPage.$eval('#friends-list li', (el) => el.querySelector('a')?.id || '');
    expect(first === `friend-${STAR}`, `first in the list is ${first}`);
    const corner = await fanPage.textContent('#friends-streaming');
    expect(corner === '1', `the corner says ${corner}`);
    return `${STAR} streaming, first; the corner says 1`;
  });

  await step('the card: the pointer resting on a row shows the face with the word on it, the name and their status; nothing counted', async () => {
    // star's status, as the profile tab would set it; the row holds it once the panel has asked the list again, which every open does
    const STATUS = 'hello from the card test';
    const put = await star.put(`/api/streamers/${STAR}`, { data: { bio: STATUS } });
    expect(put.status() === 200, `setting star's status got ${put.status()}`);
    await fanPage.mouse.move(600, 100);
    await fanPage.waitForSelector('#user-panel[data-open="false"]', { timeout: 5000 });
    await fanPage.hover('#user-panel');
    await fanPage.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    // the card comes 200ms after the pointer lands on a row of the open panel, whole: the row holds everything it says. the word is on the face
    await fanPage.hover(`#friend-${STAR}`);
    await fanPage.waitForSelector(`#friends-peek-${STAR}[data-presence="streaming"]`, { timeout: 5000 });
    // the status rides on the list answer the open started, which may land after the card: wait for it before reading
    await fanPage.waitForFunction(([sel, status]) => (document.querySelector(sel)?.textContent || '').includes(status), [`#friends-peek-${STAR}`, STATUS], { timeout: 10000 });
    // textContent runs the lines together: no word boundaries to lean on. the word is in it for a reader
    const text = (await fanPage.textContent(`#friends-peek-${STAR}`)) || '';
    expect(text.includes(STATUS) && /streaming/.test(text), `the card says "${text}"`);
    expect(!/follower/.test(text) && !/follows you/.test(text) && !/last live/.test(text) && !/joined/.test(text), `the card still counts: "${text}"`);
    // the free name: its word on the face, no status
    await fanPage.hover(`#friend-${FREE}`);
    await fanPage.waitForSelector(`#friends-peek-${STAR}`, { state: 'detached', timeout: 5000 });
    await fanPage.waitForSelector(`#friends-peek-${FREE}[data-presence]`, { timeout: 5000 });
    const free = (await fanPage.textContent(`#friends-peek-${FREE}`)) || '';
    expect(free.includes(FREE) && !/follower/.test(free) && !/joined/.test(free), `the free name's card says "${free}"`);
    return `"${text}"`;
  });

  await step('the search box: type a few letters, a result with a follow button; following it, the button is the list\'s × and the name joins the list', async () => {
    const other = 'pal' + RUN;
    const up = await anon.post('/api/signup', { data: { name: other, password: PW } });
    expect(up.status() === 201, `signup of ${other} got ${up.status()}`);
    await anon.post('/api/logout');
    await fanPage.hover('#user-panel');
    await fanPage.waitForSelector('#friends-search', { timeout: 10000 });
    await fanPage.fill('#friends-search', 'PAL' + RUN.slice(0, 2));
    await fanPage.waitForSelector(`#result-${other}`, { timeout: 10000 });
    const state = await fanPage.getAttribute(`#result-follow-${other}`, 'data-following');
    expect(state === 'false', `the button says following=${state}`);
    await fanPage.click(`#result-follow-${other}`);
    // followed: the row wears the lists' × now, in place of the follow button
    await fanPage.waitForSelector(`#result-unfollow-${other}`, { timeout: 10000 });
    expect(!(await fanPage.$(`#result-follow-${other}`)), 'the follow button is still on a followed result');
    const list = await body(await fan.get('/api/following'));
    expect(find(list, other), `${other} is not in the list: ${list.map((f) => f.name).join(' ')}`);
    await fanPage.fill('#friends-search', '');
    await fanPage.waitForSelector(`#friend-${other}`, { timeout: 10000 });
    return `${other} found and followed`;
  });

  await step('the watch page: the button says following, the count, unfollow and follow again move it', async () => {
    await fanPage.goto(`${BASE}/watch/${STAR}`, { waitUntil: 'domcontentloaded' });
    await fanPage.waitForFunction(() => document.querySelector('#follow')?.dataset.following === 'true', null, { timeout: 10000 });
    await fanPage.waitForFunction(() => /^1 follower$/.test(document.querySelector('#followers')?.textContent?.trim() || ''), null, { timeout: 10000 });
    await fanPage.click('#follow');
    await fanPage.waitForFunction(() => document.querySelector('#follow')?.dataset.following === 'false', null, { timeout: 10000 });
    await fanPage.waitForFunction(() => /^0 followers$/.test(document.querySelector('#followers')?.textContent?.trim() || ''), null, { timeout: 10000 });
    const gone = await body(await anon.get(`/api/streamers/${STAR}`));
    expect(gone.followers === 0, `after unfollow the api says ${gone.followers}`);
    await fanPage.click('#follow');
    await fanPage.waitForFunction(() => document.querySelector('#follow')?.dataset.following === 'true', null, { timeout: 10000 });
    const back = await body(await anon.get(`/api/streamers/${STAR}`));
    expect(back.followers === 1, `after following again the api says ${back.followers}`);
    return 'following → follow → following, 1 → 0 → 1';
  });

  await step('home: the people under the streams (star is live, so not there; pal is, with a word), online first; the sidebar search finds pal', async () => {
    const pal = 'pal' + RUN;
    const people = await body(await anon.get('/api/people'));
    expect(Array.isArray(people) && !find(people, STAR) && find(people, pal), `people: star ${!!find(people, STAR)}, pal ${!!find(people, pal)}`);
    const rank = { streaming: 0, online: 1, dnd: 2, offline: 3 };
    for (let i = 1; i < people.length; i++) expect(rank[people[i - 1].presence] <= rank[people[i].presence], `not online first: ${people[i - 1].name} ${people[i - 1].presence} before ${people[i].name} ${people[i].presence}`);
    await fanPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await fanPage.waitForSelector(`#person-${pal}`, { timeout: 15000 });
    expect(!(await fanPage.$(`#person-${STAR}`)), 'star is live and still listed as a person');
    const word = await fanPage.getAttribute(`#person-${pal}`, 'data-presence');
    expect(word && word in rank, `pal's card says ${word}`);
    const button = await fanPage.getAttribute(`#person-follow-${pal}`, 'data-following');
    expect(button === 'true', `pal's card button says following=${button}`);
    await fanPage.hover('#user-panel');
    await fanPage.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await fanPage.fill('#friends-search', 'PAL' + RUN.slice(0, 3));
    await fanPage.waitForSelector(`#result-${pal}`, { timeout: 10000 });
    await fanPage.click(`#result-${pal}`);
    await fanPage.waitForFunction((n) => location.pathname === `/watch/${n}`, pal, { timeout: 10000 });
    return `${people.length} people, ${pal} ${word}; the search went to /watch/${pal}`;
  });

  await step('nobody hovering sees the search and the pointer to an account; the button leads to it', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.hover('#user-panel');
    await p.waitForSelector('#friends-search', { timeout: 10000 });
    await p.fill('#friends-search', STAR);
    await p.waitForSelector(`#result-${STAR}`, { timeout: 10000 });
    await p.click(`#result-follow-${STAR}`);
    await p.waitForSelector('#sec-name', { timeout: 10000 });
    await p.close();
    return 'the security tab opened';
  });

  await step('a rename keeps the followers (the edge points at the id): the list says the new name', async () => {
    // stop first: a name does not change while live
    await starPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 20; i++) {
      const live = await body(await anon.post(`/api/streams/${STAR}/watch`));
      if (live && live.live === false) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const res = await star.post('/api/name', { data: { name: RENAMED, password: PW } });
    expect(res.status() === 200, `rename got ${res.status()} ${JSON.stringify(await body(res))}`);
    const list = await body(await fan.get('/api/following'));
    expect(find(list, RENAMED) && !find(list, STAR), `the list after the rename: ${list.map((f) => f.name).join(' ')}`);
    const p = await body(await fan.get(`/api/streamers/${RENAMED}`));
    expect(p.followers === 1 && p.following === true, `the new name says ${JSON.stringify(p)}`);
    return `${STAR} → ${RENAMED}, still followed`;
  });

  await step('home: recently offline has the name that just stopped, under its new name, with when it was last live', async () => {
    // the stop landed a moment ago (the page's beacon, or video noticing the publisher gone): the list says so within a few seconds
    let recent = [];
    for (let i = 0; i < 15 && !find(recent, RENAMED); i++) {
      recent = (await body(await anon.get('/api/recent'))) || [];
      if (!find(recent, RENAMED)) await new Promise((r) => setTimeout(r, 1000));
    }
    const r = find(recent, RENAMED);
    expect(r && !find(recent, STAR), `recent: ${recent.map((p) => p.name).join(' ')}`);
    const age = Date.now() - new Date(r.ended_at).getTime();
    expect(typeof r.presence === 'string' && age >= 0 && age < 10 * 60 * 1000, `ended_at ${r.ended_at} is ${Math.round(age / 1000)}s old`);
    const at = (p) => new Date(p.ended_at).getTime();
    for (let i = 1; i < recent.length; i++) expect(at(recent[i - 1]) >= at(recent[i]), `not newest first: ${recent[i - 1].name} then ${recent[i].name}`);
    // the profile read says the same end, under the new name
    const p = await body(await anon.get(`/api/streamers/${RENAMED}`));
    expect(p.last_live && new Date(p.last_live).getTime() === at(r), `the profile says last_live ${p.last_live}, recent says ${r.ended_at}`);
    await fanPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await fanPage.waitForSelector(`#recent-${RENAMED}`, { timeout: 15000 });
    const when = ((await fanPage.textContent(`#recent-when-${RENAMED}`)) || '').trim();
    expect(/^last live /.test(when), `the card says "${when}"`);
    return `${recent.length} recently offline, ${RENAMED} ${recent[0].name === RENAMED ? 'first' : 'listed'}; the card says "${when}"`;
  });

  await step('unfollow from the list: 204, gone, 0 followers; twice is 204 too', async () => {
    await fanPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await fanPage.hover('#user-panel');
    await fanPage.waitForSelector(`#friend-unfollow-${RENAMED}`, { timeout: 10000 });
    await fanPage.click(`#friend-unfollow-${RENAMED}`);
    await fanPage.waitForSelector(`#friend-${RENAMED}`, { state: 'detached', timeout: 10000 });
    const again = await fan.post(`/api/streamers/${RENAMED}/unfollow`);
    expect(again.status() === 204, `unfollowing again got ${again.status()}`);
    const p = await body(await anon.get(`/api/streamers/${RENAMED}`));
    expect(p.followers === 0, `after unfollow: ${JSON.stringify(p)}`);
    for (const n of [FREE, 'pal' + RUN]) await fan.post(`/api/streamers/${n}/unfollow`);
    const list = await body(await fan.get('/api/following'));
    expect(list.length === 0, `the list is not empty: ${list.map((f) => f.name).join(' ')}`);
    return 'nobody followed';
  });

  if (LOCAL) {
    // this run's signups count against this machine's ip for a while: forget them, like auth.js does
    execSync(`docker compose exec -T redis sh -c "redis-cli --scan --pattern 'rl:signup:*' | xargs -r redis-cli del"`, { cwd: REPO, stdio: 'ignore' });
  }

  await browser.close();
  await fan.dispose();
  await star.dispose();
  await anon.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\nFAIL  ${results.length - failed}/${results.length}` : `\nPASS  ${results.length}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
