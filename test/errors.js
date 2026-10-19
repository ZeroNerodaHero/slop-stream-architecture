// Debugging (docs/debugging.md): /api/health has the monitor fields, a report posted the way
// the pages do it (text/plain, sendBeacon style) is 204 and lands in the debug database and the
// api log, a bad one is 400, the list hides from anyone who is not an admin, a throw inside a
// real page is reported, and /admin renders for a stranger. Run through ./test.sh, or:
// BASE_URL=https://<ip> node errors.js   (LOCAL=1 checks the api log and the debug database too;
// OPS_TOKEN=... reads the list back through the api instead)
// A step that has no way to check its claim (off-box, no OPS_TOKEN) says SKIP, not PASS.
// Locally the rows this file inserted are deleted from the debug database at the end.
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const LOCAL = process.env.LOCAL === '1';
const OPS_TOKEN = process.env.OPS_TOKEN || '';
const CAN_READ_BACK = Boolean(OPS_TOKEN) || LOCAL;
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
const results = []; // 'pass' | 'fail' | 'skip'
// fn returns a string (shown after PASS) or { skip: 'why' } when it could not check anything
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    if (info && typeof info === 'object' && info.skip) {
      results.push('skip');
      console.log(`SKIP  ${name.padEnd(62)} ${ms()} ms  ${info.skip}`);
      return;
    }
    results.push('pass');
    console.log(`PASS  ${name.padEnd(62)} ${ms()} ms  ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${name.padEnd(62)} ${ms()} ms\n      ${e.message}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (cmd) => execSync(`docker compose ${cmd}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// where a report can be read back from: the api with a token, else the api log on the local stack.
// null when it never showed up; `lastSeen` then says what the readback answered (a 401 means the
// token is wrong, or under 16 characters, which the api ignores with a warn line at boot).
let lastSeen = '';
async function reported(api, text, tries = 10) {
  for (let i = 0; i < tries; i++) {
    if (OPS_TOKEN) {
      const res = await api.get('/api/errors?limit=100', { headers: { authorization: `Bearer ${OPS_TOKEN}` } });
      const body = await res.text();
      if (res.status() === 200 && JSON.parse(body).some((e) => e.message.includes(text))) return 'through GET /api/errors';
      lastSeen = `GET /api/errors with OPS_TOKEN answered ${res.status()} ${res.status() === 200 ? `(${JSON.parse(body).length} rows, none with it)` : body.slice(0, 120)}`;
    } else if (LOCAL) {
      if (compose('logs --since 3m --no-log-prefix api').includes(text)) return 'in the api log';
      lastSeen = 'not in the last 3 minutes of the api log';
    } else {
      lastSeen = 'nothing to read it back from (no OPS_TOKEN, not local)';
      return null;
    }
    await sleep(500);
  }
  return null;
}
const notFound = (text) => `"${text}" did not show up: ${lastSeen}`;

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });

  await step('/api/health carries env, build, uptimes, video and live', async () => {
    const res = await api.get('/api/health');
    const h = await res.json();
    expect([200, 503].includes(res.status()), `got ${res.status()}`);
    expect(typeof h.env === 'string' && typeof h.build === 'string', `env/build: ${JSON.stringify(h)}`);
    expect(typeof h.up_secs === 'number' && typeof h.postgres === 'boolean' && typeof h.redis === 'boolean', `fields: ${JSON.stringify(h)}`);
    expect(typeof h.video === 'boolean' && 'live' in h && 'video_up_secs' in h, `video fields: ${JSON.stringify(h)}`);
    expect(h.ok === (res.status() === 200), `ok=${h.ok} with status ${res.status()}`);
    return `${h.env} ${h.build} · video ${h.video} · live ${h.live} · up ${h.up_secs}s`;
  });

  const MSG = `test report ${RUN}`;
  await step('a report posted as text/plain is 204; a bad body is 400', async () => {
    const body = JSON.stringify({ kind: 'soft', message: MSG, page: '/test', stream: 'errtest', phase: 'failed', build: 'test', ua: 'errors.js', extra: { pairState: 'failed', bytesIn: 0 } });
    const ok = await api.post('/api/errors', { data: body, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    expect(ok.status() === 204, `report got ${ok.status()} ${await ok.text()}`);
    const garbage = await api.post('/api/errors', { data: 'not json', headers: { 'content-type': 'text/plain' } });
    const empty = await api.post('/api/errors', { data: '{}', headers: { 'content-type': 'text/plain' } });
    expect(garbage.status() === 400 && empty.status() === 400, `garbage ${garbage.status()}, {} ${empty.status()}`);
    return '204 / 400 / 400';
  });

  await step('the report is in the api log (and the debug database, locally)', async () => {
    if (!CAN_READ_BACK) return { skip: 'no OPS_TOKEN and not local, so a report cannot be read back' };
    const where = await reported(api, MSG);
    expect(where, notFound(MSG));
    if (LOCAL) {
      const n = compose(`exec -T database psql -U stream -d debug -tAc "SELECT count(*) FROM client_errors WHERE message = '${MSG}'"`).trim();
      expect(n === '1', `debug database has ${n} rows for it`);
      return `${where}, and 1 row in debug.client_errors`;
    }
    return where;
  });

  await step('GET /api/errors without an admin login is 401, or 404 when the box has no admin', async () => {
    const res = await api.get('/api/errors');
    expect([401, 404].includes(res.status()), `got ${res.status()}`);
    if (OPS_TOKEN) {
      const bad = await api.get('/api/errors', { headers: { authorization: 'Bearer definitely-not-it' } });
      expect(bad.status() === 401, `wrong token got ${bad.status()}`);
    }
    return `${res.status()}`;
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

  const THROWN = `browser throw ${RUN}`;
  await step('a throw inside a page is reported with its page and build', async () => {
    if (!CAN_READ_BACK) return { skip: 'no OPS_TOKEN and not local, so a report cannot be read back' };
    const p = await fresh();
    await p.goto(`${BASE}/watch/errtest${RUN}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#status', { timeout: 10000 });
    await p.evaluate((m) => setTimeout(() => { throw new Error(m); }, 0), THROWN);
    const where = await reported(api, THROWN);
    expect(where, notFound(THROWN));
    if (OPS_TOKEN) {
      const res = await api.get('/api/errors?kind=error&limit=50', { headers: { authorization: `Bearer ${OPS_TOKEN}` } });
      const row = (await res.json()).find((e) => e.message.includes(THROWN));
      expect(row && row.page === `/watch/errtest${RUN}` && row.kind === 'error' && row.build, `row: ${JSON.stringify(row)}`);
    }
    await p.close();
    return where;
  });

  await step('/admin renders this box for a stranger, with the health card and a notice', async () => {
    const p = await fresh();
    const res = await p.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    expect(res && res.ok(), `GET /admin answered ${res ? res.status() : 'nothing'}`);
    try {
      await p.waitForFunction(() => /postgres/.test(document.querySelector('#admin-health')?.textContent || ''), null, { timeout: 15000 });
    } catch {
      const health = await p.textContent('#admin-health').catch(() => null);
      throw new Error(
        health === null
          ? 'GET /admin is html, but #admin-health never appeared in 15s: the pages on this box are probably older than this test (no /admin route yet). ./deploy.sh frontend puts the new ones up'
          : `#admin-health never showed the health card in 15s. it says: "${health.trim()}"`
      );
    }
    await p.waitForSelector('#admin-notice', { timeout: 15000 });
    const notice = await p.textContent('#admin-notice');
    expect(/admin/.test(notice), `notice: "${notice}"`);
    await p.close();
    return `"${notice.trim()}"`;
  });

  await browser.close();
  await api.dispose();

  // the rows this run inserted (the text/plain report has ua errors.js, the throw has a known message)
  if (LOCAL) {
    try {
      compose(`exec -T database psql -U stream -d debug -tAc "DELETE FROM client_errors WHERE ua = 'errors.js' OR message LIKE 'browser throw %'"`);
    } catch (e) {
      console.log(`      (could not delete the test rows from the debug database: ${String(e.message).split('\n')[0]})`);
    }
  }

  const failed = results.filter((r) => r === 'fail').length;
  const skipped = results.filter((r) => r === 'skip').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed - skipped}/${results.length}${skipped ? `  (${skipped} skipped)` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
