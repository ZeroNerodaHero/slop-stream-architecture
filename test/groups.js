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
// The sidebar's search box finds the group by its letters, its row above the people's, and
// the row goes to its page.
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

  await step('a watcher of group:<name> on the events socket hears a channel added, the channels put in order, one renamed, and one deleted', async () => {
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
    // the name changes: the member mutes clips and says a line in it first, so both can be seen to follow the name.
    // a member without the power cannot rename, nobody cannot, general stays, a history word and a name the server
    // has are refused; then clips is highlights (typed any way), its place kept, and everyone hears channel_renamed
    const muted = await member.put(`/api/groups/${slug}/channels/clips/mute`);
    expect(muted.status() === 204, `muting clips got ${muted.status()}`);
    const said = await p.evaluate(
      ({ server, text }) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/clips`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'history') ws.send(JSON.stringify({ type: 'say', text }));
            if (msg.type === 'message' && msg.text === text) {
              ws.close();
              resolve({ ok: true });
            }
            if (msg.type === 'error') resolve({ error: msg.error });
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      { server: slug, text: 'first clip ' + RUN }
    );
    expect(said.ok, `a line in clips: ${JSON.stringify(said)}`);
    const memberRenames = await member.put(`/api/groups/${slug}/channels/clips`, { data: { name: 'highlights' } });
    const nobodyRenames = await anon.put(`/api/groups/${slug}/channels/clips`, { data: { name: 'highlights' } });
    const generalStays = await maker.put(`/api/groups/${slug}/channels/general`, { data: { name: 'lobby' } });
    const reserved = await maker.put(`/api/groups/${slug}/channels/clips`, { data: { name: 'search' } });
    const taken = await maker.put(`/api/groups/${slug}/channels/clips`, { data: { name: 'general' } });
    expect(
      memberRenames.status() === 403 && nobodyRenames.status() === 401 && generalStays.status() === 403 && reserved.status() === 400 && taken.status() === 409,
      `renaming: member ${memberRenames.status()}, nobody ${nobodyRenames.status()}, general ${generalStays.status()}, reserved ${reserved.status()}, taken ${taken.status()}`
    );
    const renamed = await maker.put(`/api/groups/${slug}/channels/clips`, { data: { name: ' Highlights ' } });
    const highlights = await body(renamed);
    expect(renamed.status() === 200 && highlights.name === 'highlights' && highlights.made_by === MAKER && highlights.can_delete === true, `the rename got ${renamed.status()} ${JSON.stringify(highlights)}`);
    await w.waitForFunction(() => window.__groupFrames.some((f) => f.what === 'channel_renamed'), null, { timeout: 10000 });
    const heardRename = await w.evaluate(() => window.__groupFrames.find((f) => f.what === 'channel_renamed'));
    expect(heardRename.group === slug && heardRename.channel === 'clips' && heardRename.name === 'highlights', `the channel_renamed frame ${JSON.stringify(heardRename)}`);
    const asMember = await body(await member.get(`/api/groups/${slug}`));
    expect(asMember.channels.map((c) => c.name).join(' ') === 'highlights general', `after the rename the room lists ${asMember.channels.map((c) => c.name).join(' ')}`);
    expect(asMember.muted.join(' ') === 'highlights', `the mute followed the name: ${JSON.stringify(asMember.muted)}`);
    const movedLines = await body(await anon.get(`/api/groups/${slug}/messages`));
    expect(
      !movedLines.clips && Array.isArray(movedLines.highlights) && movedLines.highlights.some((l) => l.text === 'first clip ' + RUN),
      `the lines followed the name: ${JSON.stringify(Object.keys(movedLines))} ${JSON.stringify(movedLines.highlights)}`
    );
    const oldName = await maker.delete(`/api/groups/${slug}/channels/clips`);
    expect(oldName.status() === 404, `the old name got ${oldName.status()}`);
    const gone = await maker.delete(`/api/groups/${slug}/channels/highlights`);
    expect(gone.status() === 204, `deleting highlights got ${gone.status()}`);
    await w.waitForFunction(() => window.__groupFrames.some((f) => f.what === 'unchannel' && f.channel === 'highlights'), null, { timeout: 10000 });
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

  await step('a channel kept to a role: its holders, the owners and the channels power see it, nobody else does, anywhere', async () => {
    // the maker adds #staff and a role that keeps it. general cannot be kept; a channel that is not there cannot be named
    const staff = await maker.post(`/api/groups/${slug}/channels`, { data: { name: 'staff', about: 'staff only' } });
    expect(staff.status() === 201, `adding staff got ${staff.status()}`);
    const generalKept = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'nope', color: '#f2cc60', channels: ['general'] } });
    const noSuch = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'nope', color: '#f2cc60', channels: ['nosuch'] } });
    expect(generalKept.status() === 400 && noSuch.status() === 404, `keeping general got ${generalKept.status()}, a missing channel ${noSuch.status()}`);
    const made = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'staffers', color: '#f2cc60', channels: [' Staff '] } });
    const staffers = await body(made);
    expect(made.status() === 201 && staffers.channels.join(' ') === 'staff', `the role got ${made.status()} ${JSON.stringify(staffers)}`);
    // the member holds no role: not in their room (the role still says what it keeps), explore or messages; nobody's either; the owner's, yes
    const asMember = await body(await member.get(`/api/groups/${slug}`));
    expect(!asMember.channels.some((c) => c.name === 'staff'), `the member's room lists ${asMember.channels.map((c) => c.name).join(' ')}`);
    expect(asMember.roles.find((r) => r.id === staffers.id).channels.join(' ') === 'staff', `the member's room says the role keeps ${JSON.stringify(asMember.roles)}`);
    const asNobody = await body(await anon.get(`/api/groups/${slug}`));
    expect(!asNobody.channels.some((c) => c.name === 'staff'), `nobody's room lists ${asNobody.channels.map((c) => c.name).join(' ')}`);
    const asOwner = await body(await maker.get(`/api/groups/${slug}`));
    expect(asOwner.channels.some((c) => c.name === 'staff'), `the owner's room lists ${asOwner.channels.map((c) => c.name).join(' ')}`);
    const explored = await body(await member.get('/api/explore'));
    const inExplore = explored.yours.find((g) => g.name === slug);
    expect(inExplore && !inExplore.channels.some((c) => c.name === 'staff'), `explore lists ${JSON.stringify(inExplore && inExplore.channels.map((c) => c.name))}`);
    const memberLines = await body(await member.get(`/api/groups/${slug}/messages`));
    const ownerLines = await body(await maker.get(`/api/groups/${slug}/messages`));
    expect(!('staff' in memberLines) && 'general' in memberLines && 'staff' in ownerLines, `messages: member ${Object.keys(memberLines).join(' ')}, owner ${Object.keys(ownerLines).join(' ')}`);
    const memberSearch = await member.get(`/chat/${slug}/staff/search?q=staff`);
    expect(memberSearch.status() === 404, `the member's search in staff got ${memberSearch.status()}`);
    // the member's sockets: the single channel's says no such channel; the server's does not follow it, so a say in it is refused
    const asMemberPage = await (await browser.newContext({ ignoreHTTPSErrors: true, storageState: await member.storageState() })).newPage();
    await asMemberPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const single = await asMemberPage.evaluate(
      (server) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/staff`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'error' || msg.type === 'history') {
              ws.close();
              resolve({ type: msg.type, error: msg.error });
            }
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      slug
    );
    expect(single.error === 'no such channel', `the single socket said ${JSON.stringify(single)}`);
    const onServer = await asMemberPage.evaluate(
      (server) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/*`);
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'hello' }));
            ws.send(JSON.stringify({ type: 'say', text: 'psst', channel: 'staff' }));
          };
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'error') {
              ws.close();
              resolve({ error: msg.error });
            }
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      slug
    );
    expect(onServer.error === 'say which channel', `the server socket said ${JSON.stringify(onServer)}`);
    // the owner says a line in staff: no inbox row for the member, who does not see it
    const asOwnerPage = await (await browser.newContext({ ignoreHTTPSErrors: true, storageState: await maker.storageState() })).newPage();
    await asOwnerPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const say = (text) =>
      asOwnerPage.evaluate(
        ({ server, text }) =>
          new Promise((resolve) => {
            const ws = new WebSocket(`wss://${location.host}/chat/${server}/staff`);
            ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
            ws.onmessage = (e) => {
              const msg = JSON.parse(e.data);
              if (msg.type === 'history') ws.send(JSON.stringify({ type: 'say', text }));
              if (msg.type === 'message' && msg.text === text) {
                ws.close();
                resolve({ ok: true });
              }
              if (msg.type === 'error') resolve({ error: msg.error });
            };
            setTimeout(() => resolve({ timeout: true }), 8000);
          }),
        { server: slug, text }
      );
    const hidden = await say('staff only ' + RUN);
    expect(hidden.ok, `the owner's line in staff: ${JSON.stringify(hidden)}`);
    await new Promise((r) => setTimeout(r, 1500));
    const inboxBefore = await body(await member.get('/api/notifications'));
    expect(!inboxBefore.items.some((i) => i.kind === 'chat' && i.room === `${slug}/staff`), `the member got a row for a channel they do not see: ${JSON.stringify(inboxBefore.items.filter((i) => i.kind === 'chat'))}`);
    // given the role, the member sees it: the room, the messages with the line said before, the single socket's history, and a row for the next line
    const given = await maker.post(`/api/groups/${slug}/roles/${staffers.id}/members`, { data: { name: MEMBER } });
    expect(given.status() === 204, `giving the role got ${given.status()}`);
    const nowSees = await body(await member.get(`/api/groups/${slug}`));
    expect(nowSees.channels.some((c) => c.name === 'staff'), `with the role the room lists ${nowSees.channels.map((c) => c.name).join(' ')}`);
    const nowLines = await body(await member.get(`/api/groups/${slug}/messages`));
    expect(Array.isArray(nowLines.staff) && nowLines.staff.some((l) => l.text === 'staff only ' + RUN), `with the role messages has ${JSON.stringify(nowLines.staff)}`);
    const singleNow = await asMemberPage.evaluate(
      (server) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`wss://${location.host}/chat/${server}/staff`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'error' || msg.type === 'history') {
              ws.close();
              resolve({ type: msg.type, error: msg.error, n: (msg.messages || []).length });
            }
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      slug
    );
    expect(singleNow.type === 'history' && singleNow.n >= 1, `with the role the single socket said ${JSON.stringify(singleNow)}`);
    const seen = await say('staff again ' + RUN);
    expect(seen.ok, `the owner's second line: ${JSON.stringify(seen)}`);
    await new Promise((r) => setTimeout(r, 1500));
    const inboxAfter = await body(await member.get('/api/notifications'));
    expect(inboxAfter.items.some((i) => i.kind === 'chat' && i.room === `${slug}/staff` && /staff again/.test(i.text)), `with the role no row came: ${JSON.stringify(inboxAfter.items.filter((i) => i.kind === 'chat'))}`);
    // the roles power cannot unlock what it cannot see: the role taken back, a role with the roles power cannot name staff
    const taken = await maker.delete(`/api/groups/${slug}/roles/${staffers.id}/members/${MEMBER}`);
    expect(taken.status() === 204, `taking the role got ${taken.status()}`);
    const shapers = await body(await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'shapers', color: '#f2cc60', perms: { roles: true } } }));
    expect(UUID.test(shapers.id) && shapers.channels.length === 0, `the shapers role ${JSON.stringify(shapers)}`);
    expect((await maker.post(`/api/groups/${slug}/roles/${shapers.id}/members`, { data: { name: MEMBER } })).status() === 204, 'giving shapers failed');
    const unlock = await member.put(`/api/groups/${slug}/roles/${shapers.id}`, { data: { name: 'shapers', color: '#f2cc60', perms: { roles: true }, channels: ['staff'] } });
    expect(unlock.status() === 404, `the roles power unlocking a hidden channel got ${unlock.status()} ${JSON.stringify(await body(unlock))}`);
    // the owner lets the channel go: everyone's again
    const freed = await maker.put(`/api/groups/${slug}/roles/${staffers.id}`, { data: { name: 'staffers', color: '#f2cc60', channels: [] } });
    expect(freed.status() === 200 && (await body(freed)).channels.length === 0, `letting staff go got ${freed.status()}`);
    const freeRoom = await body(await anon.get(`/api/groups/${slug}`));
    expect(freeRoom.channels.some((c) => c.name === 'staff'), `after letting go nobody's room lists ${freeRoom.channels.map((c) => c.name).join(' ')}`);
    await asMemberPage.context().close();
    await asOwnerPage.context().close();
    for (const id of [staffers.id, shapers.id]) await maker.delete(`/api/groups/${slug}/roles/${id}`);
    expect((await maker.delete(`/api/groups/${slug}/channels/staff`)).status() === 204, 'deleting staff failed');
    return 'hidden from the member everywhere, seen with the role, the roles power cannot unlock it';
  });

  await step('the owner role: a word on the group, owner until an owner renames it; a custom role cannot take it, nor it a custom role\'s', async () => {
    const before = await body(await anon.get(`/api/groups/${slug}`));
    expect(before.owner_role === 'owner', `the room says the owner role is ${JSON.stringify(before.owner_role)}`);
    const asOwner = await maker.post(`/api/groups/${slug}/roles`, { data: { name: ' Owner ', color: '#f2cc60' } });
    expect(asOwner.status() === 400 && /reserved/.test((await body(asOwner)).error), `a custom role called owner got ${asOwner.status()}`);
    const crew = await body(await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'crew', color: '#f2cc60' } }));
    expect(UUID.test(crew.id), `the crew role ${JSON.stringify(crew)}`);
    const nobody = await anon.put(`/api/groups/${slug}/owner-role`, { data: { name: 'boss' } });
    const notOwner = await member.put(`/api/groups/${slug}/owner-role`, { data: { name: 'boss' } });
    const bad = await maker.put(`/api/groups/${slug}/owner-role`, { data: { name: '   ' } });
    const taken = await maker.put(`/api/groups/${slug}/owner-role`, { data: { name: 'Crew' } });
    expect(nobody.status() === 401 && notOwner.status() === 403 && bad.status() === 400 && taken.status() === 409, `renaming the owner role: nobody ${nobody.status()}, member ${notOwner.status()}, bad ${bad.status()}, taken ${taken.status()}`);
    const renamed = await maker.put(`/api/groups/${slug}/owner-role`, { data: { name: ' Boss ' } });
    expect(renamed.status() === 200 && (await body(renamed)).name === 'Boss', `the rename got ${renamed.status()} ${JSON.stringify(await body(renamed))}`);
    const after = await body(await member.get(`/api/groups/${slug}`));
    expect(after.owner_role === 'Boss', `after the rename the room says ${JSON.stringify(after.owner_role)}`);
    // the word owner is free now, and the new name is the reserved one
    const ownerFree = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'owner', color: '#f2cc60' } });
    const bossTaken = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'boss', color: '#f2cc60' } });
    expect(ownerFree.status() === 201 && bossTaken.status() === 400, `after the rename a role called owner got ${ownerFree.status()}, one called boss ${bossTaken.status()}`);
    for (const id of [crew.id, (await body(ownerFree)).id]) await maker.delete(`/api/groups/${slug}/roles/${id}`);
    expect((await maker.put(`/api/groups/${slug}/owner-role`, { data: { name: 'owner' } })).status() === 200, 'renaming the owner role back failed');
    return 'owner → Boss → owner';
  });

  await step('transfer ownership: the members tab asks first, then the group is the member\'s and not the maker\'s; the api refuses the rest', async () => {
    const nobody = await anon.post(`/api/groups/${slug}/transfer`, { data: { name: MEMBER } });
    const notOwner = await member.post(`/api/groups/${slug}/transfer`, { data: { name: MAKER } });
    const self = await maker.post(`/api/groups/${slug}/transfer`, { data: { name: MAKER } });
    const stranger = await maker.post(`/api/groups/${slug}/transfer`, { data: { name: 'nosuch' + RUN } });
    expect(nobody.status() === 401 && notOwner.status() === 403 && self.status() === 400 && stranger.status() === 404, `transfer: nobody ${nobody.status()}, member ${notOwner.status()}, self ${self.status()}, stranger ${stranger.status()}`);
    // the maker's page, on the members tab: no box to name an owner; transfer ownership on the member's row asks, no leaves it, yes hands it on
    const o = await fresh();
    await o.goto(`${BASE}/login?next=/groups/${slug}`, { waitUntil: 'domcontentloaded' });
    await o.fill('#auth-name', MAKER);
    await o.fill('#auth-password', PW);
    await o.click('#auth-submit');
    await o.waitForSelector('#group-manage-open', { timeout: 15000 });
    await o.click('#group-manage-open');
    await o.waitForSelector('#group-manage[open] #manage-tab-members', { timeout: 5000 });
    await o.click('#manage-tab-members');
    await o.waitForSelector(`#manage-members li[data-member="${MEMBER}"] #transfer-owner-${MEMBER}`, { timeout: 5000 });
    expect(!(await o.$('#owner-name')) && !(await o.$('#owner-grant')), 'the members tab still has the box to name an owner');
    expect(!(await o.$(`#transfer-owner-${MAKER}`)), 'the maker can transfer the group to themselves');
    await o.click(`#transfer-owner-${MEMBER}`);
    await o.waitForSelector(`#transfer-owner-${MEMBER}-confirm[open]`, { timeout: 5000 });
    await o.click(`#transfer-owner-${MEMBER}-confirm-no`);
    await o.waitForFunction((n) => !document.querySelector(`#transfer-owner-${n}-confirm`), MEMBER, { timeout: 5000 });
    expect(await o.$('#group-manage[open]'), 'no closed the manage dialog too');
    expect((await body(await maker.get(`/api/groups/${slug}`))).owner === true, 'no handed the group on');
    await o.click(`#transfer-owner-${MEMBER}`);
    await o.waitForSelector(`#transfer-owner-${MEMBER}-confirm[open]`, { timeout: 5000 });
    const posted = o.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/groups/${slug}/transfer`, { timeout: 10000 });
    await o.click(`#transfer-owner-${MEMBER}-confirm-yes`);
    expect((await posted).status() === 204, 'the transfer did not get 204');
    await o.waitForSelector(`#manage-members li[data-member="${MEMBER}"][data-owner]`, { timeout: 10000 });
    await o.waitForFunction((n) => !document.querySelector(`#manage-members li[data-member="${n}"][data-owner]`), MAKER, { timeout: 10000 });
    const handed = await body(await member.get(`/api/groups/${slug}`));
    const left = await body(await maker.get(`/api/groups/${slug}`));
    expect(handed.owner === true && left.owner === false && left.mine === true, `after the transfer the member owns: ${handed.owner}, the maker: ${left.owner}, still in: ${left.mine}`);
    expect((await maker.post(`/api/groups/${slug}/transfer`, { data: { name: MEMBER } })).status() === 403, 'the old owner can still hand the group on');
    await o.close();
    // and back, so the rest of the run finds the maker owning it
    const back = await member.post(`/api/groups/${slug}/transfer`, { data: { name: MAKER } });
    expect(back.status() === 204 && (await body(await maker.get(`/api/groups/${slug}`))).owner === true, `handing it back got ${back.status()}`);
    return `${MAKER} → ${MEMBER} → ${MAKER}`;
  });

  await step('a timeout keeps a member quiet in the chat until it ends or is lifted; a role\'s cooldown spaces its holders\' lines', async () => {
    const asMemberPage = await (await browser.newContext({ ignoreHTTPSErrors: true, storageState: await member.storageState() })).newPage();
    const asOwnerPage = await (await browser.newContext({ ignoreHTTPSErrors: true, storageState: await maker.storageState() })).newPage();
    await asMemberPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await asOwnerPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    /** A line said in general over a raw channel socket from `page`: `{ ok }`, or the refusal `{ error, wait }`. */
    const say = (page, text) =>
      page.evaluate(
        ({ server, text }) =>
          new Promise((resolve) => {
            const ws = new WebSocket(`wss://${location.host}/chat/${server}/general`);
            ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
            ws.onmessage = (e) => {
              const msg = JSON.parse(e.data);
              if (msg.type === 'history') ws.send(JSON.stringify({ type: 'say', text }));
              if (msg.type === 'message' && msg.text === text) {
                ws.close();
                resolve({ ok: true });
              }
              if (msg.type === 'error') {
                ws.close();
                resolve({ error: msg.error, wait: msg.wait });
              }
            };
            setTimeout(() => resolve({ timeout: true }), 8000);
          }),
        { server: slug, text }
      );
    // the timeout: the kick power, not yourself, ten seconds at least, a member; then the member is quiet and the roster says until when
    const noPower = await member.post(`/api/groups/${slug}/timeout`, { data: { name: MAKER, seconds: 60 } });
    const self = await maker.post(`/api/groups/${slug}/timeout`, { data: { name: MAKER, seconds: 60 } });
    const tooShort = await maker.post(`/api/groups/${slug}/timeout`, { data: { name: MEMBER, seconds: 5 } });
    const stranger = await maker.post(`/api/groups/${slug}/timeout`, { data: { name: 'nosuch' + RUN, seconds: 60 } });
    expect(noPower.status() === 403 && self.status() === 400 && tooShort.status() === 400 && stranger.status() === 404, `timing out: member ${noPower.status()}, self ${self.status()}, short ${tooShort.status()}, stranger ${stranger.status()}`);
    const quiet = await maker.post(`/api/groups/${slug}/timeout`, { data: { name: MEMBER, seconds: 60 } });
    expect(quiet.status() === 204, `the timeout got ${quiet.status()}`);
    const roster = (await body(await maker.get(`/api/groups/${slug}`))).roster;
    const until = roster.find((m) => m.name === MEMBER).timeout;
    expect(typeof until === 'number' && until > Date.now() / 1000 && until <= Date.now() / 1000 + 61, `the roster says the timeout ends at ${until}`);
    const refused = await say(asMemberPage, 'am i quiet ' + RUN);
    expect(refused.error === 'timed out' && refused.wait > 0 && refused.wait <= 60000, `the timed-out member's line: ${JSON.stringify(refused)}`);
    const ownerSays = await say(asOwnerPage, 'the owner talks ' + RUN);
    expect(ownerSays.ok, `the owner's line: ${JSON.stringify(ownerSays)}`);
    const lifted = await maker.delete(`/api/groups/${slug}/timeout/${MEMBER}`);
    expect(lifted.status() === 204 && (await body(await maker.get(`/api/groups/${slug}`))).roster.find((m) => m.name === MEMBER).timeout === null, `lifting got ${lifted.status()}`);
    const freed = await say(asMemberPage, 'free again ' + RUN);
    expect(freed.ok, `the lifted member's line: ${JSON.stringify(freed)}`);
    // the cooldown: a role with 30s given to the member spaces their lines; the owner holding it waits for nobody
    const slow = await body(await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'slow', color: '#f2cc60', cooldown: 30 } }));
    expect(UUID.test(slow.id) && slow.cooldown === 30, `the slow role ${JSON.stringify(slow)}`);
    const tooLong = await maker.post(`/api/groups/${slug}/roles`, { data: { name: 'slower', color: '#f2cc60', cooldown: 3601 } });
    expect(tooLong.status() === 400, `a cooldown over an hour got ${tooLong.status()}`);
    for (const name of [MEMBER, MAKER]) expect((await maker.post(`/api/groups/${slug}/roles/${slow.id}/members`, { data: { name } })).status() === 204, `giving slow to ${name} failed`);
    const first = await say(asMemberPage, 'first of two ' + RUN);
    const second = await say(asMemberPage, 'second of two ' + RUN);
    expect(first.ok && second.error === 'cooldown' && second.wait > 0 && second.wait <= 30000, `the member's two lines: ${JSON.stringify(first)} then ${JSON.stringify(second)}`);
    const ownerFirst = await say(asOwnerPage, 'owner one ' + RUN);
    const ownerSecond = await say(asOwnerPage, 'owner two ' + RUN);
    expect(ownerFirst.ok && ownerSecond.ok, `the owner's two lines: ${JSON.stringify(ownerFirst)} then ${JSON.stringify(ownerSecond)}`);
    expect((await maker.delete(`/api/groups/${slug}/roles/${slow.id}`)).status() === 204, 'deleting slow failed');
    await asMemberPage.context().close();
    await asOwnerPage.context().close();
    return 'quiet for a minute, lifted; one line in 30s with the role, the owner unslowed';
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

  await step('the sidebar search: letters find the group, its row first and the people under it; the row goes to its page', async () => {
    const q = await fresh();
    await q.goto(`${BASE}/login?next=/`, { waitUntil: 'domcontentloaded' });
    await q.fill('#auth-name', MEMBER);
    await q.fill('#auth-password', PW);
    await q.click('#auth-submit');
    await q.waitForSelector('#user-panel', { timeout: 15000 });
    await q.hover('#user-panel');
    await q.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    // the run's letters are in the group's title and in both logins' names: the group comes first all the same
    await q.fill('#friends-search', RUN);
    await q.waitForSelector(`#result-group-${slug}`, { timeout: 10000 });
    await q.waitForSelector(`#result-${MAKER}`, { timeout: 10000 });
    const first = await q.$eval('#friends-results > li', (el) => el.querySelector('a')?.id || '');
    expect(first === `result-group-${slug}`, `first in the results is ${first}`);
    // the panel is open, so the row has its words: the title with the digits
    const words = (await q.textContent(`#result-group-${slug}`)) || '';
    expect(words.includes(GROUP) && words.includes(`#${slug.slice(-4)}`), `the group's row reads "${words}"`);
    await q.click(`#result-group-${slug}`);
    await q.waitForURL((u) => u.pathname === `/groups/${slug}`, { timeout: 10000 });
    await q.close();
    return `${slug} first, ${MAKER} under it; the row went to /groups/${slug}`;
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
    // the owner role is the first row, a crown and the word owner; for an owner it opens as the name alone, and the crowns follow the rename
    const ownerRow = await q.textContent('#group-roles li:first-child[data-owner][data-role="owner"]');
    expect(/owner/.test(ownerRow) && /every power/.test(ownerRow), `the owner row reads "${ownerRow}"`);
    expect(await q.$('#group-members li[data-owner] [data-owner-mark][aria-label="owner"]'), 'the roster has no crown on the owner');
    await q.click('#group-roles li[data-owner] button');
    await q.waitForSelector('#group-roles li[data-owner][data-open] #owner-role-name', { timeout: 5000 });
    expect((await q.inputValue('#owner-role-name')) === 'owner', `the owner role box reads "${await q.inputValue('#owner-role-name')}"`);
    expect(!(await q.$('#group-roles li[data-owner] #role-delete')) && (await q.$$('#group-roles li[data-owner] [aria-label="powers"] button[aria-pressed="true"][aria-disabled="true"]')).length === 5, 'the owner editor is not every power, locked, with no delete');
    await q.fill('#owner-role-name', 'boss');
    await q.click('#owner-role-save');
    await q.waitForSelector('#group-roles li:first-child[data-owner][data-role="boss"]:not([data-open])', { timeout: 10000 });
    await q.waitForSelector('#group-members li[data-owner] [aria-label="boss"]', { timeout: 10000 });
    // the header's crown (the viewer owns the group) and the roster's both say boss now
    expect((await q.$$('[data-owner-mark][aria-label="boss"]')).length >= 2, 'the header crown did not follow the rename');
    expect((await body(await maker.get(`/api/groups/${madeName}`))).owner_role === 'boss', 'the api does not say boss');
    await q.click('#role-add');
    await q.waitForSelector('#group-manage[open] #group-roles li[data-open] #role-name', { timeout: 10000 });
    expect(!(await q.$('#group-roles li[data-owner][data-open]')), 'the owner row stayed open beside the new role');
    const started = await q.inputValue('#role-name');
    expect(started === 'new role', `a new role is called "${started}"`);
    await q.fill('#role-name', 'helpers');
    // the powers are icons on the colour row, pressed when on
    await q.click('#role-perm-kick');
    expect((await q.getAttribute('#role-perm-kick', 'aria-pressed')) === 'true', 'kick did not press');
    // the cooldown is off until a word is pressed
    expect((await q.getAttribute('#role-cooldown-0', 'aria-pressed')) === 'true', 'a new role has a cooldown');
    await q.click('#role-cooldown-30');
    expect((await q.getAttribute('#role-cooldown-30', 'aria-pressed')) === 'true', '30s did not press');
    await q.click('#role-save');
    await q.waitForSelector('#group-roles li[data-role="helpers"]:not([data-open])', { timeout: 10000 });
    expect(!(await q.$('#role-name')), 'the editor stayed open after save');
    const rolesRow = await q.textContent('#group-roles li[data-role="helpers"]');
    expect(/kick/.test(rolesRow) && /cooldown 30s/.test(rolesRow), `the row reads "${rolesRow}"`);
    const roles = await body(await maker.get(`/api/groups/${madeName}/roles`));
    const helpers = Array.isArray(roles) && roles.find((r) => r.name === 'helpers');
    expect(helpers && UUID.test(helpers.id) && helpers.perms.kick === true && helpers.cooldown === 30 && !roles.some((r) => r.name === 'new role'), `the api's roles ${JSON.stringify(roles)}`);
    // the members tab: the roles a member holds after the name, the owner role first as the crown and its name; the plus
    // opens the roles to give as a menu on hover, a click on one gives it, and the word's × takes it back
    await q.click('#manage-tab-members');
    await q.waitForSelector(`#manage-members li[data-member="${MAKER}"]`, { timeout: 5000 });
    expect(!(await q.$('#manage-members select')), 'the members tab still has a select');
    const ownerWord = await q.textContent(`#manage-members li[data-member="${MAKER}"] [data-owner-mark]`);
    expect(ownerWord.trim() === 'boss', `the owner's row wears "${ownerWord}"`);
    await q.hover(`[aria-label="give ${MAKER} a role"]`);
    await q.waitForSelector(`[role="menu"] [data-pick="${helpers.id}"]`, { timeout: 5000 });
    await q.click(`[role="menu"] [data-pick="${helpers.id}"]`);
    await q.waitForSelector(`#manage-members li[data-member="${MAKER}"] [data-held="helpers"]`, { timeout: 10000 });
    expect(!(await q.$('[role="menu"]')), 'the menu stayed open after the give');
    expect(!(await q.$(`[aria-label="give ${MAKER} a role"]`)), 'a plus with nothing left to give');
    await q.click(`[aria-label="take helpers from ${MAKER}"]`);
    await q.waitForFunction((name) => !document.querySelector(`#manage-members li[data-member="${name}"] [data-held="helpers"]`), MAKER, { timeout: 10000 });
    await q.click('#manage-tab-roles');
    await q.waitForSelector('#group-roles li[data-role="helpers"] button', { timeout: 5000 });
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
    // the channels tab of manage: the rows in the list's order; the arrow key on the handle moves clips to the top,
    // the api is told and the list on the left follows; the pencil by the name opens it as a box in its place, enter
    // renames it, the api is told, and the page's address and the list follow; delete asks first, and the channel
    // on screen going moves the page to general
    await q.click('#group-manage-open');
    await q.waitForSelector('#group-manage[open] #manage-tab-channels', { timeout: 5000 });
    await q.click('#manage-tab-channels');
    await q.waitForSelector('#manage-panel-channels #manage-channels li[data-channel="clips"]', { timeout: 5000 });
    const rowsBefore = await q.$$eval('#manage-channels li', (rows) => rows.map((row) => row.dataset.channel));
    expect(rowsBefore.join(' ') === 'general clips', `the tab's rows read ${rowsBefore.join(' ')}`);
    expect(!(await q.$('#channel-remove-general')) && !(await q.$('#channel-rename-general')), 'general has a delete or a pencil');
    expect(!(await q.$('#channel-up-clips')) && !(await q.$('#channel-down-clips')), 'the row still has up and down');
    const put = q.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/groups/${madeName}/channels`, { timeout: 10000 });
    await q.focus('#channel-drag-clips');
    await q.keyboard.press('ArrowUp');
    const putRes = await put;
    expect(putRes.status() === 200, `the move got ${putRes.status()}`);
    await q.waitForFunction(() => document.querySelector('#manage-channels li')?.dataset.channel === 'clips', null, { timeout: 10000 });
    expect((await channelNames()).join(' ') === 'clips general', `after the move the list reads ${(await channelNames()).join(' ')}`);
    const movedRoom = await body(await maker.get(`/api/groups/${madeName}`));
    expect(movedRoom.channels.map((c) => c.name).join(' ') === 'clips general', `the api lists ${movedRoom.channels.map((c) => c.name).join(' ')}`);
    await q.hover('#manage-channels li[data-channel="clips"]');
    await q.click('#channel-rename-clips');
    await q.waitForSelector('#channel-name-clips', { timeout: 5000 });
    expect((await q.inputValue('#channel-name-clips')) === 'clips', `the box opened reading "${await q.inputValue('#channel-name-clips')}"`);
    // escape leaves the name as it was, and the dialog up
    await q.keyboard.press('Escape');
    await q.waitForFunction(() => !document.querySelector('#channel-name-clips'), null, { timeout: 5000 });
    expect(await q.$('#group-manage[open]'), 'escape in the box closed the dialog');
    await q.click('#channel-rename-clips');
    await q.waitForSelector('#channel-name-clips', { timeout: 5000 });
    await q.fill('#channel-name-clips', 'General');
    expect((await q.inputValue('#channel-name-clips')) === 'general', `the box reads "${await q.inputValue('#channel-name-clips')}"`);
    await q.keyboard.press('Enter');
    expect(await q.$('#channel-name-clips[aria-invalid="true"]'), 'a taken name was not refused in the box');
    await q.fill('#channel-name-clips', 'Highlights!');
    const rename = q.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/groups/${madeName}/channels/clips`, { timeout: 10000 });
    await q.keyboard.press('Enter');
    const renameRes = await rename;
    expect(renameRes.status() === 200, `the rename got ${renameRes.status()}`);
    await q.waitForURL((u) => u.pathname === `/groups/${madeName}/highlights`, { timeout: 10000 });
    await q.waitForSelector('#manage-channels li[data-channel="highlights"]', { timeout: 10000 });
    expect(!(await q.$('#channel-name-clips')) && !(await q.$('#channel-name-highlights')), 'the box is still open');
    expect((await channelNames()).join(' ') === 'highlights general', `after the rename the list reads ${(await channelNames()).join(' ')}`);
    // the roles tab keeps a channel to a role: the editor has a box per channel but general, with who sees it beside;
    // ticked and saved, the row says what it keeps and the channel wears a lock on both lists; the role deleted, the lock goes
    await q.click('#manage-tab-roles');
    await q.waitForSelector('#manage-panel-roles #role-add', { timeout: 5000 });
    await q.click('#role-add');
    await q.waitForSelector('#group-roles li[data-open] #role-channel-highlights', { timeout: 10000 });
    expect(!(await q.$('#role-channel-general')), 'general has a box in the role editor');
    expect((await q.textContent('#role-channel-highlights-who')).trim() === 'everyone', `before the tick #highlights is seen by "${await q.textContent('#role-channel-highlights-who')}"`);
    await q.fill('#role-name', 'staffers');
    await q.check('#role-channel-highlights');
    expect((await q.textContent('#role-channel-highlights-who')).trim() === 'only this role', `after the tick #highlights is seen by "${await q.textContent('#role-channel-highlights-who')}"`);
    await q.click('#role-save');
    await q.waitForSelector('#group-roles li[data-role="staffers"]:not([data-open])', { timeout: 10000 });
    const staffersRow = await q.textContent('#group-roles li[data-role="staffers"]');
    expect(/keeps #highlights/.test(staffersRow), `the row reads "${staffersRow}"`);
    await q.waitForSelector('#group-channels [aria-label="only staffers"]', { timeout: 10000 });
    const keptRoom = await body(await maker.get(`/api/groups/${madeName}`));
    expect(keptRoom.roles.find((r) => r.name === 'staffers').channels.join(' ') === 'highlights', `the api's role keeps ${JSON.stringify(keptRoom.roles)}`);
    await q.click('#manage-tab-channels');
    await q.waitForSelector('#manage-channels li[data-channel="highlights"] [aria-label="only staffers"]', { timeout: 5000 });
    await q.click('#manage-tab-roles');
    await q.click('#group-roles li[data-role="staffers"] button');
    await q.waitForSelector('#group-roles li[data-role="staffers"][data-open] #role-delete', { timeout: 5000 });
    await q.click('#role-delete');
    await q.waitForFunction(() => !document.querySelector('#group-roles li[data-role="staffers"]') && !document.querySelector('#group-channels [aria-label="only staffers"]'), null, { timeout: 10000 });
    await q.click('#manage-tab-channels');
    await q.waitForSelector('#channel-remove-highlights', { timeout: 5000 });
    await q.click('#channel-remove-highlights');
    await q.waitForSelector('#manage-channel-delete-highlights[open]', { timeout: 5000 });
    await q.click('#manage-channel-delete-highlights-yes');
    await q.waitForURL((u) => u.pathname === `/groups/${madeName}`, { timeout: 10000 });
    await q.waitForFunction(() => !document.querySelector('#group-channel-highlights') && !document.querySelector('#manage-channels li[data-channel="highlights"]'), null, { timeout: 10000 });
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
