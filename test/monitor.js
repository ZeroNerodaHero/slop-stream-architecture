// Monitor (docs/debugging.md): `api monitor` on this machine watches the local stack and a dead
// address. The live one comes up with the stack's own build, the dead one goes down after
// DOWN_AFTER rounds with a reason, the page shows both, and the memory survives a restart of the
// monitor. Local only: it runs monitor/docker-compose.yml as project monitor-test on port 3012
// with the stream-api image already here (./scripts/deploy.sh builds it), joins it to the stack's network
// so it can reach caddy as https://frontend (from inside a container, 127.0.0.1 is the container),
// and removes it all at the end. Run through ./scripts/test.sh, or: BASE_URL=https://<ip> LOCAL=1 node monitor.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const OPS_TOKEN = process.env.OPS_TOKEN || '';
const REPO = path.join(__dirname, '..');
const PORT = 3012;
const MON = `http://127.0.0.1:${PORT}`;
const PROJECT = 'monitor-test';
// fast rounds: a dead box is down after ~4s instead of 45. the shell env wins over monitor/.env
const STACK_NETWORK = 'stream_default'; // `name: stream` in docker-compose.yml
const ENV = {
  ...process.env,
  TARGETS: 'local=https://frontend,dead=https://127.0.0.1:9',
  OPS_TOKENS: OPS_TOKEN ? `local=${OPS_TOKEN}` : '',
  ALERT_WEBHOOK: '',
  CHECK_EVERY_SECS: '2',
  ERRORS_EVERY_SECS: '3',
  DOWN_AFTER: '2',
  MONITOR_PORT: String(PORT)
};
const compose = (cmd) => execSync(`docker compose -f monitor/docker-compose.yml -p ${PROJECT} ${cmd}`, { cwd: REPO, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const results = [];
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

// the monitor's json, once `ready(state)` says so, or a throw with the monitor's log
async function stateWhen(api, ready, what, ms = 40000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    try {
      const res = await api.get(`${MON}/api/monitor`);
      if (res.ok()) {
        last = await res.json();
        if (ready(last)) return last;
      }
    } catch {}
    await sleep(500);
  }
  let log = '';
  try { log = compose('logs --no-log-prefix --tail 15 monitor'); } catch {}
  const hint = /postgres not ready/.test(log) ? '\n      the stream-api image here predates the monitor (it tried to be the api). ./scripts/deploy.sh api builds the current one' : '';
  throw new Error(`${what} did not happen in ${ms / 1000}s. last state: ${last ? JSON.stringify(last.targets.map((t) => [t.name, t.status, t.reason])) : 'no answer'}${hint}\n      monitor log:\n      ${log.trim().split('\n').join('\n      ')}`);
}

(async () => {
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  let cleanup = false;

  await step('the monitor starts from the stream-api image already here, on the stack network', async () => {
    try { compose('down -v --remove-orphans'); } catch {}
    try {
      compose('up --no-build --no-start');
    } catch (e) {
      throw new Error(`docker compose up: ${String(e.stderr || e.message).trim().split('\n').pop()} (no stream-api image? ./scripts/deploy.sh builds it)`);
    }
    cleanup = true;
    try {
      execSync(`docker network connect ${STACK_NETWORK} monitor`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`docker network connect ${STACK_NETWORK}: ${String(e.stderr || e.message).trim().split('\n').pop()} (is the stack up?)`);
    }
    compose('start');
    const s = await stateWhen(api, (st) => st.targets.length === 2, 'GET /api/monitor with both targets', 20000);
    return `build ${s.monitor.build}, every ${s.monitor.check_every_secs}s, down after ${s.monitor.down_after}`;
  });

  let state = null;
  const known = () => {
    if (!state) throw new Error('the step before did not get a state');
    return state;
  };
  await step('the local stack is up with its own build; the dead address is down with a reason', async () => {
    state = await stateWhen(api, (st) => st.targets.every((t) => t.status === (t.name === 'local' ? 'up' : 'down')), 'local up and dead down');
    const local = state.targets.find((t) => t.name === 'local');
    const dead = state.targets.find((t) => t.name === 'dead');
    const health = await (await api.get(`${BASE}/api/health`)).json();
    expect(local.health && local.health.build === health.build, `local.health.build ${local.health && local.health.build} vs the stack's ${health.build}`);
    expect(typeof local.uptime_24h === 'number' && local.uptime_24h > 0, `uptime_24h ${local.uptime_24h}`);
    expect(local.events.some((e) => e.kind === 'up'), `no up event for local: ${JSON.stringify(local.events)}`);
    expect(dead.reason && /connect|refused|answer/i.test(dead.reason), `dead.reason "${dead.reason}"`);
    expect(dead.events.some((e) => e.kind === 'down' && e.text.startsWith('dead DOWN')), `no down event for dead: ${JSON.stringify(dead.events)}`);
    expect(dead.since && Date.parse(dead.since) <= Date.parse(dead.checked_at), 'dead.since is not before its last check');
    return `local ${local.latency_ms} ms, build ${local.health.build} · dead: ${dead.reason}`;
  });

  await step('error reports come through with the token, or the page says why not', async () => {
    const local = known().targets.find((t) => t.name === 'local');
    if (!OPS_TOKEN) {
      expect(local.errors_status === 'no OPS_TOKEN for this box', `errors_status "${local.errors_status}"`);
      return { skip: 'no OPS_TOKEN in .env, so the pull is off and says so' };
    }
    const s = await stateWhen(api, (st) => st.targets.find((t) => t.name === 'local').errors_at, 'a first /api/errors pull', 15000);
    const l = s.targets.find((t) => t.name === 'local');
    expect(!l.errors_status, `errors_status "${l.errors_status}" (401 means OPS_TOKEN in .env is not what the api has)`);
    expect(Array.isArray(l.errors), 'errors is not a list');
    return `${l.errors.length} report(s) pulled`;
  });

  await step('the page shows both boxes with their status', async () => {
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(MON, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-name="local"] .pill', { timeout: 15000 });
      const up = (await page.textContent('[data-name="local"] .pill')).trim();
      const down = (await page.textContent('[data-name="dead"] .pill')).trim();
      const cards = await page.locator('.target').count();
      const meta = (await page.textContent('#meta')).trim();
      expect(up === 'up' && down === 'down', `pills: local "${up}", dead "${down}"`);
      expect(cards === 2, `${cards} cards`);
      expect(/build/.test(meta), `header: "${meta}"`);
      const events = (await page.textContent('[data-name="dead"] ul')).trim();
      expect(/dead DOWN/.test(events), `dead's events on the page: "${events}"`);
      return `"${meta}"`;
    } finally {
      await browser.close();
    }
  });

  await step('a restart of the monitor keeps what it knew', async () => {
    const before = known().targets.find((t) => t.name === 'dead').events.find((e) => e.kind === 'down');
    compose('restart monitor');
    const s = await stateWhen(api, (st) => st.targets.length === 2 && st.targets.find((t) => t.name === 'dead').events.length > 0, 'the monitor back with its memory', 20000);
    const after = s.targets.find((t) => t.name === 'dead').events.find((e) => e.kind === 'down' && e.at === before.at);
    expect(after, `the down event from ${before.at} is gone after the restart`);
    return `down event from ${before.at} still there`;
  });

  if (cleanup) {
    try { compose('down -v --remove-orphans'); } catch (e) { console.log(`      (could not remove ${PROJECT}: ${String(e.message).split('\n')[0]})`); }
  }
  await api.dispose();

  const failed = results.filter((r) => r === 'fail').length;
  const skipped = results.filter((r) => r === 'skip').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed - skipped}/${results.length}${skipped ? `  (${skipped} skipped)` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
