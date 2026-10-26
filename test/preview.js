// The watch document and the profile picture: /watch/<name> is html from the api with a
// <title>, og:* tags and the profile filled in (offline, with a picture, live with the
// thumbnail), the picture round-trips and is the owner's only, the shared link carries
// ?s=<session>, and the spa still boots on the page the api served.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node preview.js
const { chromium, request } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const RUN = Date.now().toString(36).slice(-5);
const NAME = 'pv' + RUN;
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const status = (page) => page.evaluate(() => document.querySelector('#status').textContent.trim());
async function waitStatus(page, re, timeout = 20000) {
  await page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#status').textContent), re.source, { timeout });
  return status(page);
}
/** content="..." of the og:/twitter: tag, or null. */
const meta = (html, prop) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`));
  return m ? m[1] : null;
};
const title = (html) => (html.match(/<title>([^<]*)<\/title>/g) || []).map((t) => t.slice(7, -8));
/** The api put the card inside #root (the template starts with whitespace). */
const hasCard = (html) => /<div id="root">\s*<main/.test(html);

(async () => {
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, timeout: 10000 });
  const owner = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, timeout: 10000 });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] })).newPage();

  // a real jpeg, made by the browser, like the live page makes one
  const scratch = await fresh();
  const dataUrl = await scratch.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#4f8bff';
    x.fillRect(0, 0, 16, 16);
    return c.toDataURL('image/jpeg', 0.9);
  });
  await scratch.close();
  const JPEG = Buffer.from(dataUrl.split(',')[1], 'base64');
  const put = (ctx, name, data) => ctx.put(`/api/streamers/${name}/avatar`, { data, headers: { 'content-type': 'image/jpeg' } });

  await step('offline: /watch/<name> is html with a title and og tags, no image, the card says offline', async () => {
    const res = await anon.get(`/watch/${NAME}`);
    const html = await res.text();
    expect(res.status() === 200 && /text\/html/.test(res.headers()['content-type']), `${res.status()} ${res.headers()['content-type']}`);
    expect(/no-cache/.test(res.headers()['cache-control'] || ''), `cache-control ${res.headers()['cache-control']}`);
    expect(title(html).length === 1 && title(html)[0] === `${NAME} · offline`, `titles ${JSON.stringify(title(html))}`);
    expect(meta(html, 'og:title') === `${NAME} · offline`, `og:title ${meta(html, 'og:title')}`);
    expect(meta(html, 'og:description') === 'not live right now', `og:description ${meta(html, 'og:description')}`);
    expect((meta(html, 'og:url') || '').endsWith(`/watch/${NAME}`), `og:url ${meta(html, 'og:url')}`);
    expect(meta(html, 'og:image') === null, `og:image ${meta(html, 'og:image')}`);
    expect(hasCard(html) && html.includes(`>${NAME}</h1>`) && html.includes('>offline</p>'), 'the card is not filled in');
    expect(/<script type="module" crossorigin src="\/assets\/index-[^"]+\.js">/.test(html), 'the spa script tag is gone');
    const slash = await anon.get(`/watch/${NAME.toUpperCase()}/`);
    expect(slash.status() === 200 && meta(await slash.text(), 'og:title') === `${NAME} · offline`, `trailing slash + caps got ${slash.status()}`);
    return `"${meta(html, 'og:title')}"`;
  });

  await step('a bad name or an extra path segment: 404, still the spa page', async () => {
    const bad = await anon.get(`/watch/not%20a%20name!`);
    const deep = await anon.get(`/watch/${NAME}/extra`);
    const none = await anon.get(`/watch/`);
    for (const [what, res] of [['bad name', bad], ['extra segment', deep], ['nothing', none]]) {
      const html = await res.text();
      expect(res.status() === 404, `${what}: ${res.status()}`);
      expect(html.includes('<div id="root"></div>') && /<script type="module"/.test(html), `${what}: not the spa shell`);
      expect(!html.includes('og:title'), `${what}: has og tags`);
    }
    return '404 x3, spa shell each time';
  });

  let version;
  await step('the picture: not a jpeg 400, too big 413, a jpeg 200 and it comes back the same', async () => {
    const text = await put(anon, NAME, Buffer.from('hello'));
    expect(text.status() === 400, `text got ${text.status()}`);
    const big = await put(anon, NAME, Buffer.concat([JPEG, Buffer.alloc(300 * 1024)]));
    expect(big.status() === 413, `300 kb got ${big.status()}`);
    const ok = await put(anon, NAME, JPEG);
    const saved = await ok.json();
    expect(ok.status() === 200 && Number.isInteger(saved.avatar), `jpeg got ${ok.status()} ${JSON.stringify(saved)}`);
    version = saved.avatar;
    const back = await anon.get(`/api/streamers/${NAME}/avatar?v=${version}`);
    expect(back.status() === 200 && back.headers()['content-type'] === 'image/jpeg', `get got ${back.status()} ${back.headers()['content-type']}`);
    expect(/public/.test(back.headers()['cache-control'] || ''), `cache-control ${back.headers()['cache-control']}`);
    expect(Buffer.compare(await back.body(), JPEG) === 0, 'bytes differ');
    const me = await (await anon.get(`/api/streamers/${NAME}`)).json();
    expect(me.avatar === version, `streamer json ${JSON.stringify(me)}`);
    return `${JPEG.length} bytes, v=${version}`;
  });

  await step('offline with a picture: og:image is the picture, summary card, the card has the <img>', async () => {
    const html = await (await anon.get(`/watch/${NAME}`)).text();
    expect((meta(html, 'og:image') || '').endsWith(`/api/streamers/${NAME}/avatar?v=${version}`), `og:image ${meta(html, 'og:image')}`);
    expect(meta(html, 'twitter:card') === 'summary', `twitter:card ${meta(html, 'twitter:card')}`);
    expect(hasCard(html) && html.includes(`<img src="/api/streamers/${NAME}/avatar?v=${version}"`), 'no <img> in the card');
    return meta(html, 'og:image');
  });

  await step("a claimed name's picture: anonymous 403, the owner 200", async () => {
    const CLAIMED = 'pvacct' + RUN;
    const signup = await owner.post('/api/signup', { data: { name: CLAIMED, password: 'correct horse battery' } });
    expect(signup.status() === 201, `signup got ${signup.status()}`);
    const no = await put(anon, CLAIMED, JPEG);
    expect(no.status() === 403, `anonymous got ${no.status()}`);
    const yes = await put(owner, CLAIMED, JPEG);
    expect(yes.status() === 200, `owner got ${yes.status()}`);
    const del = await anon.delete(`/api/streamers/${CLAIMED}/avatar`);
    expect(del.status() === 403, `anonymous delete got ${del.status()}`);
    await owner.post('/api/logout');
    return `${CLAIMED}`;
  });

  let publisher;
  await step('live: the share link has ?s=<session>, the live page shows the picture', async () => {
    publisher = await fresh();
    await publisher.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await publisher.fill('#name', NAME);
    await publisher.press('#name', 'Tab');
    await publisher.waitForSelector('#avatar-remove', { timeout: 10000 });
    await publisher.waitForFunction(() => !document.querySelector('#start').disabled);
    await publisher.click('#start');
    await waitStatus(publisher, /^live$/);
    const href = await publisher.getAttribute('#watchurl', 'href');
    expect(new RegExp(`/watch/${NAME}\\?s=\\d+$`).test(href), `link ${href}`);
    const img = await publisher.getAttribute(`img[src*="/api/streamers/${NAME}/avatar?v="]`, 'src');
    expect(img, 'no picture on the live page');
    return href.replace(BASE, '');
  });

  await step('live: og:title says live, og:image is the thumbnail once there is one (<= 15s)', async () => {
    const t0 = Date.now();
    while ((await anon.get(`/thumb/${NAME}.jpg`)).status() !== 200) {
      expect(Date.now() - t0 < 15000, 'no thumbnail after 15s');
      await sleep(1000);
    }
    const html = await (await anon.get(`/watch/${NAME}?s=123`)).text();
    expect(meta(html, 'og:title') === `${NAME} · live`, `og:title ${meta(html, 'og:title')}`);
    expect((meta(html, 'og:image') || '').endsWith(`/thumb/${NAME}.jpg`), `og:image ${meta(html, 'og:image')}`);
    expect(meta(html, 'twitter:card') === 'summary_large_image', `twitter:card ${meta(html, 'twitter:card')}`);
    expect(meta(html, 'og:description') === 'live now', `og:description ${meta(html, 'og:description')}`);
    expect((meta(html, 'og:url') || '').endsWith(`/watch/${NAME}`), `og:url keeps the query: ${meta(html, 'og:url')}`);
    expect(html.includes('>live</p>'), 'the card does not say live');
    return `thumbnail after ${Date.now() - t0} ms`;
  });

  await step('a watcher on the api-served page: react boots, watching, picture and tab title', async () => {
    const w = await fresh();
    await w.goto(`${BASE}/watch/${NAME}?s=123`, { waitUntil: 'domcontentloaded' });
    const s = await waitStatus(w, /^watching$/);
    const t = await w.title();
    expect(t === `${NAME} · streams`, `title "${t}"`);
    const img = await w.$(`#who img[src*="/api/streamers/${NAME}/avatar?v="]`);
    expect(img, 'no picture next to the name');
    expect((await w.$$('#status')).length === 1, 'two status lines: the card was not replaced');
    await w.close();
    await publisher.click('#stop');
    await waitStatus(publisher, /stopped/);
    return `status "${s}"`;
  });

  await step('remove the picture: 204, then 404 and no og:image', async () => {
    const del = await anon.delete(`/api/streamers/${NAME}/avatar`);
    expect(del.status() === 204, `delete got ${del.status()}`);
    const gone = await anon.get(`/api/streamers/${NAME}/avatar?v=${version}`);
    expect(gone.status() === 404, `get after delete got ${gone.status()}`);
    const html = await (await anon.get(`/watch/${NAME}`)).text();
    expect(meta(html, 'og:image') === null && meta(html, 'og:title') === `${NAME} · offline`, `after delete: ${meta(html, 'og:title')} ${meta(html, 'og:image')}`);
    return 'clean';
  });

  await browser.close();
  await anon.dispose();
  await owner.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
