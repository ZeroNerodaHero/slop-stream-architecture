// Groups: the list (bot built in), a login makes one (and up to the cap on owning, which
// explore says: GROUPS_PER_OWNER, 2 unless .env says otherwise; one more is 403), another
// joins and leaves, badges on chat lines, a bot's lines wear BOT and the panel hides them,
// only the maker deletes, the create dialog on /groups and the groups tab.
// The pictures are the owner's whatever the roles say (no remove), and a role reaches only the
// powers its holder has. A role is known by a uuid, and the manage dialog changes one in place:
// add role makes one and opens it, a save renames it, the row opens it again, delete is in there.
// The room: one answer with the channels, who is live, the roster (members only) and the bans,
// and the last lines of every channel; a watcher of `group:<name>` on the events socket hears a
// channel added, the channels put in order (the channels power; the whole order on the fact)
// and one deleted; the `*` chat socket carries every channel's lines with the channel on them
// and fills from `since`; the page switches channels with no reload, no refetch and no new
// socket, and a channel deleted under it is said on the page. A channel is added from the
// row under the list through a dialog, and the manage dialog's channels tab moves and deletes.
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
// the address, once the group exists: the title plus four digits. later steps use this.
let slug = GROUP;
const ROOM = 'grouproom' + RUN;
const PW = 'correct horse battery';
/** A role's id: a uuid the api made, never a counter. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
// how many groups one login may own, as explore says it. read once the api has answered.
let cap = 1;
/** Groups made so `ctx` owns as many as the cap allows, on top of the `owned` it has. Their addresses, to delete after. */
const fillToCap = async (ctx, owned, word) => {
  const made = [];
  for (let i = owned; i < cap; i++) {
    const res = await ctx.post('/api/groups', { data: { name: `${word}${i}${RUN}`, badge: 'more', color: '#f2cc60' } });
    expect(res.status() === 201, `group ${i + 1} of ${cap} got ${res.status()} ${JSON.stringify(await body(res))}`);
    made.push((await body(res)).name);
  }
  return made;
};
const dropAll = async (ctx, names) => {
  for (const name of names) {
    const res = await ctx.delete(`/api/groups/${name}`);
    expect(res.status() === 204, `dropping ${name} got ${res.status()}`);
  }
};

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

  await step('a login makes a group: bad badge 400, bad colour 400, bot 409, good one 201 and mine; one past the cap 403', async () => {
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
    const digits = String(made.tag).padStart(4, '0');
    expect(made.title === GROUP && made.tag === Number(digits) && made.name === `${GROUP}-${digits}` && made.badge === 'vip' && made.color === '#f2cc60' && made.about === 'the test group' && made.made_by === MAKER && made.members === 1 && made.mine === true && made.automatic === false && made.public === true, `made = ${JSON.stringify(made)}`);
    slug = made.name;
    // the cap on owning is the box's (GROUPS_PER_OWNER), and explore says it: up to it 201, one more 403, whatever the name
    const found = await body(await maker.get('/api/explore'));
    expect(found && Number.isInteger(found.groups_per_owner) && found.groups_per_owner >= 1, `explore's cap ${JSON.stringify(found && found.groups_per_owner)}`);
    cap = found.groups_per_owner;
    const extra = await fillToCap(maker, 1, 'more');
    const again = await maker.post('/api/groups', { data: { name: 'another' + RUN, badge: 'two', color: '#f2cc60' } });
    const refused = await body(again);
    expect(again.status() === 403 && /you own .*already/.test(refused && refused.error), `group ${cap + 1} got ${again.status()} ${JSON.stringify(refused)}`);
    // the maker owns one from here on
    await dropAll(maker, extra);
    const mine = find(await body(await maker.get('/api/groups')), slug);
    const theirs = find(await body(await anon.get('/api/groups')), slug);
    expect(mine && mine.mine === true && theirs && theirs.mine === false && theirs.members === 1, `listed as ${JSON.stringify(mine)} / ${JSON.stringify(theirs)}`);
    return `${slug}: badge trimmed, colour lowercased, ${cap} owned then "${refused.error}"`;
  });

  await step('explore: the maker has it in yours, as owner, with general and a live list', async () => {
    const res = await maker.get('/api/explore');
    const data = await body(res);
    expect(res.status() === 200 && data && Array.isArray(data.yours) && Array.isArray(data.discover), `explore got ${res.status()} ${JSON.stringify(data)}`);
    const server = data.yours.find((s) => s.name === slug);
    const elsewhere = data.discover.find((s) => s.name === slug);
    expect(server && !elsewhere, `placed ${JSON.stringify(server)}`);
    expect(server.owner === true, `owner ${JSON.stringify(server.owner)}`);
    expect(server.channels.some((c) => c.name === 'general' && c.can_delete === false), `channels ${JSON.stringify(server.channels)}`);
    expect(Array.isArray(server.live), `live ${JSON.stringify(server.live)}`);
    const guest = await body(await anon.get('/api/explore'));
    const seen = [...guest.yours, ...guest.discover].find((s) => s.name === slug);
    expect(seen && seen.mine === false && seen.owner === false && Array.isArray(seen.live), `a guest sees ${JSON.stringify(seen)}`);
    return `${server.channels.length} channel(s), ${server.live.length} live`;
  });

  await step('another login makes the same title (another address), joins: 204, two members, again 204; bot 403, no such group 404', async () => {
    const up = await member.post('/api/signup', { data: { name: MEMBER, password: PW } });
    expect(up.status() === 201, `signup got ${up.status()}`);
    // the same title from somebody else is another group, with other digits
    const same = await member.post('/api/groups', { data: { name: GROUP, badge: 'vip', color: '#f2cc60' } });
    const other = await body(same);
    expect(same.status() === 201 && other.title === GROUP && other.name !== slug && other.name.startsWith(`${GROUP}-`), `the same title again got ${same.status()} ${JSON.stringify(other)}`);
    const join = await member.post(`/api/groups/${slug}/join`);
    expect(join.status() === 204, `join got ${join.status()} ${JSON.stringify(await body(join))}`);
    const listed = find(await body(await member.get('/api/groups')), slug);
    expect(listed && listed.mine === true && listed.members === 2, `after join: ${JSON.stringify(listed)}`);
    // the cap the other way too: owning as many as it allows, they cannot be named an owner here
    const extra = await fillToCap(member, 1, 'theirs');
    const named = await maker.post(`/api/groups/${slug}/owners`, { data: { name: MEMBER } });
    expect(named.status() === 403 && new RegExp(`${MEMBER} owns .*already`).test((await body(named)).error), `naming an owner at the cap got ${named.status()} ${JSON.stringify(await body(named))}`);
    await dropAll(member, [...extra, other.name]);
    const twice = await member.post(`/api/groups/${slug}/join`);
    const bot = await member.post('/api/groups/bot/join');
    const none = await member.post(`/api/groups/nosuch${RUN}/join`);
    expect(twice.status() === 204 && bot.status() === 403 && none.status() === 404, `again ${twice.status()}, bot ${bot.status()}, no such ${none.status()}`);
    const still = find(await body(await member.get('/api/groups')), slug);
    expect(still.members === 2, `joining twice counted twice: ${still.members}`);
    return `"${(await body(bot)).error}"`;
  });

  await step('the maker is the owner; a member cannot make a role, the maker can', async () => {
    const room = await body(await maker.get(`/api/groups/${slug}`));
    expect(room.owner === true && room.public === true && room.member_order === 'name' && room.perms && room.perms.roles === true && room.perms.channels === true, `the maker's room ${JSON.stringify(room)}`);
    const theirs = await body(await member.get(`/api/groups/${slug}`));
    expect(theirs.owner === false && theirs.mine === true && theirs.perms.roles === false, `the member's room ${JSON.stringify(theirs)}`);
    const no = await member.post(`/api/groups/${slug}/roles`, { data: { name: 'mod', color: '#f85149', perms: { kick: true } } });
    const nobody = await anon.post(`/api/groups/${slug}/roles`, { data: { name: 'mod', color: '#f85149', perms: { kick: true } } });
    expect(no.status() === 403 && nobody.status() === 401, `member ${no.status()}, nobody ${nobody.status()}`);
    const yes = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'mod', color: '#f85149', perms: { kick: true, ban: false } } });
    const made = await body(yes);
    expect(yes.status() === 201 && made.name === 'mod' && made.perms && made.perms.kick === true && made.perms.ban === false, `role ${yes.status()} ${JSON.stringify(made)}`);
    expect(typeof made.id === 'string' && UUID.test(made.id), `a role's id is ${JSON.stringify(made.id)}, not a uuid`);
    // the id is what the role is known by: a rename is a save, and the id stays
    const renamed = await maker.put(`/api/groups/${slug}/roles/${made.id}`, { data: { name: 'mods', color: '#f85149', perms: { kick: true } } });
    const after = await body(renamed);
    expect(renamed.status() === 200 && after.id === made.id && after.name === 'mods', `renaming got ${renamed.status()} ${JSON.stringify(after)}`);
    const notARole = await maker.put(`/api/groups/${slug}/roles/12345`, { data: { name: 'x', color: '#f85149', perms: {} } });
    expect(notARole.status() === 400 || notARole.status() === 404, `a counter for an id got ${notARole.status()}`);
    const owned = await member.post(`/api/groups/${slug}/owners`, { data: { name: MEMBER } });
    expect(owned.status() === 403, `a member naming an owner got ${owned.status()}`);
    const priv = await maker.put(`/api/groups/${slug}/access`, { data: { public: false } });
    const hidden = find(await body(await anon.get('/api/groups')), slug);
    const stillMine = find(await body(await maker.get('/api/groups')), slug);
    expect(priv.status() === 200 && (await body(priv)).public === false && hidden === undefined && stillMine && stillMine.public === false && stillMine.mine === true, `private got ${priv.status()} anon ${JSON.stringify(hidden)} maker ${JSON.stringify(stillMine)}`);
    const pub = await maker.put(`/api/groups/${slug}/access`, { data: { public: true } });
    expect(pub.status() === 200 && (await body(pub)).public === true, `public again got ${pub.status()}`);
    const ordered = await maker.put(`/api/groups/${slug}/order`, { data: { order: 'newest' } });
    const refused = await member.put(`/api/groups/${slug}/order`, { data: { order: 'oldest' } });
    const bad = await maker.put(`/api/groups/${slug}/order`, { data: { order: 'rank' } });
    expect(ordered.status() === 200 && (await body(ordered)).order === 'newest' && refused.status() === 403 && bad.status() === 400, `order ${ordered.status()}, member ${refused.status()}, bad ${bad.status()}`);
    const people = await body(await maker.get(`/api/groups/${slug}/members`));
    expect(Array.isArray(people) && people[0] && people[0].name === MAKER && people[0].owner === true, `roster ${JSON.stringify(people)}`);
    const back = await maker.put(`/api/groups/${slug}/order`, { data: { order: 'name' } });
    expect(back.status() === 200, `name again got ${back.status()}`);
    return 'owner, a mod role, and private';
  });

  await step('the pictures are the owner\'s whatever the roles say; a role reaches only the powers its holder has', async () => {
    // a jpeg by its first bytes: the api checks the magic and the size, nothing more
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const put = (ctx, kind, data) => ctx.put(`/api/groups/${slug}/${kind}`, { data, headers: { 'content-type': 'image/jpeg' } });
    const role = (ctx, perms, name) => ctx.post(`/api/groups/${slug}/roles`, { data: { name, color: '#3fb950', perms } });
    // every power there is, on the member: still not the pictures
    const everything = await body(await role(maker, { appearance: true, roles: true, channels: true, kick: true, ban: true }, 'everything'));
    expect(everything && everything.id, `the everything role ${JSON.stringify(everything)}`);
    const given = await maker.post(`/api/groups/${slug}/roles/${everything.id}/members`, { data: { name: MEMBER } });
    expect(given.status() === 204, `giving everything got ${given.status()}`);
    const theirIcon = await put(member, 'icon', JPEG);
    const theirBanner = await put(member, 'banner', JPEG);
    const nobody = await put(anon, 'icon', JPEG);
    expect(theirIcon.status() === 403 && theirBanner.status() === 403 && nobody.status() === 401, `the member's pictures got ${theirIcon.status()} and ${theirBanner.status()}, nobody's ${nobody.status()}`);
    const icon = await put(maker, 'icon', JPEG);
    const banner = await put(maker, 'banner', JPEG);
    expect(icon.status() === 200 && Number.isInteger((await body(icon)).icon) && banner.status() === 200 && Number.isInteger((await body(banner)).banner), `the owner's pictures got ${icon.status()} and ${banner.status()}`);
    const notJpeg = await put(maker, 'icon', Buffer.from('not a picture'));
    const remove = await maker.delete(`/api/groups/${slug}/icon`);
    expect(notJpeg.status() === 400 && remove.status() === 405, `not a jpeg ${notJpeg.status()}, remove ${remove.status()} (there is no remove)`);
    const room = await body(await anon.get(`/api/groups/${slug}`));
    expect(Number.isInteger(room.icon) && Number.isInteger(room.banner), `the room's versions ${JSON.stringify([room.icon, room.banner])}`);
    // the member holds the roles power and nothing else: a role that carries more is out of reach
    const took = await maker.delete(`/api/groups/${slug}/roles/${everything.id}/members/${MEMBER}`);
    const roler = await body(await role(maker, { roles: true }, 'roler'));
    const held = await maker.post(`/api/groups/${slug}/roles/${roler.id}/members`, { data: { name: MEMBER } });
    expect(took.status() === 204 && roler.id && held.status() === 204, `swapping to roler: ${took.status()} ${JSON.stringify(roler)} ${held.status()}`);
    const over = await role(member, { roles: true, ban: true }, 'sneaky');
    const within = await role(member, { roles: true }, 'helper');
    const helper = await body(within);
    expect(over.status() === 403 && within.status() === 201, `a role with ban got ${over.status()}, with roles alone ${within.status()}`);
    const grab = await member.post(`/api/groups/${slug}/roles/${everything.id}/members`, { data: { name: MEMBER } });
    const reshape = await member.put(`/api/groups/${slug}/roles/${everything.id}`, { data: { name: 'everything', color: '#3fb950', perms: { roles: true } } });
    const drop = await member.delete(`/api/groups/${slug}/roles/${everything.id}`);
    expect(grab.status() === 403 && reshape.status() === 403 && drop.status() === 403, `everything, from the member: give ${grab.status()}, change ${reshape.status()}, delete ${drop.status()}`);
    const touch = await member.post(`/api/groups/${slug}/roles/${helper.id}/members`, { data: { name: MAKER } });
    expect(touch.status() === 403 && /owner/.test((await body(touch)).error), `giving the owner a role got ${touch.status()} ${JSON.stringify(await body(touch))}`);
    const ok = await member.put(`/api/groups/${slug}/roles/${helper.id}`, { data: { name: 'helper', color: '#f85149', perms: { roles: true } } });
    const gone = await member.delete(`/api/groups/${slug}/roles/${helper.id}`);
    expect(ok.status() === 200 && gone.status() === 204, `the member's own role: change ${ok.status()}, delete ${gone.status()}`);
    // the member as they were, with no roles, for the steps after
    for (const id of [everything.id, roler.id]) {
      const cleared = await maker.delete(`/api/groups/${slug}/roles/${id}`);
      expect(cleared.status() === 204, `clearing role ${id} got ${cleared.status()}`);
    }
    return `owner 200, member 403, remove ${remove.status()}; ban out of reach, the owner untouched`;
  });

  await step('the room is one answer: channels, live, the roster for a member, null for a guest; messages has every channel', async () => {
    const mine = await body(await maker.get(`/api/groups/${slug}`));
    expect(mine && Array.isArray(mine.channels) && mine.channels.some((c) => c.name === 'general' && c.can_delete === false), `the maker's channels ${JSON.stringify(mine && mine.channels)}`);
    expect(Array.isArray(mine.live), `live ${JSON.stringify(mine.live)}`);
    expect(mine.admin === false, `admin ${JSON.stringify(mine.admin)}`);
    expect(Array.isArray(mine.roster) && mine.roster.length === 2, `the maker's roster ${JSON.stringify(mine.roster)}`);
    const owner = mine.roster.find((m) => m.name === MAKER);
    const other = mine.roster.find((m) => m.name === MEMBER);
    expect(owner && owner.owner === true && typeof owner.joined === 'number' && other && other.owner === false, `roster rows ${JSON.stringify(mine.roster)}`);
    expect(mine.roster[0].name === MAKER, `owners first: ${mine.roster.map((m) => m.name).join(' ')}`);
    expect(Array.isArray(mine.bans) && mine.bans.length === 0, `the maker's bans ${JSON.stringify(mine.bans)}`);
    const theirs = await body(await member.get(`/api/groups/${slug}`));
    expect(Array.isArray(theirs.roster) && theirs.roster.length === 2 && theirs.bans === null, `the member's roster ${JSON.stringify(theirs.roster)} bans ${JSON.stringify(theirs.bans)}`);
    const guest = await body(await anon.get(`/api/groups/${slug}`));
    expect(guest.roster === null && guest.bans === null && Array.isArray(guest.channels) && guest.members === 2, `a guest's room ${JSON.stringify(guest)}`);
    const lines = await anon.get(`/api/groups/${slug}/messages`);
    const byChannel = await body(lines);
    expect(lines.status() === 200 && byChannel && Array.isArray(byChannel.general) && Object.keys(byChannel).length === guest.channels.length, `messages got ${lines.status()} ${JSON.stringify(byChannel)}`);
    const bot = await anon.get('/api/groups/bot/messages');
    const none = await anon.get(`/api/groups/nosuch${RUN}/messages`);
    expect(bot.status() === 404 && none.status() === 404, `bot ${bot.status()}, no such ${none.status()}`);
    return `${guest.channels.length} channel(s), roster for members only`;
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
      { group: slug, name: MEMBER },
      { timeout: 10000 }
    );
    const badge = await p.$eval(`#chat-lines p[data-groups="${slug}"] [data-group="${slug}"]`, (el) => ({ text: el.textContent, color: el.style.backgroundColor }));
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
    const memberLine = await p.$(`#chat-lines p[data-groups="${slug}"]`);
    expect(memberLine, 'the member\'s line went too');
    // the choice is this browser's: a reload (history again) still hides the bot
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#chat-text', { timeout: 15000 });
    await p.waitForFunction((group) => document.querySelector(`#chat-lines p[data-groups="${group}"]`), slug, { timeout: 10000 });
    expect((await p.$('#chat-lines p[data-bot="true"]')) === null, 'the bot line is back after a reload');
    const afterReload = await p.$eval('#chat-hide-bots', (b) => b.textContent.trim());
    expect(/^1 hidden$/.test(afterReload), `after the reload the header says "${afterReload}"`);
    await p.click('#chat-hide-bots');
    await p.waitForSelector('#chat-lines p[data-bot="true"]', { timeout: 5000 });
    const shown = await p.$eval('#chat-hide-bots', (b) => b.textContent.trim());
    expect(/hide bots/.test(shown), `after showing the header says "${shown}"`);
    return 'hidden, counted, kept, shown';
  });

  await step('a watcher of group:<name> on the events socket hears a channel added, the channels put in order, and one deleted', async () => {
    // a raw /events socket from a context with no login: hello as nobody, then watch the room's topic
    const w = await fresh();
    await w.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const ready = await w.evaluate(
      (topic) =>
        new Promise((resolve) => {
          window.__groupFrames = [];
          const ws = new WebSocket(`wss://${location.host}/events`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'me') {
              ws.send(JSON.stringify({ type: 'watch', name: topic }));
              resolve({ ok: true });
            }
            if (msg.type === 'group') window.__groupFrames.push(msg);
            if (msg.type === 'error') resolve({ error: msg.error });
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      `group:${slug}`
    );
    expect(ready.ok, `the events socket: ${JSON.stringify(ready)}`);
    const added = await maker.post(`/api/groups/${slug}/channels`, { data: { name: 'clips' } });
    const channel = await body(added);
    expect(added.status() === 201 && channel.name === 'clips' && channel.made_by === MAKER && channel.can_delete === true, `adding clips got ${added.status()} ${JSON.stringify(channel)}`);
    await w.waitForFunction(() => window.__groupFrames.some((f) => f.what === 'channel' && f.channel && f.channel.name === 'clips'), null, { timeout: 10000 });
    const heard = await w.evaluate(() => window.__groupFrames.find((f) => f.what === 'channel'));
    expect(heard.group === slug && heard.channel.made_by === MAKER, `the channel frame ${JSON.stringify(heard)}`);
    // the new channel is last; the channels power puts them in order, and everyone hears the whole order.
    // a member without the power cannot, nobody cannot, and a name that is not a channel or named twice is 400
    const before = await body(await anon.get(`/api/groups/${slug}`));
    expect(before.channels.map((c) => c.name).join(' ') === 'general clips', `before the move: ${before.channels.map((c) => c.name).join(' ')}`);
    const noPower = await member.put(`/api/groups/${slug}/channels`, { data: { order: ['clips', 'general'] } });
    const nobodyMoves = await anon.put(`/api/groups/${slug}/channels`, { data: { order: ['clips', 'general'] } });
    const notOne = await maker.put(`/api/groups/${slug}/channels`, { data: { order: ['clips', 'nosuch'] } });
    const twice = await maker.put(`/api/groups/${slug}/channels`, { data: { order: ['clips', 'clips'] } });
    expect(noPower.status() === 403 && nobodyMoves.status() === 401 && notOne.status() === 400 && twice.status() === 400, `moving: member ${noPower.status()}, nobody ${nobodyMoves.status()}, not a channel ${notOne.status()}, twice ${twice.status()}`);
    // the named ones first in that order; one not named (general here) keeps its place after them
    const moved = await maker.put(`/api/groups/${slug}/channels`, { data: { order: ['clips'] } });
    const order = await body(moved);
    expect(moved.status() === 200 && order.order.join(' ') === 'clips general', `the move got ${moved.status()} ${JSON.stringify(order)}`);
    await w.waitForFunction(() => window.__groupFrames.some((f) => f.what === 'channel_order'), null, { timeout: 10000 });
    const ordered = await w.evaluate(() => window.__groupFrames.find((f) => f.what === 'channel_order'));
    expect(ordered.group === slug && Array.isArray(ordered.order) && ordered.order.join(' ') === 'clips general', `the channel_order frame ${JSON.stringify(ordered)}`);
    const after = await body(await anon.get(`/api/groups/${slug}`));
    expect(after.channels.map((c) => c.name).join(' ') === 'clips general', `after the move the room lists ${after.channels.map((c) => c.name).join(' ')}`);
    const explored = await body(await maker.get('/api/explore'));
    const mine = explored.yours.find((g) => g.name === slug);
    expect(mine && mine.channels.map((c) => c.name).join(' ') === 'clips general', `explore lists ${JSON.stringify(mine && mine.channels.map((c) => c.name))}`);
    const gone = await maker.delete(`/api/groups/${slug}/channels/clips`);
    expect(gone.status() === 204, `deleting clips got ${gone.status()}`);
    await w.waitForFunction(() => window.__groupFrames.some((f) => f.what === 'unchannel' && f.channel === 'clips'), null, { timeout: 10000 });
    const frames = await w.evaluate(() => window.__groupFrames.map((f) => f.what));
    await w.close();
    return `heard ${frames.join(', ')}`;
  });

  await step('the server socket: every channel on one socket, a line with its channel, and the fill after since', async () => {
    // the member's page is logged in: a raw /chat/<server>/* socket from it speaks as the member
    const outcome = await p.evaluate(
      ({ server, text }) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/*`);
          const seen = [];
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'hello' }));
            // no channel: refused with words that do not close the socket
            ws.send(JSON.stringify({ type: 'say', text: 'where?' }));
            ws.send(JSON.stringify({ type: 'say', text, channel: 'general' }));
          };
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            seen.push(msg);
            if (msg.type === 'message' && msg.text === text) {
              ws.close();
              resolve({ line: msg, errors: seen.filter((m) => m.type === 'error').map((m) => m.error), history: seen.some((m) => m.type === 'history') });
            }
          };
          setTimeout(() => resolve({ timeout: true, seen }), 8000);
        }),
      { server: slug, text: 'hello general ' + RUN }
    );
    expect(outcome.line, `the server socket: ${JSON.stringify(outcome)}`);
    expect(outcome.line.channel === 'general' && outcome.line.from === MEMBER && outcome.line.verified === true, `the line ${JSON.stringify(outcome.line)}`);
    expect(outcome.errors.includes('say which channel'), `a say with no channel got ${JSON.stringify(outcome.errors)}`);
    expect(outcome.history === false, 'a server socket sent a history frame');
    // a second socket says what it has (nothing: id 0-0) and is sent the line it missed
    const filled = await p.evaluate(
      ({ server, text }) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/*`);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'hello' }));
            ws.send(JSON.stringify({ type: 'since', since: { general: '0-0' } }));
          };
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'message' && msg.text === text) {
              ws.close();
              resolve({ line: msg });
            }
            if (msg.type === 'error') resolve({ error: msg.error });
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      { server: slug, text: 'hello general ' + RUN }
    );
    expect(filled.line && filled.line.channel === 'general', `the fill: ${JSON.stringify(filled)}`);
    const lines = await body(await anon.get(`/api/groups/${slug}/messages`));
    expect(lines.general.some((l) => l.text === 'hello general ' + RUN && l.from === MEMBER), `messages has it: ${JSON.stringify(lines.general)}`);
    await p.close();
    return `#general: "${outcome.line.text}", filled once`;
  });

  await step('the room page: the channel list, a pushed channel, a switch with no reload, refetch or socket, a line lands, a deleted channel is said', async () => {
    const q = await fresh();
    await q.goto(`${BASE}/login?next=/groups/${slug}`, { waitUntil: 'domcontentloaded' });
    await q.fill('#auth-name', MEMBER);
    await q.fill('#auth-password', PW);
    await q.click('#auth-submit');
    await q.waitForSelector('#group-channels', { timeout: 15000 });
    await q.waitForSelector('#chat[data-phase="open"]', { timeout: 15000 });
    const count = await q.$$eval('#group-channels > li', (rows) => rows.length);
    expect(count === 1, `the channel list has ${count} row(s)`);
    expect(await q.$('#group-members'), 'a member has no roster');
    // the api's lines are on the page before anything else is said
    await q.waitForFunction((t) => [...document.querySelectorAll('#chat-lines [data-id]')].some((l) => l.textContent.includes(t)), 'hello general ' + RUN, { timeout: 10000 });
    // from here: no ask of the room, and no new chat socket, whatever the page does
    let roomAsks = 0;
    let sockets = 0;
    q.on('request', (r) => {
      if (new URL(r.url()).pathname === `/api/groups/${slug}`) roomAsks++;
    });
    q.on('websocket', (ws) => {
      if (ws.url().includes('/chat/')) sockets++;
    });
    const added = await maker.post(`/api/groups/${slug}/channels`, { data: { name: 'clips' } });
    expect(added.status() === 201, `adding clips got ${added.status()}`);
    await q.waitForSelector('#group-channel-clips', { timeout: 10000 });
    const after = await q.$$eval('#group-channels > li', (rows) => rows.length);
    expect(after === 2, `after the push the channel list has ${after} row(s)`);
    await q.click('#group-channel-clips');
    await q.waitForURL((u) => u.pathname === `/groups/${slug}/clips`, { timeout: 10000 });
    await q.waitForFunction(() => document.querySelector('#channel')?.textContent === '#clips', null, { timeout: 10000 });
    const phase = await q.getAttribute('#chat', 'data-phase');
    expect(phase === 'open', `the chat is ${phase} after the switch`);
    expect(roomAsks === 0 && sockets === 0, `the switch asked the room ${roomAsks} time(s) and opened ${sockets} chat socket(s)`);
    expect(!(await q.$(`#chat-lines [data-id]`)), '#clips shows another channel\'s lines');
    await q.fill('#chat-text', 'first in clips');
    await q.click('#chat-send');
    await q.waitForFunction(() => [...document.querySelectorAll('#chat-lines [data-id]')].some((l) => l.textContent.includes('first in clips')), null, { timeout: 10000 });
    // back to general: its lines, not these; and back again: the shelf kept them
    await q.click('#group-channel-general');
    await q.waitForFunction(() => document.querySelector('#channel')?.textContent === '#general', null, { timeout: 10000 });
    await q.waitForFunction((t) => [...document.querySelectorAll('#chat-lines [data-id]')].some((l) => l.textContent.includes(t)), 'hello general ' + RUN, { timeout: 10000 });
    expect(!(await q.$$eval('#chat-lines [data-id]', (els) => els.some((l) => l.textContent.includes('first in clips')))), '#general shows the clips line');
    await q.click('#group-channel-clips');
    await q.waitForFunction(() => [...document.querySelectorAll('#chat-lines [data-id]')].some((l) => l.textContent.includes('first in clips')), null, { timeout: 10000 });
    expect(roomAsks === 0 && sockets === 0, `switching asked the room ${roomAsks} time(s) and opened ${sockets} chat socket(s)`);
    // the maker deletes the channel under the page
    const gone = await maker.delete(`/api/groups/${slug}/channels/clips`);
    expect(gone.status() === 204, `deleting clips got ${gone.status()}`);
    await q.waitForFunction(() => document.body.textContent.includes('no such channel'), null, { timeout: 10000 });
    expect(!(await q.$('#group-channel-clips')), 'the deleted channel is still listed');
    await q.close();
    return 'switched twice, nothing asked, nothing opened';
  });

  await step('leave: the only owner stays while someone else is in; then 204, one member, again 204', async () => {
    const blocked = await maker.post(`/api/groups/${slug}/leave`);
    expect(blocked.status() === 403, `the owner leaving got ${blocked.status()} ${(await blocked.text())}`);
    const leave = await member.post(`/api/groups/${slug}/leave`);
    expect(leave.status() === 204, `leave got ${leave.status()}`);
    const listed = find(await body(await member.get('/api/groups')), slug);
    expect(listed && listed.mine === false && listed.members === 1, `after leave: ${JSON.stringify(listed)}`);
    const twice = await member.post(`/api/groups/${slug}/leave`);
    expect(twice.status() === 204, `leaving again got ${twice.status()}`);
    return 'name another owner first, then members back to 1';
  });

  await step('delete is refused for a member, nobody, and bot', async () => {
    const notMine = await member.delete(`/api/groups/${slug}`);
    const nobody = await anon.delete(`/api/groups/${slug}`);
    const bot = await maker.delete('/api/groups/bot');
    expect(notMine.status() === 403 && nobody.status() === 401 && bot.status() === 403, `member ${notMine.status()}, nobody ${nobody.status()}, bot ${bot.status()}`);
    const still = find(await body(await maker.get('/api/groups')), slug);
    expect(still && still.mine === true && still.members === 1, `the group went: ${JSON.stringify(still)}`);
    return `"${(await body(notMine)).error}"`;
  });

  await step('the last member leaving deletes the group', async () => {
    const leave = await maker.post(`/api/groups/${slug}/leave`);
    expect(leave.status() === 204, `the owner leaving got ${leave.status()} ${(await leave.text())}`);
    expect(find(await body(await anon.get('/api/groups')), slug) === undefined, 'still listed');
    const again = await maker.delete(`/api/groups/${slug}`);
    expect(again.status() === 404, `deleting again got ${again.status()}`);
    return 'gone';
  });

  await step('home and /groups offer create under the cap; the dialog makes one and lands on it; manage: private, a role added, renamed and deleted in place; a channel added from the list\'s dialog, moved up and deleted on the channels tab; at the cap home offers nothing; the tab lists it with leave and on the card, delete it', async () => {
    const q = await fresh();
    await q.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await q.fill('#auth-name', MAKER);
    await q.fill('#auth-password', PW);
    await q.click('#auth-submit');
    await q.waitForSelector('#you', { timeout: 10000 });
    // the login page moves to home. the maker owns nothing now (the group went when they left), so
    // home offers create beside the groups heading, and the heading itself opens /groups
    await q.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
    await q.waitForSelector('#home-groups-create', { timeout: 10000 });
    await q.click('#groups-home');
    await q.waitForSelector('#groups-title', { timeout: 10000 });
    expect(new URL(q.url()).pathname === '/groups', q.url());
    await q.waitForSelector('#groups-create', { timeout: 10000 });
    await q.click('#groups-create');
    await q.waitForSelector('#groups-make[open]', { timeout: 5000 });
    const name = 'ui' + RUN;
    await q.fill('#groups-make-name', name);
    await q.fill('#groups-make-badge', 'ui');
    await q.click('#groups-make-submit');
    // made: the page is the new room, its address the title and four digits
    await q.waitForURL((u) => u.pathname.startsWith(`/groups/${name}-`), { timeout: 10000 });
    const madeName = decodeURIComponent(new URL(q.url()).pathname.split('/')[2]);
    expect(new RegExp(`^${name}-\\d{4}$`).test(madeName), `landed on ${q.url()}`);
    await q.waitForSelector('#group-banner', { timeout: 10000 });
    // public or private is under manage, not in the header. the owner switches it there, and the pressed word follows the socket
    expect(!(await q.$('#room-private')), 'the header still has the public/private switch');
    await q.click('#group-manage-open');
    // the dialog is a rail of tabs; an owner lands on about, which holds the listing
    await q.waitForSelector('#group-manage[open] #manage-tab-about[aria-selected="true"]', { timeout: 5000 });
    await q.waitForSelector('#manage-panel-about #room-public[aria-pressed="true"]', { timeout: 5000 });
    // the pictures are the owner's, so about offers them too: the square and the banner, each the click for a new one
    expect(await q.$('#manage-panel-about #manage-icon-pick'), 'about has no picture pick for the owner');
    expect(await q.$('#manage-panel-about #manage-banner-pick'), 'about has no banner pick for the owner');
    await q.click('#room-private');
    await q.waitForSelector('#group-manage[open] #room-private[aria-pressed="true"]', { timeout: 10000 });
    const room = await body(await maker.get(`/api/groups/${madeName}`));
    expect(room && room.public === false, `after private the room says ${JSON.stringify(room && room.public)}`);
    // roles are changed in place, under their tab. add role makes one called new role and opens it with the name
    // selected; a name, a power and save rename it; its row is the click to open it again; delete is in there
    await q.click('#manage-tab-roles');
    await q.waitForSelector('#manage-panel-roles #role-add', { timeout: 5000 });
    await q.click('#role-add');
    await q.waitForSelector('#group-manage[open] #group-roles li[data-open] #role-name', { timeout: 10000 });
    const started = await q.inputValue('#role-name');
    expect(started === 'new role', `a new role is called "${started}"`);
    await q.fill('#role-name', 'helpers');
    await q.check('#role-perm-kick');
    await q.click('#role-save');
    await q.waitForSelector('#group-roles li[data-role="helpers"]:not([data-open])', { timeout: 10000 });
    expect(!(await q.$('#role-name')), 'the editor stayed open after save');
    const rolesRow = await q.textContent('#group-roles li[data-role="helpers"]');
    expect(/kick/.test(rolesRow), `the row reads "${rolesRow}"`);
    const roles = await body(await maker.get(`/api/groups/${madeName}/roles`));
    const helpers = Array.isArray(roles) && roles.find((r) => r.name === 'helpers');
    expect(helpers && UUID.test(helpers.id) && helpers.perms.kick === true && !roles.some((r) => r.name === 'new role'), `the api's roles ${JSON.stringify(roles)}`);
    await q.click('#group-roles li[data-role="helpers"] button');
    await q.waitForSelector('#group-roles li[data-role="helpers"][data-open] #role-name', { timeout: 5000 });
    expect((await q.inputValue('#role-name')) === 'helpers', 'the editor opened on another role');
    await q.click('#role-delete');
    await q.waitForFunction(() => !document.querySelector('#group-roles li[data-role="helpers"]'), null, { timeout: 10000 });
    await q.click('#group-manage-close');
    await q.waitForFunction(() => !document.querySelector('#group-manage'), null, { timeout: 5000 });
    // a channel is added from the row under the list, not a box in it: the dialog takes the name (typed to the
    // name rule) and a line about it, and the page is the new channel, which goes under general
    expect(!(await q.$(`#channel-name-${madeName}`)), 'the channel list still has a name box');
    await q.click('#group-channel-add');
    await q.waitForSelector('#channel-make[open]', { timeout: 5000 });
    await q.fill('#channel-make-name', 'Clips!');
    expect((await q.inputValue('#channel-make-name')) === 'clips', `the name box reads "${await q.inputValue('#channel-make-name')}"`);
    await q.fill('#channel-make-about', 'the best bits');
    await q.click('#channel-make-submit');
    await q.waitForURL((u) => u.pathname === `/groups/${madeName}/clips`, { timeout: 10000 });
    await q.waitForFunction(() => !document.querySelector('#channel-make'), null, { timeout: 5000 });
    const channelNames = () =>
      q.$$eval('#group-channels > li', (rows) => rows.map((row) => (row.querySelector('a') || row.querySelector('[aria-current]')).textContent.trim().replace(/^#/, '')));
    expect((await channelNames()).join(' ') === 'general clips', `the list reads ${(await channelNames()).join(' ')}`);
    const clips = (await body(await maker.get(`/api/groups/${madeName}`))).channels.find((c) => c.name === 'clips');
    expect(clips && clips.about === 'the best bits', `the api's clips ${JSON.stringify(clips)}`);
    // the channels tab of manage: the rows in the list's order; up moves clips to the top, the api is told
    // and the list on the left follows; delete asks first, and the channel on screen going moves the page to general
    await q.click('#group-manage-open');
    await q.waitForSelector('#group-manage[open] #manage-tab-channels', { timeout: 5000 });
    await q.click('#manage-tab-channels');
    await q.waitForSelector('#manage-panel-channels #manage-channels li[data-channel="clips"]', { timeout: 5000 });
    const rowsBefore = await q.$$eval('#manage-channels li', (rows) => rows.map((row) => row.dataset.channel));
    expect(rowsBefore.join(' ') === 'general clips', `the tab's rows read ${rowsBefore.join(' ')}`);
    expect(!(await q.$('#channel-remove-general')), 'general has a delete');
    const put = q.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/groups/${madeName}/channels`, { timeout: 10000 });
    await q.click('#channel-up-clips');
    const putRes = await put;
    expect(putRes.status() === 200, `the move got ${putRes.status()}`);
    await q.waitForFunction(() => document.querySelector('#manage-channels li')?.dataset.channel === 'clips', null, { timeout: 10000 });
    expect((await channelNames()).join(' ') === 'clips general', `after the move the list reads ${(await channelNames()).join(' ')}`);
    const movedRoom = await body(await maker.get(`/api/groups/${madeName}`));
    expect(movedRoom.channels.map((c) => c.name).join(' ') === 'clips general', `the api lists ${movedRoom.channels.map((c) => c.name).join(' ')}`);
    await q.click('#channel-remove-clips');
    await q.waitForSelector('#manage-channel-delete-clips[open]', { timeout: 5000 });
    await q.click('#manage-channel-delete-clips-yes');
    await q.waitForURL((u) => u.pathname === `/groups/${madeName}`, { timeout: 10000 });
    await q.waitForFunction(() => !document.querySelector('#group-channel-clips') && !document.querySelector('#manage-channels li[data-channel="clips"]'), null, { timeout: 10000 });
    await q.waitForSelector('#group-manage[open]', { timeout: 5000 });
    await q.click('#group-manage-close');
    await q.waitForFunction(() => !document.querySelector('#group-manage'), null, { timeout: 5000 });
    // the maker owns one. under the cap home still offers create; owning as many as the cap allows, it does not
    await q.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await q.waitForSelector('#groups-count', { timeout: 10000 });
    if (cap > 1) {
      await q.waitForSelector('#home-groups-create', { timeout: 10000 });
    }
    const extra = await fillToCap(maker, 1, 'full');
    await q.reload({ waitUntil: 'domcontentloaded' });
    await q.waitForSelector('#groups-count', { timeout: 10000 });
    expect(!(await q.$('#home-groups-create')), `home still offers create to a login owning ${cap} of ${cap}`);
    await dropAll(maker, extra);
    // the gear at the end of your line in the panel opens the modal; the tab lists the group as yours
    await q.hover('#user-panel');
    await q.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await q.click('#settings');
    await q.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await q.click('#tab-groups');
    await q.waitForSelector(`#group-list #group-${madeName} #group-leave-${madeName}`, { timeout: 10000 });
    expect(!(await q.$('#group-create')), 'the tab still has a make form');
    expect(await q.$(`#my-badges [data-group="${madeName}"]`), 'the badge is not on your badges');
    const row = await q.textContent(`#group-${madeName}`);
    expect(/1 member/.test(row) && new RegExp(`by ${MAKER}`).test(row) && row.includes(name), `the row reads "${row}"`);
    // the profile card wears it too
    await q.click('#tab-profile');
    await q.waitForSelector(`#panel-profile [data-group="${madeName}"]`, { timeout: 5000 });
    await q.click('#tab-groups');
    await q.waitForSelector(`#group-delete-${madeName}`, { timeout: 5000 });
    await q.click(`#group-delete-${madeName}`); // asks first
    await q.waitForSelector(`#group-delete-${madeName}-confirm`, { timeout: 5000 });
    await q.click(`#group-delete-${madeName}-confirm-yes`);
    await q.waitForFunction((n) => !document.querySelector(`#group-${n}`), madeName, { timeout: 10000 });
    expect(find(await body(await anon.get('/api/groups')), madeName) === undefined, 'the api still lists it');
    await q.close();
    return `${madeName} made from /groups, landed on its room, deleted from the tab`;
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
