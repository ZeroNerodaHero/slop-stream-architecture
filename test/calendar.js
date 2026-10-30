// The calendar (docs/calendar.md): a block per session on the watch page's calendar tab. The api's
// range (`GET /api/streamers/:name/sessions?from=&to=`: 93 days at most, the last 20 without one),
// a go-live opens a block the watcher sees live and growing, a stop closes it with `ended_by: stop`
// and the heartbeat's time on the row, a connection that drops (the tab goes offline and away, no
// stop) is closed by video within a beat of the last heartbeat and the two sessions a minute apart
// draw as one block with a mark at the drop, the strip pages four weeks back and forward, an
// account's rows are its own. Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node calendar.js
const { chromium, request } = require('playwright');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const RUN = Date.now().toString(36).slice(-5);
/** the guest who streams: a free name, nobody's, like r1..r8 */
const NAME = 'cal1';
/** an account, for "whose rows" (a signup is for good, so a fresh one per run, like follows.js) */
const ACCOUNT = 'calp' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const DAY = 86_400_000;
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
async function pollUntil(fn, until, { timeout, interval = 500, label }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (until(last)) return last;
    await sleep(interval);
  }
  throw new Error(`${label}: timed out after ${timeout} ms; last value: ${JSON.stringify(last)}`);
}
const iso = (ms) => new Date(ms).toISOString();

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const range = (name, from, to) => api.get(`/api/streamers/${name}/sessions?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`);
  /** the name's rows around now: yesterday to tomorrow */
  const today = async (name) => (await range(name, Date.now() - DAY, Date.now() + DAY)).json();
  const openRow = (rows) => (Array.isArray(rows) ? rows.find((r) => r.ended_at === null) : undefined);

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const ctxW = await browser.newContext({ ignoreHTTPSErrors: true });
  const w = await ctxW.newPage();
  let ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  let a = await ctxA.newPage();

  const goLive = async (page) => {
    // no name box on /live: a guest streams as the nick in the corner panel (localstorage, json the way jotai keeps it)
    await page.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), NAME);
    await page.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#start')?.disabled, null, { timeout: 20000 });
    await page.click('#start');
    await page.waitForFunction(() => /^\s*live\b/i.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 20000 });
  };

  await step(`preflight: ${NAME} is not live`, async () => {
    const who = await (await api.get(`/api/streamers/${NAME}`)).json();
    expect(who && who.presence !== 'streaming', `${NAME} is ${who && who.presence}; is another run going?`);
    const open = openRow(await today(NAME));
    return open ? `an open row (${open.id}) is waiting for the sweeper; fine` : 'no open row';
  });

  await step('api: the range wants from and to, rfc3339, 93 days at most; none is the last 20', async () => {
    const now = Date.now();
    const ok = await range(NAME, now - 93 * DAY, now);
    expect(ok.status() === 200 && Array.isArray(await ok.json()), `93 days got ${ok.status()}`);
    const long = await range(NAME, now - 94 * DAY, now);
    expect(long.status() === 400, `94 days got ${long.status()}`);
    const backwards = await range(NAME, now, now - DAY);
    expect(backwards.status() === 400, `to before from got ${backwards.status()}`);
    const half = await api.get(`/api/streamers/${NAME}/sessions?from=${encodeURIComponent(iso(now))}`);
    expect(half.status() === 400, `from alone got ${half.status()}`);
    const junk = await api.get(`/api/streamers/${NAME}/sessions?from=yesterday&to=${encodeURIComponent(iso(now))}`);
    expect(junk.status() === 400, `a word for a date got ${junk.status()}`);
    const plain = await api.get(`/api/streamers/${NAME}/sessions`);
    const list = await plain.json();
    expect(plain.status() === 200 && Array.isArray(list) && list.length <= 20, `no range got ${plain.status()} with ${Array.isArray(list) ? list.length : '?'} rows`);
    expect(list.every((r) => !('token' in r)), 'a row carries the token');
    return `${list.length} row(s) without a range`;
  });

  await step(`watcher: /watch/${NAME} offline has the about tab open and a calendar tab that loads the strip`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 15000 });
    expect((await w.$$('#calendar')).length === 0, 'the strip is on the page before its tab is opened');
    await w.click('#tab-calendar');
    await w.waitForSelector('#calendar[data-phase="ready"]', { timeout: 10000 });
    const rows = await w.$$eval('#calendar-strip > div.grid', (els) => els.length);
    expect(rows === 28, `${rows} day rows, want 28`);
    const usually = (await w.textContent('#calendar-usually')).trim();
    expect(/^(usually|streamed|streams|has not)/.test(usually), `the line reads "${usually}"`);
    expect(await w.$eval('#calendar-forward', (b) => b.disabled), 'forward is enabled on the current four weeks');
    return usually;
  });

  await step('the strip pages four weeks back (today goes, the range moves) and comes back', async () => {
    const before = (await w.textContent('#calendar-range')).trim();
    await w.click('#calendar-back');
    await w.waitForSelector('#calendar[data-page="1"][data-phase="ready"]', { timeout: 10000 });
    const after = (await w.textContent('#calendar-range')).trim();
    expect(after !== before, `the range still reads "${after}"`);
    await w.waitForSelector('#calendar-today', { timeout: 2000 });
    await w.click('#calendar-today');
    await w.waitForSelector('#calendar[data-page="0"][data-phase="ready"]', { timeout: 10000 });
    expect((await w.textContent('#calendar-range')).trim() === before, 'today did not bring the first range back');
    return `${before} ↔ ${after}`;
  });

  await step(`go live as ${NAME}: an open row on the api, a live block on the watcher's strip, growing`, async () => {
    await goLive(a);
    const open = await pollUntil(async () => openRow(await today(NAME)), (r) => !!r, { timeout: 10000, label: 'an open row' });
    expect(open.ended_by === null, `an open row says ended_by ${open.ended_by}`);
    // the watcher plays on the pushed `live` (docs/status.md); the strip asks again on that same
    // change of phase. a watcher still waiting here is the push missing, not the calendar
    await w.waitForFunction(() => /^watching$/.test(document.querySelector('#status')?.textContent?.trim() || ''), null, { timeout: 20000 }).catch(async () => {
      const status = await w.textContent('#status').catch(() => '?');
      throw new Error(`the watcher never played: #status reads "${(status || '').trim()}". the pushed live did not arrive (is video the build the api expects?)`);
    });
    await w.waitForSelector('#calendar-strip button[data-live]', { timeout: 15000 });
    await w.waitForFunction(() => /^live now/.test(document.querySelector('#calendar-last')?.textContent || ''), null, { timeout: 5000 });
    const label = await w.getAttribute('#calendar-strip button[data-live]', 'aria-label');
    expect(/today/.test(label) && /now/.test(label) && /live/.test(label), `the live block says "${label}"`);
    return `row ${open.id}: ${label}`;
  });

  await step('a heartbeat lands on the row (last_beat_at), then stop closes it: ended_by stop, the watcher\'s block closes', async () => {
    // the page beats every 15s; one must land before the stop so the row has a time to end at later
    const beaten = await pollUntil(async () => openRow(await today(NAME)), (r) => !!r && r.last_beat_at !== null, { timeout: 25000, label: 'a heartbeat on the row' });
    await a.click('#stop');
    const row = await pollUntil(
      async () => (await today(NAME)).find((r) => r.id === beaten.id),
      (r) => !!r && r.ended_at !== null,
      { timeout: 10000, label: 'the row ended' }
    );
    expect(row.ended_by === 'stop', `ended_by ${row.ended_by}, want stop`);
    expect(new Date(row.last_beat_at) >= new Date(row.started_at), 'last_beat_at is before started_at');
    expect(new Date(row.ended_at) >= new Date(row.last_beat_at), 'ended_at is before the last beat');
    await w.waitForSelector('#calendar-strip button[data-live]', { state: 'detached', timeout: 15000 });
    await w.waitForFunction(() => /^last streamed/.test(document.querySelector('#calendar-last')?.textContent || ''), null, { timeout: 5000 });
    return `row ${row.id} · ${Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000)}s`;
  });

  await step('the drop: the tab goes offline and away without its stop call; video ends the row within a beat of its last heartbeat', async () => {
    await goLive(a);
    const open = await pollUntil(async () => openRow(await today(NAME)), (r) => !!r && r.last_beat_at !== null, { timeout: 30000, label: 'a heartbeat on the new row' });
    // no stop call can leave the page: the network goes, then the tab. video sees the socket go
    // and calls the api's stop itself. the browser still sends a close frame as the tab goes, so
    // video reads this as the page's own stop (`stop`); a wifi that drops sends none and reads `video`
    await ctxA.setOffline(true);
    await sleep(300);
    await ctxA.close();
    const row = await pollUntil(
      async () => (await today(NAME)).find((r) => r.id === open.id),
      (r) => !!r && r.ended_at !== null,
      { timeout: 60000, label: 'the dropped row ended' }
    );
    expect(row.ended_by === 'video' || row.ended_by === 'stop', `ended_by ${row.ended_by}`);
    const late = (new Date(row.ended_at) - new Date(row.last_beat_at)) / 1000;
    expect(late >= 0 && late < 40, `ended ${late}s after the last heartbeat (want under 40: a beat plus ice's 15s)`);
    ctxA = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
    a = await ctxA.newPage();
    return `ended_by ${row.ended_by}, ${late.toFixed(1)}s after the last beat`;
  });

  await step('two sessions under five minutes apart are one block with a mark at the drop', async () => {
    // the watcher's strip re-asked on `ended`; the second session began inside five minutes of the first's end
    await w.waitForSelector('#calendar-strip button[data-live]', { state: 'detached', timeout: 20000 });
    await w.waitForSelector('#calendar-strip .drop', { timeout: 10000 });
    const labels = await w.$$eval('#calendar-strip button', (els) => els.map((e) => e.getAttribute('aria-label')));
    const merged = labels.find((l) => /dropped .*, back /.test(l || ''));
    expect(merged, `no block says dropped and back; the blocks say ${JSON.stringify(labels)}`);
    return merged;
  });

  await step(`an account's rows are its own: ${ACCOUNT} goes live and stops over the api, and the range lists the row`, async () => {
    const acct = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    const up = await acct.post('/api/signup', { data: { name: ACCOUNT, password: PW } });
    expect(up.status() === 201, `signup got ${up.status()}`);
    const grant = await (await acct.post(`/api/streams/${ACCOUNT}/go-live`)).json();
    expect(grant && grant.session, `go-live said ${JSON.stringify(grant)}`);
    const stop = await acct.post(`/api/streams/${ACCOUNT}/stop?session=${grant.session}&token=${grant.token}`);
    expect(stop.status() === 200, `stop got ${stop.status()}`);
    const rows = await (await range(ACCOUNT, Date.now() - DAY, Date.now() + DAY)).json();
    const row = rows.find((r) => r.id === grant.session);
    expect(row && row.ended_by === 'stop', `the account's range says ${JSON.stringify(rows)}`);
    await acct.dispose();
    return `row ${row.id} on ${ACCOUNT}`;
  });

  await browser.close();
  await api.dispose();
  const failed = results.filter((r) => r === 'fail').length;
  const skipped = results.filter((r) => r === 'skip').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed - skipped}/${results.length}${skipped ? `  (${skipped} skipped)` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
