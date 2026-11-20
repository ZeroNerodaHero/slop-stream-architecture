// Prefetch on press (docs/spec.md "Prefetch on press", frontend/src/infra/prefetch.ts): a press
// on a link to a stream's page, home or a group asks for that page's data on pointerdown, and the
// page takes the answer instead of asking again, so each is asked once, not twice. A press that
// goes nowhere asks once and nothing more. Run through ./scripts/test.sh, or:
// BASE_URL=https://<ip> node prefetch.js
// A step with nothing on the box to press (no person on home, no public group) says SKIP.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
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

/** Every api request the page makes from now on matching `method` and `re`, with when it went. */
function count(page, method, re) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === method && re.test(new URL(req.url()).pathname)) seen.push(Date.now());
  });
  return seen;
}

/** A real press on `selector`: down, held `holdMs` (a person's click is ~100-200ms), up. Returns when the button went down. */
async function press(page, selector, holdMs = 250, release = true) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} is not on screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const down = Date.now();
  await page.mouse.down();
  await sleep(holdMs);
  if (release) await page.mouse.up();
  else {
    // let go somewhere that is not a link: no click, no navigation
    await page.mouse.move(2, 2);
    await page.mouse.up();
  }
  return down;
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

  await step('a press on a person on home asks for the grant once, on the press', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#live', { timeout: 10000 });
    const link = p.locator('#people a[href^="/watch/"]').first();
    if (!(await link.count())) return { skip: 'nobody under people on this box' };
    const href = await link.getAttribute('href');
    const grants = count(p, 'POST', /^\/api\/streams\/[^/]+\/watch$/);
    const down = await press(p, `#people a[href="${href}"]`);
    await p.waitForURL((u) => u.pathname === href, { timeout: 5000 });
    await p.waitForSelector('#status', { timeout: 10000 });
    await sleep(1000);
    expect(grants.length === 1, `${grants.length} grants for ${href}`);
    expect(grants[0] - down < 200, `the grant went ${grants[0] - down}ms after the press, not on it`);
    await p.close();
    return `${href}: 1 grant, ${grants[0] - down}ms after pointerdown`;
  });

  await step('a press that goes nowhere asks once; the page later asks for itself', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#live', { timeout: 10000 });
    const link = p.locator('#people a[href^="/watch/"]').first();
    if (!(await link.count())) return { skip: 'nobody under people on this box' };
    const href = await link.getAttribute('href');
    const grants = count(p, 'POST', /^\/api\/streams\/[^/]+\/watch$/);
    await press(p, `#people a[href="${href}"]`, 150, false);
    await sleep(6000);
    expect(new URL(p.url()).pathname === '/', `moved to ${p.url()}`);
    expect(grants.length === 1, `${grants.length} grants after a press with no click`);
    // past the 5s it was kept: the click is a miss, and the page's own ask
    await p.locator(`#people a[href="${href}"]`).first().click();
    await p.waitForURL((u) => u.pathname === href, { timeout: 5000 });
    await sleep(1000);
    expect(grants.length === 2, `${grants.length} grants after the late click`);
    await p.close();
    return '1 on the press, 1 more from the page after expiry';
  });

  await step('home from a stream page asks for the list once', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/watch/prefetchtest`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#status', { timeout: 10000 });
    const streams = count(p, 'GET', /^\/api\/streams$/);
    const people = count(p, 'GET', /^\/api\/people$/);
    await press(p, 'header a[href="/"]');
    await p.waitForSelector('#live', { timeout: 10000 });
    await sleep(1000);
    expect(streams.length === 1, `${streams.length} GET /api/streams`);
    expect(people.length === 1, `${people.length} GET /api/people`);
    await p.close();
    return '1 /api/streams, 1 /api/people';
  });

  await step('a group from home asks for its room and its lines once', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#live', { timeout: 10000 });
    const link = p.locator('#home-groups a[href^="/groups/"]').first();
    try {
      await link.waitFor({ timeout: 5000 });
    } catch {
      return { skip: 'no group on home on this box' };
    }
    const href = await link.getAttribute('href');
    const server = decodeURIComponent(href.split('/')[2]);
    const room = count(p, 'GET', new RegExp(`^/api/groups/${encodeURIComponent(server)}$`));
    const lines = count(p, 'GET', new RegExp(`^/api/groups/${encodeURIComponent(server)}/messages$`));
    await press(p, `#home-groups a[href="${href}"]`);
    await p.waitForURL((u) => u.pathname.startsWith(`/groups/${encodeURIComponent(server)}`), { timeout: 5000 });
    await sleep(1500);
    expect(room.length === 1, `${room.length} GET of the room`);
    expect(lines.length === 1, `${lines.length} GET of the lines`);
    await p.close();
    return `${server}: 1 room, 1 lines`;
  });

  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})();
