const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:5173';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
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

const MODULES = {
  sources: '#sources-panel',
  face: '#face-panel',
  rig: '#rig',
  sound: '#mixer',
  chat: '#live-chat',
  studio: '#live-controls',
  layout: '#live-layouts',
  presets: '#live-presets',
  thumbnail: '#thumbs-panel'
};

const breakAtom = (page, name, value) =>
  page.evaluate(
    async ([name, value]) => {
      const p = await import('/src/infra/atoms/publish-atoms.ts');
      const { store } = await import('/src/infra/store.ts');
      store.set(p[name], value);
    },
    [name, value]
  );
const present = (page) => page.evaluate((all) => Object.entries(all).filter(([, sel]) => document.querySelector(sel)).map(([id]) => id), MODULES);

(async () => {
  const host = new URL(BASE).host;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    delete window.SharedWorker;
    delete window.RTCPeerConnection;
    localStorage.setItem('settings.shape', JSON.stringify('bubble'));
  });
  await context.routeWebSocket(/.*/, () => {});
  await context.route(
    (url) => url.host !== host,
    (route) => route.fulfill({ status: 404, body: '' })
  );
  await context.route(/^https?:\/\/[^/]+\/(api|chat|thumb|avatars?|media|u|hls)\//, (route) =>
    route.fulfill({ status: route.request().method() === 'GET' ? 404 : 403, contentType: 'application/json', body: 'null' })
  );
  const page = await context.newPage();
  await page.goto(BASE + '/live', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#live-desk', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#mic-device-pick'), null, { timeout: 20000 });

  await step('every module draws', async () => {
    const all = await present(page);
    expect(all.length === Object.keys(MODULES).length, `only ${all.join(', ')}`);
    return all.join(' ');
  });

  await step('a throw in sound shows its reload panel and nothing else goes', async () => {
    await page.evaluate(() => {
      window.__preview = document.querySelector('#preview');
      window.__rig = document.querySelector('#rig-video');
    });
    await breakAtom(page, 'micDevicesAtom', null);
    await page.waitForSelector('#live-crash-sound', { timeout: 5000 });
    const all = await present(page);
    expect(!all.includes('sound'), 'sound is still drawn');
    expect(all.length === Object.keys(MODULES).length - 1, `missing ${Object.keys(MODULES).filter((m) => !all.includes(m) && m !== 'sound')}`);
    expect(await page.evaluate(() => window.__preview === document.querySelector('#preview') && window.__rig === document.querySelector('#rig-video')), 'the preview or the rig video was drawn again');
  });

  await step('the reload panel remounts sound alone', async () => {
    await breakAtom(page, 'micDevicesAtom', []);
    await page.click('#live-reload-sound');
    await page.waitForSelector('#mixer', { timeout: 5000 });
    expect(!(await page.$('#live-crash-sound')), 'the reload panel stayed');
    expect(await page.evaluate(() => window.__preview === document.querySelector('#preview')), 'the preview was drawn again');
  });

  await step('a throw in the rail thumbnail leaves start and presets', async () => {
    await breakAtom(page, 'streamThumbsAtom', { length: 1 });
    await page.waitForSelector('#live-crash-thumbnail', { timeout: 5000 });
    const all = await present(page);
    expect(all.includes('studio') && all.includes('presets') && all.includes('layout') && all.includes('sound'), all.join(', '));
    expect(!!(await page.$('#start')), 'no start button');
    await breakAtom(page, 'streamThumbsAtom', []);
    await page.click('#live-reload-thumbnail');
    await page.waitForSelector('#thumbs-panel', { timeout: 5000 });
  });

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
