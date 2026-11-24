const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const path = require('path');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const OPS_TOKEN = process.env.OPS_TOKEN || '';
const REPO = path.join(__dirname, '..');
const PORT = 3012;
const MON = `http://127.0.0.1:${PORT}`;
const PROJECT = 'monitor-test';
const CONTAINER = 'monitor-test';
const STACK_NETWORK = 'stream_default';
const ENV = {
  ...process.env,
  STATS_TARGETS: 'local=https://frontend,dead=https://127.0.0.1:9',
  STATS_TOKENS: OPS_TOKEN ? `local=${OPS_TOKEN}` : '',
  STATS_ALERT_WEBHOOK: '',
  STATS_PUBLIC: '',
  CHECK_EVERY_SECS: '2',
  ERRORS_EVERY_SECS: '3',
  METRICS_EVERY_SECS: '2',
  DOWN_AFTER: '2',
  MONITOR_PORT: String(PORT),
  MONITOR_CONTAINER: CONTAINER
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
      execSync(`docker network connect ${STACK_NETWORK} ${CONTAINER}`, { stdio: ['ignore', 'pipe', 'pipe'] });
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

  await step("the local box's host and container numbers come through the agent, or the page says why not", async () => {
    const metricsOf = (st) => st.targets.find((t) => t.name === 'local').metrics || {};
    if (!OPS_TOKEN) {
      const s = await stateWhen(api, (st) => metricsOf(st).status, 'a first /api/metrics pull', 15000);
      expect(metricsOf(s).status === 'no OPS_TOKEN for this box', `metrics.status "${metricsOf(s).status}"`);
      return { skip: 'no OPS_TOKEN in .env, so the agent is not asked and the page says so' };
    }
    const s = await stateWhen(api, (st) => metricsOf(st).host && metricsOf(st).host.cpu_pct !== null && metricsOf(st).containers > 0, 'host and container numbers for local', 45000);
    const m = metricsOf(s);
    const h = m.host;
    expect(!m.status, `metrics.status "${m.status}" (a 404 means the agent has no OPS_TOKEN or the Caddyfile has no /api/metrics route)`);
    expect(h.mem_used > 0 && h.mem_used < h.mem_total, `memory ${h.mem_used} of ${h.mem_total}`);
    expect(h.disk.length === 1 && h.disk[0].used > 0 && h.disk[0].used < h.disk[0].total, `disk ${JSON.stringify(h.disk)}`);
    expect(h.cpu_pct >= 0 && h.cpu_pct <= 100, `cpu ${h.cpu_pct}`);
    const series = await (await api.get(`${MON}/api/monitor/metrics?target=local&range=1h`)).json();
    expect(series.t.length >= 1 && series.host.cpu_pct.length === series.t.length, `series: ${series.t.length} points`);
    const apiBox = series.latest.containers.find((c) => c.name === 'api');
    expect(apiBox && apiBox.state === 'running' && apiBox.mem_bytes > 0, `the api container: ${JSON.stringify(apiBox)}`);
    expect(series.containers.api && series.containers.api.cpu_pct.length === series.t.length, 'no cpu series for the api container');
    const bad = await api.get(`${MON}/api/monitor/metrics?target=local&range=2y`);
    expect(bad.status() === 400, `range=2y answered ${bad.status()}`);
    return `cpu ${h.cpu_pct}% · mem ${Math.round(h.mem_used / 1048576)} of ${Math.round(h.mem_total / 1048576)} MiB · ${m.containers} containers · ${series.t.length} points`;
  });

  await step("the local box's endpoint and call timings come through the agent, and the page lists them", async () => {
    if (!OPS_TOKEN) return { skip: 'no OPS_TOKEN in .env, so the agent is not asked' };
    for (let i = 0; i < 5; i++) await api.get(`${BASE}/api/streamers/timing-probe-${i}`);
    const until = Date.now() + 45000;
    let rows = [];
    while (Date.now() < until) {
      const res = await api.get(`${MON}/api/monitor/timings?range=1h&target=local`);
      if (res.ok()) rows = (await res.json()).rows;
      if (rows.some((r) => r.name === '/api/streamers/{name}') && rows.some((r) => r.kind === 'db')) break;
      await sleep(1000);
    }
    const route = rows.find((r) => r.kind === 'http' && r.method === 'GET' && r.name === '/api/streamers/{name}');
    expect(route, `no GET /api/streamers/{name} line in ${rows.length} rows (is TIMINGS_FROM set on the agent, and does the stack run this build?)`);
    expect(route.n >= 5 && route.p50 > 0 && route.p99 >= route.p50 && route.max >= route.p99, `the route line: ${JSON.stringify(route)}`);
    expect(!rows.some((r) => r.name.includes('timing-probe')), 'a raw path made it into the names');
    expect(rows.some((r) => r.kind === 'db') && rows.some((r) => r.kind === 'redis'), `kinds: ${[...new Set(rows.map((r) => r.kind))]}`);
    const detail = await (await api.get(`${MON}/api/monitor/timings/series?target=local&range=1h&key=${encodeURIComponent(route.key)}`)).json();
    expect(detail.t.length >= 1 && detail.p95.length === detail.t.length, `detail: ${JSON.stringify(detail).slice(0, 200)}`);
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${MON}/#box=local&tab=endpoints&q=streamers`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('table.eps tr.ep', { timeout: 20000 });
      await page.locator('table.eps th', { hasText: 'p99' }).first().click();
      expect(/sort=-p99/.test(page.url()), `the url does not carry the sort: ${page.url()}`);
      await page.locator('table.eps tr.ep', { hasText: '/api/streamers/{name}' }).first().click();
      await page.waitForSelector('table.eps tr.detail canvas', { timeout: 15000 });
    } finally {
      await browser.close();
    }
    const totals = (await (await api.get(`${MON}/api/monitor/timings?range=1h&target=local`)).json()).totals;
    const http = totals.find((t) => t.kind === 'http');
    expect(http && http.n >= 5 && http.sum_ms > 0 && http.p95 > 0, `the http total: ${JSON.stringify(http)}`);
    return `${rows.length} lines, ${[...new Set(rows.map((r) => r.kind))].join('/')} · GET /api/streamers/{name} p50 ${route.p50} ms p99 ${route.p99} ms · http p95 ${http.p95} ms`;
  });

  await step("the local box's containers as a graph, with no addresses in it", async () => {
    if (!OPS_TOKEN) return { skip: 'no OPS_TOKEN in .env, so the agent is not asked' };
    const res = await api.get(`${MON}/api/monitor/architecture?target=local`);
    expect(res.ok(), `architecture answered ${res.status()}`);
    const body = await res.text();
    const g = JSON.parse(body);
    const apiNode = g.nodes.find((n) => n.name === 'api');
    expect(apiNode && apiNode.state === 'running', `the api node: ${JSON.stringify(apiNode)}`);
    expect(g.edges.some((e) => e.to === apiNode.id && e.port === 4000), 'no edge into api:4000');
    expect(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(body), 'an ip address in the architecture');
    expect((await api.get(`${MON}/api/monitor/architecture?target=nobody`)).status() === 404, 'an unknown box is not a 404');
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${MON}/#box=local&tab=containers&view=arch`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('svg g.node', { timeout: 20000 });
      const nodes = await page.locator('svg g.node').count();
      expect(nodes >= g.nodes.length, `${nodes} nodes drawn of ${g.nodes.length}`);
    } finally {
      await browser.close();
    }
    return `${g.nodes.length} nodes, ${g.edges.length} edges, ${g.networks.length} networks`;
  });

  await step('the page shows both boxes with their status', async () => {
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(MON, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-name="local"] .pill', { timeout: 15000 });
      const up = (await page.textContent('[data-name="local"] .pill')).trim();
      const down = (await page.textContent('[data-name="dead"] .pill')).trim();
      const cards = await page.locator('.target[data-name]').count();
      const meta = (await page.textContent('#meta')).trim();
      expect(up === 'up' && down === 'down', `pills: local "${up}", dead "${down}"`);
      expect(cards === 2, `${cards} cards`);
      expect(/build/.test(meta), `header: "${meta}"`);
      const events = (await page.textContent('[data-name="dead"] ul')).trim();
      expect(/dead DOWN/.test(events), `dead's events on the page: "${events}"`);
      await page.click('#tabs button:has-text("local")');
      expect(/box=local/.test(page.url()), `the url does not name the box: ${page.url()}`);
      if (!OPS_TOKEN) return `"${meta}"`;
      await page.waitForSelector('.tile canvas', { timeout: 15000 });
      const tiles = await page.locator('.tile').count();
      expect(tiles >= 7, `${tiles} graphs on local's tab`);
      return `"${meta}", ${tiles} graphs on local's tab`;
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
