import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RtCore, type SocketLike } from '../src/infra/rt/core.ts';
import { fetchTicket } from '../src/infra/rt/wire.ts';
import { FakePort } from './rt-harness.ts';

const URL_RT = process.env.RT_URL;
const BASE = process.env.RT_BASE ?? (URL_RT ? URL_RT.replace(/^ws/, 'http').replace(/\/rt$/, '/') : '');
const skip = URL_RT ? false : 'RT_URL=ws://host/rt runs this against a real chat process';

function until<T>(probe: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  return new Promise((done, fail) => {
    const tick = () => {
      const got = probe();
      if (got !== undefined) return done(got);
      if (Date.now() - start > ms) return fail(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function live() {
  const core = new RtCore({
    url: URL_RT!,
    build: 'live',
    open: (url) => new WebSocket(url) as unknown as SocketLike,
    ticket: () => fetchTicket(BASE)
  });
  const tab = (nick: string | null) => {
    const port = new FakePort();
    port.send = core.connect(port);
    port.send({ kind: 'attach', build: 'live', nick });
    return port;
  };
  return { core, tab };
}

test('two tabs share one socket against a real server: union, subbed, say acked, line routed, fill', { skip }, async () => {
  const { core, tab } = live();
  const ports: FakePort[] = [];
  try {
    await run(tab, ports);
  } catch (err) {
    for (const p of ports) console.log(JSON.stringify(p.got).slice(0, 2000));
    throw err;
  } finally {
    core.stop();
  }
});

async function run(tab: (nick: string | null) => FakePort, ports: FakePort[]) {
  const room = `rtlive${Date.now() % 100000}`;
  const a = tab(`la${Date.now() % 10000}`);
  const b = tab(`lb${Date.now() % 10000}`);
  ports.push(a, b);
  await until(() => (a.phases().includes('open') ? true : undefined));
  a.send({ kind: 'set', topics: [`chat:${room}`] });
  b.send({ kind: 'set', topics: [`chat:${room}`, 'streams:*'] });
  await until(() => a.frames('subbed').find((f) => (f.topics as string[]).length === 2));
  a.send({ kind: 'ask', rid: 'one', ask: { type: 'say', topic: `chat:${room}`, text: 'hello from core' } });
  const ack = await until(() => a.answers().find((x) => x.rid === 'one'));
  assert.equal(ack.type, 'ack', JSON.stringify(ack));
  const id = (ack as { id?: string }).id!;
  await until(() => b.frames('message').find((f) => f.id === id));
  assert.ok(a.frames('message').some((f) => f.id === id));
  const before = b.frames('message').length;
  a.send({ kind: 'fill', since: { [`chat:${room}`]: '0-0' } });
  await until(() => (b.frames('message').length > before ? true : undefined));
  b.send({ kind: 'identify', nick: `lc${Date.now() % 10000}` });
  const authed = await until(() => b.frames('authed')[0]);
  assert.equal(authed.ok, true, JSON.stringify(authed));
}

test('a peek is not counted against a real server until the page takes it over', { skip }, async () => {
  const watcher = live();
  const peeker = live();
  try {
    const room = `rtpeek${Date.now() % 100000}`;
    const topic = `chat:${room}`;
    const w = watcher.tab(null);
    const p = peeker.tab(null);
    const count = () => w.frames('count').filter((f) => f.topic === topic).at(-1)?.count as number | undefined;
    await until(() => (w.phases().includes('open') && p.phases().includes('open') ? true : undefined));
    w.send({ kind: 'set', topics: [topic] });
    await until(() => (count() === 1 ? true : undefined));
    p.send({ kind: 'set', topics: [topic], peek: [topic] });
    await until(() => p.frames('subbed').find((f) => (f.topics as string[]).includes(topic)));
    await until(() => p.frames('count').find((f) => f.topic === topic));
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(count(), 1, 'the peek is not a viewer');
    p.send({ kind: 'set', topics: [topic] });
    await until(() => (count() === 2 ? true : undefined));
    p.send({ kind: 'set', topics: [topic], peek: [topic] });
    await until(() => (count() === 1 ? true : undefined));
    p.send({ kind: 'set', topics: [] });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(count(), 1);
  } finally {
    watcher.core.stop();
    peeker.core.stop();
  }
});
