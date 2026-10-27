// Groups: the list (bot built in), a login makes one, another joins and leaves, badges on chat
// lines, a bot's lines wear BOT and the panel hides them, only the maker deletes, the groups tab.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node groups.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const MAKER = 'maker' + RUN;
const MEMBER = 'member' + RUN;
const GROUP = 'grp' + RUN;
const ROOM = 'grouproom' + RUN;
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
const find = (list, name) => (Array.isArray(list) ? list.find((g) => g.name === name) : undefined);

(async () => {
  // three http clients: the one who makes the group, the one who joins it, and nobody
  const maker = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const member = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });

  await step('the list has bot, automatic and nobody\'s; nobody cannot make or join', async () => {
    const res = await anon.get('/api/groups');
    const list = await body(res);
    expect(res.status() === 200 && Array.isArray(list), `list got ${res.status()} ${JSON.stringify(list)}`);
    const bot = find(list, 'bot');
    expect(bot && bot.automatic === true && bot.made_by === null && bot.mine === false && bot.badge === 'BOT', `bot = ${JSON.stringify(bot)}`);
    expect(list[0].name === 'bot', `bot is not first: ${list.map((g) => g.name).join(' ')}`);
    const make = await anon.post('/api/groups', { data: { name: GROUP, badge: 'vip', color: '#f2cc60' } });
    const join = await anon.post('/api/groups/bot/join');
    expect(make.status() === 401 && join.status() === 401, `nobody got ${make.status()} and ${join.status()}`);
    return `${list.length} group(s), bot "${bot.badge}" ${bot.color}`;
  });

  await step('a login makes a group: bad badge 400, bad colour 400, bot 409, good one 201 and mine', async () => {
    const up = await maker.post('/api/signup', { data: { name: MAKER, password: PW } });
    expect(up.status() === 201, `signup got ${up.status()} ${JSON.stringify(await body(up))}`);
    const noBadge = await maker.post('/api/groups', { data: { name: GROUP, badge: '  ', color: '#f2cc60' } });
    const longBadge = await maker.post('/api/groups', { data: { name: GROUP, badge: 'x'.repeat(13), color: '#f2cc60' } });
    const badColor = await maker.post('/api/groups', { data: { name: GROUP, badge: 'vip', color: 'yellow' } });
    const badName = await maker.post('/api/groups', { data: { name: 'Has Space', badge: 'vip', color: '#f2cc60' } });
    expect([noBadge, longBadge, badColor, badName].every((r) => r.status() === 400), `bad ones got ${[noBadge, longBadge, badColor, badName].map((r) => r.status()).join(' ')}`);
    const taken = await maker.post('/api/groups', { data: { name: 'bot', badge: 'me', color: '#000000' } });
    expect(taken.status() === 409, `bot got ${taken.status()}`);
    const res = await maker.post('/api/groups', { data: { name: GROUP, badge: ' vip ', color: '#F2CC60', about: 'the test group' } });
    const made = await body(res);
    expect(res.status() === 201, `make got ${res.status()} ${JSON.stringify(made)}`);
    expect(made.name === GROUP && made.badge === 'vip' && made.color === '#f2cc60' && made.about === 'the test group' && made.made_by === MAKER && made.members === 1 && made.mine === true && made.automatic === false, `made = ${JSON.stringify(made)}`);
    const again = await maker.post('/api/groups', { data: { name: GROUP, badge: 'vip', color: '#f2cc60' } });
    expect(again.status() === 409, `the same name again got ${again.status()}`);
    const mine = find(await body(await maker.get('/api/groups')), GROUP);
    const theirs = find(await body(await anon.get('/api/groups')), GROUP);
    expect(mine && mine.mine === true && theirs && theirs.mine === false && theirs.members === 1, `listed as ${JSON.stringify(mine)} / ${JSON.stringify(theirs)}`);
    return `${GROUP}: badge trimmed, colour lowercased`;
  });

  await step('another login joins: 204, two members, again 204; bot 403, no such group 404', async () => {
    const up = await member.post('/api/signup', { data: { name: MEMBER, password: PW } });
    expect(up.status() === 201, `signup got ${up.status()}`);
    const join = await member.post(`/api/groups/${GROUP}/join`);
    expect(join.status() === 204, `join got ${join.status()} ${JSON.stringify(await body(join))}`);
    const listed = find(await body(await member.get('/api/groups')), GROUP);
    expect(listed && listed.mine === true && listed.members === 2, `after join: ${JSON.stringify(listed)}`);
    const twice = await member.post(`/api/groups/${GROUP}/join`);
    const bot = await member.post('/api/groups/bot/join');
    const none = await member.post(`/api/groups/nosuch${RUN}/join`);
    expect(twice.status() === 204 && bot.status() === 403 && none.status() === 404, `again ${twice.status()}, bot ${bot.status()}, no such ${none.status()}`);
    const still = find(await body(await member.get('/api/groups')), GROUP);
    expect(still.members === 2, `joining twice counted twice: ${still.members}`);
    return `"${(await body(bot)).error}"`;
  });

  // the pages: a member's lines wear the badge, a bot's wear BOT, and the panel hides the bots
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  let p;

  await step('chat as a member: the line wears the group\'s badge', async () => {
    p = await fresh();
    await p.goto(`${BASE}/login?next=/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', MEMBER);
    await p.fill('#auth-password', PW);
    await p.click('#auth-submit');
    await p.waitForSelector('#chat-text', { timeout: 15000 });
    await p.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, { timeout: 10000 });
    await p.fill('#chat-text', 'hi from a member');
    await p.click('#chat-send');
    await p.waitForFunction(
      ({ group, name }) => [...document.querySelectorAll('#chat-lines p')].some((l) => l.dataset.groups === group && l.dataset.verified === 'true' && l.textContent.includes(name) && l.textContent.includes('hi from a member')),
      { group: GROUP, name: MEMBER },
      { timeout: 10000 }
    );
    const badge = await p.$eval(`#chat-lines p[data-groups="${GROUP}"] [data-group="${GROUP}"]`, (el) => ({ text: el.textContent, color: el.style.backgroundColor }));
    expect(badge.text === 'vip', `badge reads "${badge.text}"`);
    expect(/242,\s*204,\s*96/.test(badge.color), `badge colour is ${badge.color}`);
    return `${MEMBER} ✓ [${badge.text}]`;
  });

  await step('a socket that says bot: true wears BOT, and the member\'s page sees it', async () => {
    // from a context with no login: the cookie would name the socket after the account instead of its nick
    const b = await fresh();
    await b.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const outcome = await b.evaluate(
      ({ room, nick }) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${room}`);
          const seen = [];
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', nick, bot: true }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            seen.push(msg.type);
            if (msg.type === 'history') ws.send(JSON.stringify({ type: 'say', text: 'beep boop' }));
            if (msg.type === 'message' && msg.text === 'beep boop') {
              ws.close();
              resolve({ groups: msg.groups, from: msg.from });
            }
            if (msg.type === 'error') resolve({ error: msg.error, seen });
          };
          setTimeout(() => resolve({ timeout: true, seen }), 8000);
        }),
      { room: ROOM, nick: 'beepboop' + RUN }
    );
    await b.close();
    expect(outcome.from === 'beepboop' + RUN && outcome.groups && outcome.groups.length === 1 && outcome.groups[0].name === 'bot' && outcome.groups[0].badge === 'BOT', `the bot's own line: ${JSON.stringify(outcome)}`);
    await p.waitForFunction(() => [...document.querySelectorAll('#chat-lines p')].some((l) => l.dataset.bot === 'true' && l.textContent.includes('beep boop')), null, { timeout: 10000 });
    const badge = await p.$eval('#chat-lines p[data-bot="true"] [data-group="bot"]', (el) => el.textContent);
    expect(badge === 'BOT', `the badge reads "${badge}"`);
    return `beepboop${RUN} [BOT]`;
  });

  await step('hide bots: the line goes, the header counts it, a reload keeps the choice, show brings it back', async () => {
    const before = await p.$eval('#chat-hide-bots', (b) => ({ pressed: b.getAttribute('aria-pressed'), text: b.textContent.trim() }));
    expect(before.pressed === 'false' && /hide bots/.test(before.text), `before: ${JSON.stringify(before)}`);
    await p.click('#chat-hide-bots');
    await p.waitForFunction(() => !document.querySelector('#chat-lines p[data-bot="true"]') && document.querySelector('#chat-hide-bots').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 });
    const hiding = await p.$eval('#chat-hide-bots', (b) => b.textContent.trim());
    expect(/^1 hidden$/.test(hiding), `the header says "${hiding}"`);
    const memberLine = await p.$(`#chat-lines p[data-groups="${GROUP}"]`);
    expect(memberLine, 'the member\'s line went too');
    // the choice is this browser's: a reload (history again) still hides the bot
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#chat-text', { timeout: 15000 });
    await p.waitForFunction((group) => document.querySelector(`#chat-lines p[data-groups="${group}"]`), GROUP, { timeout: 10000 });
    expect((await p.$('#chat-lines p[data-bot="true"]')) === null, 'the bot line is back after a reload');
    const afterReload = await p.$eval('#chat-hide-bots', (b) => b.textContent.trim());
    expect(/^1 hidden$/.test(afterReload), `after the reload the header says "${afterReload}"`);
    await p.click('#chat-hide-bots');
    await p.waitForSelector('#chat-lines p[data-bot="true"]', { timeout: 5000 });
    const shown = await p.$eval('#chat-hide-bots', (b) => b.textContent.trim());
    expect(/hide bots/.test(shown), `after showing the header says "${shown}"`);
    await p.close();
    return 'hidden, counted, kept, shown';
  });

  await step('leave: 204, one member, again 204', async () => {
    const leave = await member.post(`/api/groups/${GROUP}/leave`);
    expect(leave.status() === 204, `leave got ${leave.status()}`);
    const listed = find(await body(await member.get('/api/groups')), GROUP);
    expect(listed && listed.mine === false && listed.members === 1, `after leave: ${JSON.stringify(listed)}`);
    const twice = await member.post(`/api/groups/${GROUP}/leave`);
    expect(twice.status() === 204, `leaving again got ${twice.status()}`);
    return 'members back to 1';
  });

  await step('delete: a member 403, nobody 401, bot 403, the maker 204, then 404', async () => {
    const notMine = await member.delete(`/api/groups/${GROUP}`);
    const nobody = await anon.delete(`/api/groups/${GROUP}`);
    const bot = await maker.delete('/api/groups/bot');
    expect(notMine.status() === 403 && nobody.status() === 401 && bot.status() === 403, `member ${notMine.status()}, nobody ${nobody.status()}, bot ${bot.status()}`);
    const gone = await maker.delete(`/api/groups/${GROUP}`);
    expect(gone.status() === 204, `the maker got ${gone.status()}`);
    expect(find(await body(await anon.get('/api/groups')), GROUP) === undefined, 'still listed');
    const again = await maker.delete(`/api/groups/${GROUP}`);
    expect(again.status() === 404, `deleting again got ${again.status()}`);
    return `"${(await body(notMine)).error}"`;
  });

  await step('the groups tab: make one, it is listed with leave and on the card, delete it', async () => {
    const q = await fresh();
    await q.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await q.fill('#auth-name', MAKER);
    await q.fill('#auth-password', PW);
    await q.click('#auth-submit');
    await q.waitForSelector('#you', { timeout: 10000 });
    // the login page moves to home, and a page change closes the panel: wait for the move, then the gear at the
    // end of your line in the panel opens the modal (the picture is your page now)
    await q.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
    await q.hover('#user-panel');
    await q.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await q.click('#settings');
    await q.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await q.click('#tab-groups');
    await q.waitForSelector('#group-list #group-bot', { timeout: 10000 });
    const name = 'ui' + RUN;
    await q.fill('#group-name', name);
    await q.fill('#group-badge', 'ui');
    await q.click('#group-create');
    await q.waitForSelector(`#group-${name} #group-leave-${name}`, { timeout: 10000 });
    await q.waitForFunction((n) => document.querySelector('#group-status')?.textContent.includes(`made ${n}`), name, { timeout: 5000 });
    expect(await q.$(`#my-badges [data-group="${name}"]`), 'the badge is not on your badges');
    const row = await q.textContent(`#group-${name}`);
    expect(/1 member/.test(row) && new RegExp(`by ${MAKER}`).test(row), `the row reads "${row}"`);
    // the profile card wears it too
    await q.click('#tab-profile');
    await q.waitForSelector(`#panel-profile [data-group="${name}"]`, { timeout: 5000 });
    await q.click('#tab-groups');
    await q.waitForSelector(`#group-delete-${name}`, { timeout: 5000 });
    await q.click(`#group-delete-${name}`); // asks first
    await q.waitForFunction((n) => /sure\?/.test(document.querySelector(`#group-delete-${n}`)?.textContent || ''), name, { timeout: 5000 });
    await q.click(`#group-delete-${name}`);
    await q.waitForFunction((n) => !document.querySelector(`#group-${n}`), name, { timeout: 10000 });
    expect(find(await body(await anon.get('/api/groups')), name) === undefined, 'the api still lists it');
    await q.close();
    return `${name} made and deleted from the tab`;
  });

  if (LOCAL) {
    // this run's signups count against this machine's ip for an hour. forget them, like auth.js
    // does, so running the suite in a loop never locks the developer out. only those keys.
    execSync(`docker compose exec -T redis sh -c "redis-cli --scan --pattern 'rl:signup:*' | xargs -r redis-cli del"`, { cwd: REPO, stdio: 'ignore' });
  }

  await browser.close();
  await maker.dispose();
  await member.dispose();
  await anon.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
