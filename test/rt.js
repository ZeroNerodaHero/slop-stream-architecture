const { execSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const RT = process.env.RT_URL || `${BASE.replace(/^http/, 'ws')}/rt`;
const HTTP = RT.replace(/^ws/, 'http');
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const PSQL = process.env.PSQL || 'docker compose exec -T database psql -U stream stream';
const REDIS = process.env.REDIS_CLI || 'docker compose exec -T redis redis-cli';
const RUN = Date.now().toString(36).slice(-5);
const ROOM = `rt${RUN}`;
const results = [];
if (BASE.startsWith('https://127.0.0.1')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

function open(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RT);
    const frames = [];
    const waiters = [];
    const c = {
      ws,
      frames,
      rev: 0,
      send: (f) => ws.send(JSON.stringify(f)),
      sub: (topics, since) => {
        c.rev += 1;
        c.send({ type: 'sub', rev: c.rev, topics, ...(since ? { since } : {}) });
        return c.rev;
      },
      next: (pred, ms = 4000) =>
        new Promise((res, rej) => {
          const hit = frames.findIndex(pred);
          if (hit >= 0) return res(frames.splice(hit, 1)[0]);
          const w = { pred, res };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) {
              waiters.splice(i, 1);
              rej(new Error(`no frame in ${ms}ms; had ${JSON.stringify(frames.slice(-6))}`));
            }
          }, ms);
        }),
      none: async (pred, ms = 600) => {
        await sleep(ms);
        expect(!frames.some(pred), `an unexpected frame: ${JSON.stringify(frames.find(pred))}`);
      },
      close: () => ws.close()
    };
    ws.onmessage = (m) => {
      const f = JSON.parse(m.data);
      const i = waiters.findIndex((w) => w.pred(f));
      if (i >= 0) waiters.splice(i, 1)[0].res(f);
      else frames.push(f);
    };
    ws.onerror = () => reject(new Error(`cannot open ${RT}`));
    ws.onopen = async () => {
      c.send({ type: 'hello', v: 1, ...hello });
      try {
        await c.next((f) => f.type === 'ready');
        resolve(c);
      } catch (e) {
        reject(e);
      }
    };
  });
}

const is = (type, topic) => (f) => f.type === type && (!topic || f.topic === topic);

(async () => {
  console.log(`rt: ${RT}`);
  let a;
  let b;
  let lastSeen;

  await step('a guest says hello and is told who it is', async () => {
    a = await open({ nick: `rta${RUN}` });
    const me = await a.next(is('me'));
    expect(me.name === `rta${RUN}`, JSON.stringify(me));
  });

  await step('a full set is answered with the authoritative set, refusals named', async () => {
    const rev = a.sub([`chat:${ROOM}`, 'presence:nobody-here', 'streams:*', 'chat:has space']);
    const s = await a.next(is('subbed'));
    expect(s.rev === rev, JSON.stringify(s));
    expect(JSON.stringify(s.topics) === JSON.stringify([`chat:${ROOM}`, 'presence:nobody-here', 'streams:*']), JSON.stringify(s.topics));
    expect(s.refused.length === 1 && s.refused[0].error === 'no such topic', JSON.stringify(s.refused));
    const count = await a.next(is('count', `chat:${ROOM}`));
    expect(count.count === 1, JSON.stringify(count));
    await a.next((f) => f.type === 'presence' && f.name === 'nobody-here');
  });

  await step('a say is acked with its id and comes back on the topic', async () => {
    a.send({ type: 'say', rid: 'r1', topic: `chat:${ROOM}`, text: 'hello over rt' });
    const ack = await a.next(is('ack'));
    expect(ack.rid === 'r1' && /^\d+-\d+$/.test(ack.id), JSON.stringify(ack));
    const line = await a.next(is('message', `chat:${ROOM}`));
    expect(line.id === ack.id && line.text === 'hello over rt' && line.from === `rta${RUN}`, JSON.stringify(line));
    lastSeen = line.id;
  });

  await step('a say on a topic it does not hold is nacked', async () => {
    a.send({ type: 'say', rid: 'r2', topic: 'chat:elsewhere', text: 'hi' });
    const nack = await a.next(is('nack'));
    expect(nack.rid === 'r2' && nack.error === 'subscribe to the topic first', JSON.stringify(nack));
  });

  await step('a second socket on the topic is counted from the set', async () => {
    b = await open({ nick: `rtb${RUN}` });
    b.sub([`chat:${ROOM}`]);
    await b.next(is('subbed'));
    const two = await a.next((f) => f.type === 'count' && f.topic === `chat:${ROOM}` && f.count === 2);
    expect(two.count === 2);
  });

  await step('a duplicated or older sub frame changes nothing and is not answered', async () => {
    a.send({ type: 'sub', rev: a.rev, topics: [] });
    a.send({ type: 'sub', rev: a.rev - 1, topics: [] });
    await a.none(is('subbed'));
    a.send({ type: 'say', rid: 'r3', topic: `chat:${ROOM}`, text: 'still here' });
    const ack = await a.next(is('ack'));
    expect(ack.rid === 'r3', JSON.stringify(ack));
    lastSeen = (await a.next(is('message', `chat:${ROOM}`))).id;
  });

  await step('a socket that left gets back exactly what it missed with since', async () => {
    b.close();
    await a.next((f) => f.type === 'count' && f.topic === `chat:${ROOM}` && f.count === 1);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const g = await open({ nick: `rtg${i}${RUN}` });
      g.sub([`chat:${ROOM}`]);
      await g.next(is('subbed'));
      g.send({ type: 'say', rid: `g${i}`, topic: `chat:${ROOM}`, text: `missed ${i}` });
      const ack = await g.next(is('ack'));
      expect(ack.rid === `g${i}` && ack.id, JSON.stringify(ack));
      ids.push(ack.id);
      g.close();
    }
    b = await open({ nick: `rtb${RUN}` });
    b.sub([`chat:${ROOM}`], { [`chat:${ROOM}`]: lastSeen });
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await b.next(is('message', `chat:${ROOM}`))).id);
    expect(JSON.stringify(got) === JSON.stringify(ids), `${JSON.stringify(got)} vs ${JSON.stringify(ids)}`);
    await b.next(is('subbed'));
  });

  await step('the oldest of seventeen chat topics is evicted, and comes back when there is room', async () => {
    const many = Array.from({ length: 17 }, (_, i) => `chat:${ROOM}x${i}`);
    b.sub(many);
    const s = await b.next(is('subbed'), 8000);
    expect(s.topics.length === 16 && JSON.stringify(s.evicted) === JSON.stringify([`chat:${ROOM}x0`]), JSON.stringify(s));
    b.sub(many.filter((t) => t !== `chat:${ROOM}x5`));
    const back = await b.next(is('subbed'));
    expect(back.topics.includes(`chat:${ROOM}x0`) && back.evicted.length === 0, JSON.stringify(back));
  });

  await step('a ticket changes who the socket is without a reconnect, once', async () => {
    const r = await fetch(`${HTTP}/ticket`, { method: 'POST' });
    expect(r.ok, `ticket ${r.status}`);
    const { ticket, ttl } = await r.json();
    expect(/^[0-9a-f]{32}$/.test(ticket) && ttl === 30, ticket);
    a.send({ type: 'auth', ticket, nick: `rtc${RUN}` });
    const authed = await a.next(is('authed'));
    expect(authed.ok && authed.name === `rtc${RUN}`, JSON.stringify(authed));
    const me = await a.next((f) => f.type === 'me' && f.name === `rtc${RUN}`);
    expect(me);
    await a.next(is('subbed'));
    a.send({ type: 'auth', ticket });
    const again = await a.next(is('authed'));
    expect(!again.ok && again.error === 'bad ticket', JSON.stringify(again));
  });

  await step('a ticket for an account makes the socket that account', async () => {
    if (!LOCAL) return { skip: 'LOCAL=1 writes the account and the ticket straight to postgres and redis' };
    const name = `rtacct${RUN}`;
    const id = execSync(`${PSQL} -tAc "INSERT INTO streamers (name) VALUES ('${name}') RETURNING id"`, { cwd: REPO }).toString().trim().split('\n')[0];
    const ticket = [...Array(32)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    execSync(`${REDIS} SET rtticket:${ticket} ${id} EX 30`, { cwd: REPO });
    a.send({ type: 'auth', ticket });
    const authed = await a.next(is('authed'));
    expect(authed.ok && authed.name === name, JSON.stringify(authed));
    a.send({ type: 'say', rid: 'v1', topic: `chat:${ROOM}`, text: 'as an account' });
    await a.next((f) => f.type === 'ack' && f.rid === 'v1');
    const line = await a.next((f) => f.type === 'message' && f.text === 'as an account');
    expect(line.from === name && line.verified === true, JSON.stringify(line));
  });

  await step('the server beats and pings so a page can tell it is alive', async () => {
    if (process.env.RT_SLOW !== '1') return { skip: 'RT_SLOW=1 waits 21s for a beat' };
    const beat = await a.next(is('beat'), 22000);
    expect(beat.at > 0);
  });

  a?.close();
  b?.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${results.length - failed} of ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
