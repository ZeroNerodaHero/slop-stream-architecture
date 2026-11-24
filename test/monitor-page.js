const { chromium } = require('playwright');

const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};

const rewrite = (change) => async (route) => {
  try {
    const res = await route.fetch();
    const j = await res.json();
    change(j);
    await route.fulfill({ response: res, json: j });
  } catch {
    await route.abort().catch(() => {});
  }
};

async function pageSurvivesOddAnswers(browser, MON) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let flip = false;
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.route(/\/api\/monitor$/, rewrite((j) => {
    if (flip) j.monitor.build = `${j.monitor.build}-next`;
  }));
  await page.route(/\/api\/monitor\/timings\?/, rewrite((j) => {
    const target = (j.rows[0] && j.rows[0].target) || 'local';
    j.rows = [
      ...j.rows,
      { target, key: 'odd', kind: 'http', method: 'GET', name: '/no-spark-no-percentiles', src: 'api', n: 3 },
      { target, kind: 'db', name: null, n: '7', p95: 'x', spark: null },
      { target, kind: 'redis', method: 'GET', name: 'GET', src: 'api', n: 1, spark: 'not a list', b: 5 },
      {},
      null,
    ];
    j.totals = [...(j.totals || []), { kind: 'http' }, null];
  }));
  await page.route(/\/api\/monitor\/architecture\?/, (route) => route.fulfill({ json: { at: new Date().toISOString(), nodes: [{ id: 'a' }, { name: 'no id' }], edges: [{ from: 'a' }, { from: 'a', to: 'gone', what: 'x' }], networks: [{ name: 'n' }] } }));
  try {
    await page.goto(`${MON}/#tab=endpoints&q=no-spark`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('table.eps tr.ep', { timeout: 20000 });
    const row = (await page.textContent('table.eps tr.ep')) || '';
    expect(/no-spark-no-percentiles/.test(row), `the odd row is not in the table: "${row}"`);
    await page.click('#views button[data-id="calls"]');
    await page.waitForSelector('table.eps tr.ep', { timeout: 10000 });
    await page.click('#views button[data-id="containers"]');
    await page.goto(`${MON}/#tab=containers&view=arch`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('svg g.node', { timeout: 10000 });
    await page.goto(`${MON}/#tab=host`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.target', { timeout: 10000 });
    await page.waitForTimeout(6000);
    const asof = ((await page.textContent('#asof')) || '').trim();
    const drawn = ((await page.textContent('#drawn')) || '').trim();
    expect(!asof && !drawn, `the header says "${asof}" "${drawn}"`);
    expect(!errors.length, `page errors: ${errors.join(' | ')}`);
    const before = loads;
    flip = true;
    const until = Date.now() + 15000;
    while (loads === before && Date.now() < until) await page.waitForTimeout(250);
    expect(loads > before, 'a new monitor build did not reload the page');
    await page.waitForTimeout(6000);
    expect(loads === before + 1, `the page reloaded ${loads - before} times for one new build`);
    return 'missing spark and fields, a broken graph answer and a new build: the page keeps drawing, reloads once';
  } finally {
    await page.close();
  }
}

module.exports = { pageSurvivesOddAnswers };

if (require.main === module) {
  (async () => {
    const MON = process.env.MONITOR_URL || 'http://127.0.0.1:3002';
    const opts = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.BROWSER_CHANNEL || 'chrome' };
    const browser = await chromium.launch({ ...opts, headless: true });
    try {
      console.log(`PASS  ${await pageSurvivesOddAnswers(browser, MON)}`);
    } catch (e) {
      console.log(`FAIL  ${e.message}`);
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  })();
}
