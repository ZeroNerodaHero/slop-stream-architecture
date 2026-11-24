const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const VOICE = process.env.VOICE === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const OWNER = 'vown' + RUN;
const MEMBER = 'vmem' + RUN;
const OUTSIDER = 'vout' + RUN;
const GROUP = 'vgrp' + RUN;
const PW = 'correct horse battery 9!';
const HEX64 = /^[0-9a-f]{64}$/;
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
const body = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
async function pollUntil(fn, until, { timeout, interval = 250, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}
const compose = (...args) => execFileSync('docker', ['compose', 'exec', '-T', ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const redis = (...args) => compose('redis', 'redis-cli', ...args);
const sql = (query) => compose('database', 'psql', '-U', 'stream', '-d', 'stream', '-tAc', query);

const PAGE = `<!doctype html><title>voice</title><body><script>
window.v = { seats: [], error: null, answered: false };
window.join = async (url, grant) => {
  const pc = new RTCPeerConnection();
  window.pc = pc;
  pc.ontrack = (e) => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.srcObject = new MediaStream([e.track]);
    document.body.append(audio);
  };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  pc.addTransceiver(mic.getAudioTracks()[0], { direction: 'sendrecv', streams: [mic] });
  for (let i = 0; i < 15; i++) pc.addTransceiver('audio', { direction: 'recvonly' });
  await pc.setLocalDescription(await pc.createOffer());
  // no trickle: the join frame carries the candidates
  await new Promise((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && done();
    setTimeout(done, 3000);
  });
  const ws = new WebSocket(url);
  window.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ role: 'voice', grant, sdp: pc.localDescription.sdp }));
  ws.onerror = () => (v.error = v.error || 'websocket error');
  ws.onclose = (e) => (v.error = v.error || 'websocket closed (' + e.code + ')');
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.error) v.error = msg.error;
    else if (msg.sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      v.answered = true;
    } else if (msg.event === 'seats') v.seats = msg.seats;
  };
};
// inbound-rtp packetsReceived on m-line n (transceivers are in m-line order: they were added so)
window.packets = async (n) => {
  const t = pc.getTransceivers()[n];
  if (!t) return -1;
  let got = 0;
  (await t.receiver.getStats()).forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') got = Math.max(got, s.packetsReceived || 0);
  });
  return got;
};
</script></body>`;

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const context = () => browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const ctx = { owner: await context(), member: await context(), outsider: await context(), anon: await context() };
  const owner = ctx.owner.request;
  const member = ctx.member.request;
  const outsider = ctx.outsider.request;
  const anon = ctx.anon.request;
  let slug = GROUP;
  const uid = {};
  const join = (who, channel) => who.post(`/api/groups/${slug}/voice/${channel}/join`);
  const granted = async (r) => r.status() === 200 || (!VOICE && r.status() === 503 && (await body(r)).error === 'voice is off');
  const room = async (who) => body(await who.get(`/api/groups/${slug}`));
  const roles = [];

  const w = await ctx.anon.newPage();
  const frames = (what) => w.evaluate((what) => window.__frames.filter((f) => f.what === what), what);

  await step('three logins, a group made and joined by the member; a watcher of group:<name>', async () => {
    for (const [who, name] of [[owner, OWNER], [member, MEMBER], [outsider, OUTSIDER]]) {
      const up = await who.post('/api/signup', { data: { name, password: PW } });
      expect(up.status() === 201, `signup ${name} got ${up.status()} ${JSON.stringify(await body(up))}`);
      uid[name] = (await body(await who.get('/api/me'))).id;
    }
    const made = await owner.post('/api/groups', { data: { name: GROUP, badge: 'talk', color: '#3fb950' } });
    expect(made.status() === 201, `making the group got ${made.status()} ${JSON.stringify(await body(made))}`);
    slug = (await body(made)).name;
    const joined = await member.post(`/api/groups/${slug}/join`);
    expect(joined.status() === 204, `the member joining got ${joined.status()}`);
    await w.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const ready = await w.evaluate(
      (topic) =>
        new Promise((resolve) => {
          window.__frames = [];
          const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/events`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'me') {
              ws.send(JSON.stringify({ type: 'watch', name: topic }));
              resolve({ ok: true });
            }
            if (msg.type === 'group') window.__frames.push({ ...msg, at: Date.now() });
            if (msg.type === 'error') resolve({ error: msg.error });
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      `group:${slug}`,
    );
    expect(ready.ok, `the events socket: ${JSON.stringify(ready)}`);
    return slug;
  });

  await step('a voice channel: kind voice in the room and on the channel fact, video 400, no kind is text', async () => {
    const video = await owner.post(`/api/groups/${slug}/channels`, { data: { name: 'screen', kind: 'video' } });
    expect(video.status() === 400 && /kind is text or voice/.test((await body(video)).error), `kind video got ${video.status()} ${JSON.stringify(await body(video))}`);
    const lounge = await owner.post(`/api/groups/${slug}/channels`, { data: { name: 'lounge', kind: 'voice' } });
    expect(lounge.status() === 201, `lounge got ${lounge.status()} ${JSON.stringify(await body(lounge))}`);
    const notes = await owner.post(`/api/groups/${slug}/channels`, { data: { name: 'notes' } });
    expect(notes.status() === 201, `notes got ${notes.status()} ${JSON.stringify(await body(notes))}`);
    const seen = await room(anon);
    const kinds = Object.fromEntries(seen.channels.map((c) => [c.name, c.kind]));
    expect(kinds.general === 'text' && kinds.lounge === 'voice' && kinds.notes === 'text', `the room's kinds ${JSON.stringify(kinds)}`);
    const l = seen.channels.find((c) => c.name === 'lounge');
    expect(l.user_limit === 0, `lounge's user_limit ${JSON.stringify(l.user_limit)}`);
    expect(seen.voice && typeof seen.voice === 'object' && Object.keys(seen.voice).length === 0, `the room's voice with nobody in ${JSON.stringify(seen.voice)}`);
    await pollUntil(() => frames('channel'), (f) => f.some((x) => x.channel && x.channel.name === 'lounge'), { timeout: 5000, label: 'the lounge channel fact' });
    const fact = (await frames('channel')).find((x) => x.channel.name === 'lounge');
    expect(fact.channel.kind === 'voice', `the channel fact ${JSON.stringify(fact)}`);
    return `general text, lounge voice (user_limit 0), notes text`;
  });

  await step('a voice channel is no chat: its socket and its search say no such channel', async () => {
    const page = await ctx.member.newPage();
    await page.goto(`${BASE}/api/health`, { waitUntil: 'domcontentloaded' });
    const said = await page.evaluate(
      (server) =>
        new Promise((resolve) => {
          const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/chat/${server}/lounge`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
          ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === 'history') ws.send(JSON.stringify({ type: 'say', text: 'hello lounge' }));
            if (msg.type === 'message') resolve({ said: msg.text });
            if (msg.type === 'error') resolve({ error: msg.error });
          };
          setTimeout(() => resolve({ timeout: true }), 8000);
        }),
      slug,
    );
    await page.close();
    expect(said.error === 'no such channel', `the lounge's chat socket: ${JSON.stringify(said)}`);
    const search = await member.get(`/chat/${slug}/lounge/search?q=hello`);
    expect(search.status() === 404, `the lounge's search got ${search.status()}`);
    const lines = await body(await member.get(`/api/groups/${slug}/messages`));
    expect(lines && !JSON.stringify(lines).includes('"lounge"'), `messages lists the lounge: ${JSON.stringify(lines).slice(0, 300)}`);
    return `"${said.error}", search ${search.status()}`;
  });

  await step('the voice power: a roles holder cannot hand it out, the owner can, the room says it', async () => {
    const make = (who, name, perms) => who.post(`/api/groups/${slug}/roles`, { data: { name, color: '#3fb950', perms } });
    const roler = await body(await make(owner, 'roler', { roles: true }));
    roles.push(roler.id);
    const given = await owner.post(`/api/groups/${slug}/roles/${roler.id}/members`, { data: { name: MEMBER } });
    expect(given.status() === 204, `giving roler got ${given.status()}`);
    const over = await make(member, 'talker', { roles: true, voice: true });
    const within = await make(member, 'helper', { roles: true });
    expect(over.status() === 403 && within.status() === 201, `from the roles holder: with voice ${over.status()}, roles alone ${within.status()}`);
    roles.push((await body(within)).id);
    const yes = await make(owner, 'voicemod', { voice: true });
    const made = await body(yes);
    expect(yes.status() === 201 && made.perms.voice === true && made.perms.roles === false, `the owner's voice role ${yes.status()} ${JSON.stringify(made)}`);
    roles.push(made.id);
    const mine = await room(owner);
    const theirs = await room(member);
    expect(mine.perms.voice === true && theirs.perms.voice === false, `perms.voice: owner ${mine.perms.voice}, member ${theirs.perms.voice}`);
    const held = await owner.post(`/api/groups/${slug}/roles/${made.id}/members`, { data: { name: MEMBER } });
    const now = await room(member);
    expect(held.status() === 204 && now.perms.voice === true, `the member with voicemod: ${held.status()} ${JSON.stringify(now.perms)}`);
    for (const id of roles.splice(0)) {
      const gone = await owner.delete(`/api/groups/${slug}/roles/${id}`);
      expect(gone.status() === 204, `dropping role ${id} got ${gone.status()}`);
    }
    return `with voice ${over.status()}, owner's ${yes.status()}`;
  });

  let hidden;
  await step('join: nobody 401, not a member 403, no such or hidden 404, text 400, a member gets a grant', async () => {
    const back = await owner.post(`/api/groups/${slug}/channels`, { data: { name: 'backroom', kind: 'voice' } });
    expect(back.status() === 201, `backroom got ${back.status()}`);
    hidden = await body(await owner.post(`/api/groups/${slug}/roles`, { data: { name: 'insiders', color: '#f2cc60' } }));
    const kept = await owner.put(`/api/groups/${slug}/channels/backroom/roles`, { data: { roles: [hidden.id] } });
    expect(kept.status() === 200 || kept.status() === 204, `keeping backroom got ${kept.status()}`);
    const nobody = await join(anon, 'lounge');
    const stranger = await join(outsider, 'lounge');
    const none = await join(member, 'nosuch');
    const kept404 = await join(member, 'backroom');
    const text = await join(member, 'general');
    const said = async (r) => `${r.status()} ${(await body(r)).error}`;
    expect(nobody.status() === 401, `nobody got ${await said(nobody)}`);
    expect(stranger.status() === 403, `not a member got ${await said(stranger)}`);
    expect(none.status() === 404 && (await body(none)).error === 'no such channel', `no such channel got ${await said(none)}`);
    expect(kept404.status() === 404 && (await body(kept404)).error === 'no such channel', `a hidden one got ${await said(kept404)}`);
    expect(text.status() === 400 && (await body(text)).error === 'not a voice channel', `general got ${await said(text)}`);
    const ok = await join(member, 'lounge');
    const grant = await body(ok);
    if (ok.status() === 503) {
      expect(await granted(ok), `the member's join got ${await said(ok)}`);
      const owners503 = await join(owner, 'backroom');
      expect(await granted(owners503), `the owner's join to backroom got ${await said(owners503)}`);
      return `${nobody.status()} ${stranger.status()} ${none.status()} ${kept404.status()} ${text.status()}, then 503 voice is off (no VOICE_SECRET here)`;
    }
    expect(ok.status() === 200 && grant.url === '/voice' && HEX64.test(grant.grant) && grant.ttl === 30, `the member's join got ${ok.status()} ${JSON.stringify(grant && { ...grant, grant: grant.grant && grant.grant.length })}`);
    const owners = await body(await join(owner, 'backroom'));
    expect(owners && HEX64.test(owners.grant) && owners.grant !== grant.grant, 'the owner has no grant for backroom, or the same one');
    return `${nobody.status()} ${stranger.status()} ${none.status()} ${kept404.status()} ${text.status()}, a ${grant.grant.length}-hex grant`;
  });

  await step('the internal routes are not reachable from outside: redeem, attached, left, beat 404', async () => {
    const grant = (await body(await join(member, 'lounge'))).grant || '0'.repeat(64);
    const tried = [];
    for (const [path, data] of [
      ['redeem', { grant }],
      ['attached', { user_id: uid[MEMBER], server: slug, channel: 'lounge', seat: 0 }],
      ['left', { user_id: uid[MEMBER], server: slug }],
      ['beat', { peers: [] }],
    ]) {
      const res = await anon.post(`/api/voice/${path}`, { data, headers: { 'x-voice-secret': 'guess' } });
      tried.push(`${path} ${res.status()}`);
    }
    expect(tried.every((t) => t.endsWith(' 404')), tried.join(', '));
    return tried.join(', ');
  });

  const seat = (name, channel) => {
    const now = Date.now();
    redis('HSET', `voice:${slug}`, uid[name], JSON.stringify({ name, channel, seat: 0, since: now, beat: now, session: 0 }));
    redis('SET', `voiceof:${uid[name]}`, `${slug}/${channel}`);
  };
  const unseat = () => {
    redis('DEL', `voice:${slug}`, ...Object.values(uid).map((u) => `voiceof:${u}`));
    sql(`UPDATE channels SET user_limit = 0 WHERE server = '${slug}'`);
  };

  await step('local: already in voice 409, channel full 409 (the owner never kept out)', async () => {
    if (!LOCAL) return { skip: 'reads and writes redis and the database here' };
    try {
      redis('SET', `voiceof:${uid[MEMBER]}`, `${slug}/elsewhere`);
      const busy = await join(member, 'lounge');
      expect(busy.status() === 409 && (await body(busy)).error === 'already in voice', `in another channel got ${busy.status()} ${JSON.stringify(await body(busy))}`);
      redis('SET', `voiceof:${uid[MEMBER]}`, `${slug}/lounge`);
      const same = await join(member, 'lounge');
      expect(await granted(same), `back into their own channel got ${same.status()}`);
      redis('DEL', `voiceof:${uid[MEMBER]}`);
      expect((await outsider.post(`/api/groups/${slug}/join`)).status() === 204, 'the outsider joining failed');
      sql(`UPDATE channels SET user_limit = 1 WHERE server = '${slug}' AND name = 'lounge'`);
      seat(MEMBER, 'lounge');
      const full = await join(outsider, 'lounge');
      expect(full.status() === 409 && (await body(full)).error === 'channel full', `the second into a channel of one got ${full.status()} ${JSON.stringify(await body(full))}`);
      const theOwner = await join(owner, 'lounge');
      expect(await granted(theOwner), `the owner into a full channel got ${theOwner.status()}`);
      const again = await join(member, 'lounge');
      expect(await granted(again), `the member already in it got ${again.status()}`);
      sql(`UPDATE channels SET user_limit = 0 WHERE server = '${slug}' AND name = 'lounge'`);
      redis('DEL', `voice:${slug}`, `voiceof:${uid[MEMBER]}`);
      const fake = (i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, JSON.stringify({ name: `f${i}`, channel: 'lounge', seat: i, since: 1, beat: Date.now(), session: 0 })];
      redis('HSET', `voice:${slug}`, ...Array.from({ length: 15 }, (_, i) => fake(i)).flat());
      const fits = await join(outsider, 'lounge');
      redis('HSET', `voice:${slug}`, ...fake(15));
      const over = await join(outsider, 'lounge');
      expect((await granted(fits)) && over.status() === 409, `with 15 in: ${fits.status()}, with 16: ${over.status()}`);
      return `"already in voice", "channel full" at 1 and at 16, the owner ${theOwner.status()}`;
    } finally {
      unseat();
    }
  });

  await step("local: the room's voice lists who is where, and hides a channel you cannot see", async () => {
    if (!LOCAL) return { skip: 'writes redis here' };
    try {
      seat(MEMBER, 'lounge');
      seat(OWNER, 'backroom');
      const theirs = await room(member);
      const mine = await room(owner);
      const anyone = await room(anon);
      const names = (r, c) => (r.voice[c] || []).map((p) => p.name).join(' ');
      expect(names(mine, 'lounge') === MEMBER && names(mine, 'backroom') === OWNER, `the owner's room voice ${JSON.stringify(mine.voice)}`);
      const p = mine.voice.lounge[0];
      expect(p.uid === uid[MEMBER] && Number.isInteger(p.since), `the member's entry ${JSON.stringify(p)}`);
      expect(names(theirs, 'lounge') === MEMBER && !('backroom' in theirs.voice), `the member's room voice ${JSON.stringify(theirs.voice)}`);
      expect(!('backroom' in anyone.voice), `nobody's room voice ${JSON.stringify(anyone.voice)}`);
      return `owner sees ${Object.keys(mine.voice).join(' ')}, member ${Object.keys(theirs.voice).join(' ')}`;
    } finally {
      unseat();
    }
  });

  const people = {};
  const VOICE_URL = `${BASE.replace(/^http/, 'ws')}/voice`;
  async function talk(name, c, channel, grant) {
    const page = await c.newPage();
    await page.goto(`${BASE}/api/health`, { waitUntil: 'domcontentloaded' });
    await page.setContent(PAGE);
    if (!grant) {
      const res = await c.request.post(`/api/groups/${slug}/voice/${channel}/join`);
      expect(res.status() === 200, `${name}'s join got ${res.status()} ${JSON.stringify(await body(res))}`);
      grant = (await body(res)).grant;
    }
    await page.evaluate(([url, g]) => window.join(url, g), [VOICE_URL, grant]);
    const v = await pollUntil(() => page.evaluate(() => ({ error: v.error, answered: v.answered })), (v) => v.error || v.answered, {
      timeout: 10000,
      label: `${name} joins ${channel}`,
    });
    return { name, page, grant, error: v.error };
  }
  const seatsOf = (p) => p.page.evaluate(() => v.seats);
  const packets = (p, line) => p.page.evaluate((n) => window.packets(n), line);
  async function hears(p, other) {
    const seats = await pollUntil(() => seatsOf(p), (s) => s.some((x) => x.user === other), { timeout: 5000, label: `${p.name} sees ${other} seated` });
    const line = seats.find((x) => x.user === other).line;
    const first = await pollUntil(() => packets(p, line), (n) => n > 0, { timeout: 5000, label: `${p.name} gets packets from ${other} on m-line ${line}` });
    await sleep(1000);
    const then = await packets(p, line);
    expect(then > first, `${p.name}: packets from ${other} on m-line ${line} stopped at ${first}`);
    return `${p.name} hears ${other}: ${first} -> ${then}`;
  }
  const inLounge = async () => ((await room(anon)).voice.lounge || []).map((p) => p.name).sort();
  const skipVoice = { skip: 'VOICE=1 runs it, against a stack with --profile voice and a VOICE_SECRET' };

  await step('voice: two logins join the lounge through grants and hear each other', async () => {
    if (!VOICE) return skipVoice;
    for (const [name, c] of [[OWNER, ctx.owner], [MEMBER, ctx.member]]) {
      const p = await talk(name, c, 'lounge');
      expect(!p.error, `${name}: ${p.error}`);
      people[name] = p;
    }
    return `${await hears(people[OWNER], MEMBER)}; ${await hears(people[MEMBER], OWNER)}`;
  });

  await step('voice: the watcher hears voice for both, and the room shows them', async () => {
    if (!VOICE) return skipVoice;
    const heard = await pollUntil(() => frames('voice'), (f) => [OWNER, MEMBER].every((n) => f.some((x) => x.who === n)), { timeout: 5000, label: 'voice for both' });
    for (const name of [OWNER, MEMBER]) {
      const f = heard.find((x) => x.who === name);
      expect(f.group === slug && f.uid === uid[name] && f.channel === 'lounge', `the voice fact for ${name} ${JSON.stringify(f)}`);
    }
    const shown = await pollUntil(inLounge, (n) => n.length === 2, { timeout: 5000, label: "the room's lounge" });
    expect(shown.join(' ') === [OWNER, MEMBER].sort().join(' '), `the room's lounge ${shown.join(' ')}`);
    return `voice ${heard.map((f) => f.who).join(', ')}; the room has ${shown.join(', ')}`;
  });

  await step('voice: a grant used once is bad grant the second time', async () => {
    if (!VOICE) return skipVoice;
    const again = await talk('reuse', await context(), 'lounge', people[MEMBER].grant);
    await again.page.context().close();
    expect(again.error === 'bad grant', `a used grant got ${JSON.stringify(again.error || 'an answer')}`);
    return `"${again.error}"`;
  });

  await step('voice: a closed page is voice_left within 20s and gone from the room', async () => {
    if (!VOICE) return skipVoice;
    const t0 = Date.now();
    await people[MEMBER].page.close();
    const left = await pollUntil(() => frames('voice_left'), (f) => f.some((x) => x.who === MEMBER), { timeout: 20000, label: `voice_left for ${MEMBER}` });
    const f = left.find((x) => x.who === MEMBER);
    expect(f.uid === uid[MEMBER] && f.channel === 'lounge', `the voice_left fact ${JSON.stringify(f)}`);
    const shown = await inLounge();
    expect(shown.join(' ') === OWNER, `the room's lounge after ${shown.join(' ')}`);
    await pollUntil(() => seatsOf(people[OWNER]), (s) => !s.some((x) => x.user === MEMBER), { timeout: 5000, label: `${OWNER} sees ${MEMBER} go` });
    return `voice_left after ${f.at - t0} ms`;
  });

  await step('voice: moving lounge -> backroom: closed, then a grant within 5s, and seated there', async () => {
    if (!VOICE) return skipVoice;
    const was = people[OWNER];
    await was.page.evaluate(() => window.ws.close());
    const t0 = Date.now();
    const first = await join(ctx.owner.request, 'backroom');
    const said = `${first.status()} ${(await body(first)).error || 'a grant'}`;
    let grant = first.status() === 200 ? (await body(first)).grant : null;
    while (!grant && Date.now() - t0 < 5000) {
      await sleep(100);
      const res = await join(ctx.owner.request, 'backroom');
      if (res.status() === 200) grant = (await body(res)).grant;
    }
    expect(grant, `no grant for backroom within 5s (the first ask: ${said})`);
    const ms = Date.now() - t0;
    await was.page.close();
    const now = await talk(OWNER, ctx.owner, 'backroom', grant);
    expect(!now.error, `${OWNER} in backroom: ${now.error}`);
    people[OWNER] = now;
    const moved = await pollUntil(() => room(owner), (r) => (r.voice.backroom || []).some((p) => p.name === OWNER) && !(r.voice.lounge || []).length, {
      timeout: 5000,
      label: "the room's backroom",
    });
    return `the first ask ${said}, a grant after ${ms} ms; the room ${JSON.stringify(Object.keys(moved.voice))}`;
  });

  if (people[OWNER]) {
    await people[OWNER].page.close().catch(() => {});
    await pollUntil(() => frames('voice_left'), (f) => f.some((x) => x.who === OWNER), { timeout: 20000, label: `voice_left for ${OWNER}` }).catch(() => {});
  }
  await owner.delete(`/api/groups/${slug}`).catch(() => {});
  if (LOCAL) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'sh', '-c', "redis-cli --scan --pattern 'rl:signup:*' | xargs -r redis-cli del"], { cwd: REPO, stdio: 'ignore' });
    } catch {
    }
  }
  await browser.close();
  const n = (k) => results.filter((r) => r === k).length;
  console.log(`\n${n('pass')} passed, ${n('fail')} failed, ${n('skip')} skipped`);
  process.exit(n('fail') ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
