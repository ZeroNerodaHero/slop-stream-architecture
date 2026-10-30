// The watch document and the profile pictures: /watch/<name> is html from the api with a
// <title>, og:* tags and the profile filled in (offline, with a picture, with the offline
// picture, live with the thumbnail), the pictures round-trip and are the owner's only, the
// offline picture and the line under the word show on the page and in the profile tab, the
// shared link carries ?s=<session>, and the spa still boots on the page the api served.
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

  // ---- the offline picture and the line under the word: what the page shows while they are not live ----
  let offlineVersion;
  const NOTE = 'back tuesday at 8';
  const putOffline = (ctx, name, data) => ctx.put(`/api/streamers/${name}/offline`, { data, headers: { 'content-type': 'image/jpeg' } });
  const putNote = (ctx, name, note) => ctx.put(`/api/streamers/${name}/offline-note`, { data: { note } });

  await step('the offline picture: not a jpeg 400, over 512 kb 413, 300 kb 200 (its own ceiling), round-trips; the line is kept as one line', async () => {
    const text = await putOffline(anon, NAME, Buffer.from('hello'));
    expect(text.status() === 400, `text got ${text.status()}`);
    const big = await putOffline(anon, NAME, Buffer.concat([JPEG, Buffer.alloc(600 * 1024)]));
    expect(big.status() === 413, `600 kb got ${big.status()}`);
    // past the avatar's 256 kb and under this picture's 512: the wider one has a ceiling of its own
    const wide = await putOffline(anon, NAME, Buffer.concat([JPEG, Buffer.alloc(300 * 1024)]));
    expect(wide.status() === 200, `300 kb got ${wide.status()}`);
    const ok = await putOffline(anon, NAME, JPEG);
    const saved = await ok.json();
    expect(ok.status() === 200 && Number.isInteger(saved.offline), `jpeg got ${ok.status()} ${JSON.stringify(saved)}`);
    offlineVersion = saved.offline;
    const back = await anon.get(`/api/streamers/${NAME}/offline?v=${offlineVersion}`);
    expect(back.status() === 200 && back.headers()['content-type'] === 'image/jpeg', `get got ${back.status()} ${back.headers()['content-type']}`);
    expect(/public/.test(back.headers()['cache-control'] || ''), `cache-control ${back.headers()['cache-control']}`);
    expect(Buffer.compare(await back.body(), JPEG) === 0, 'bytes differ');
    const note = await putNote(anon, NAME, '  back\n tuesday   at 8 ');
    const kept = await note.json();
    expect(note.status() === 200 && kept.offline_note === NOTE, `the line got ${note.status()} ${JSON.stringify(kept)}`);
    const me = await (await anon.get(`/api/streamers/${NAME}`)).json();
    expect(me.offline === offlineVersion && me.offline_note === NOTE, `streamer json ${JSON.stringify(me)}`);
    return `v=${offlineVersion}, "${kept.offline_note}"`;
  });

  await step('offline with an offline picture: og:image is it, a large card, the player box wears it; the page shows it and the line', async () => {
    const html = await (await anon.get(`/watch/${NAME}`)).text();
    expect((meta(html, 'og:image') || '').endsWith(`/api/streamers/${NAME}/offline?v=${offlineVersion}`), `og:image ${meta(html, 'og:image')}`);
    expect(meta(html, 'twitter:card') === 'summary_large_image', `twitter:card ${meta(html, 'twitter:card')}`);
    expect(hasCard(html) && html.includes(`style="background-image:url(/api/streamers/${NAME}/offline?v=${offlineVersion})"`), 'the player box does not wear the picture');
    expect(html.includes(`<img src="/api/streamers/${NAME}/avatar?v=${version}"`), 'the face left the card');
    const w = await fresh();
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#offline-picture', { timeout: 15000 });
    const src = await w.getAttribute('#offline-picture', 'src');
    expect((src || '').endsWith(`/api/streamers/${NAME}/offline?v=${offlineVersion}`), `the page's picture is ${src}`);
    const line = ((await w.textContent('#offline-note')) || '').trim();
    expect(line === NOTE, `the line reads "${line}"`);
    expect((await w.$$('#video')).length === 0, 'a player is on the page while nobody is live');
    await w.close();
    return meta(html, 'og:image');
  });

  /** The profile tab's page and the offline picture's bytes as last put up: the crop step after reuses both. */
  let profile;
  let offlineBytes;
  let PNG;
  /** The pixel ten in from the bottom right corner of a jpeg, decoded in the page. */
  const cornerOf = (page, buf) =>
    page.evaluate(async (b64) => {
      const i = new Image();
      i.src = 'data:image/jpeg;base64,' + b64;
      await i.decode();
      const c = document.createElement('canvas');
      c.width = i.naturalWidth;
      c.height = i.naturalHeight;
      const x = c.getContext('2d');
      x.drawImage(i, 0, 0);
      const [r, g, b] = x.getImageData(i.naturalWidth - 10, i.naturalHeight - 10, 1, 1).data;
      return { r, g, b };
    }, buf.toString('base64'));

  await step('the profile tab as the name: the picture and the line are there; a wide png lands as a 1280x720 jpeg under 512 kb', async () => {
    const p = await fresh();
    profile = p;
    await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await p.hover('#user-panel');
    await p.waitForSelector('#username', { timeout: 15000 });
    await p.fill('#username', NAME);
    await p.press('#username', 'Enter');
    // the profile tab: the gear at the end of your line opens the modal (the picture is your page now), then the tab
    await p.hover('#user-panel');
    await p.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await p.click('#settings');
    await p.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await p.click('#tab-profile');
    await p.waitForFunction((v) => (document.querySelector('#profile-offline-preview')?.getAttribute('src') || '').endsWith(`/offline?v=${v}`), offlineVersion, { timeout: 10000 });
    expect((await p.inputValue('#profile-offline-note')) === NOTE, `the box holds "${await p.inputValue('#profile-offline-note')}"`);
    // a 2000x1000 png with a gradient: not a jpeg, not 16:9, far over the ceiling as it is
    const png = await p.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 2000;
      c.height = 1000;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 2000, 1000);
      g.addColorStop(0, '#ff8800');
      g.addColorStop(1, '#0044ff');
      x.fillStyle = g;
      x.fillRect(0, 0, 2000, 1000);
      return c.toDataURL('image/png');
    });
    PNG = Buffer.from(png.split(',')[1], 'base64');
    await p.setInputFiles('#profile-offline-file', { name: 'banner.png', mimeType: 'image/png', buffer: PNG });
    // the crop dialog opens over the modal, the 16:9 box as big as fits in the middle; used as it is, that is the old middle cut
    await p.waitForSelector('#crop[open] #crop-box', { timeout: 10000 });
    const goes = ((await p.textContent('#crop-size')) || '').trim();
    expect(goes === 'goes up as a 1280×720 jpeg', `the dialog says "${goes}"`);
    await p.click('#crop-use');
    await p.waitForFunction(() => document.querySelector('#profile-offline-status')?.textContent === 'saved', null, { timeout: 15000 });
    const me = await (await anon.get(`/api/streamers/${NAME}`)).json();
    expect(Number.isInteger(me.offline) && me.offline >= offlineVersion, `after the upload: ${JSON.stringify(me)}`);
    offlineVersion = me.offline;
    const bytes = await (await anon.get(`/api/streamers/${NAME}/offline?v=${offlineVersion}`)).body();
    offlineBytes = bytes;
    expect(bytes.length <= 512 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8, `${bytes.length} bytes, not a jpeg under 512 kb`);
    const size = await p.evaluate(
      (url) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res([i.naturalWidth, i.naturalHeight]);
          i.onerror = () => rej(new Error('the picture did not load'));
          i.src = url;
        }),
      `/api/streamers/${NAME}/offline?v=${offlineVersion}`
    );
    expect(size[0] === 1280 && size[1] === 720, `the picture is ${size.join('x')}`);
    return `${bytes.length} bytes, ${size.join('x')}`;
  });

  await step('the crop dialog: the box at twice the zoom, dragged into the top left corner, goes up as that part and not the middle', async () => {
    const p = profile;
    await p.setInputFiles('#profile-offline-file', { name: 'banner.png', mimeType: 'image/png', buffer: PNG });
    await p.waitForSelector('#crop[open] #crop-box', { timeout: 10000 });
    // the slider to 2×: the box is half as tall as the picture (500 of 1000, so 889 of 2000 wide). through the native setter, so react sees the input
    await p.$eval('#crop-zoom', (el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // dragged far past the top left: it stops in the corner
    const box = await (await p.$('#crop-box')).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2 - 1500, box.y + box.height / 2 - 1500, { steps: 8 });
    await p.mouse.up();
    const after = await (await p.$('#crop-box')).boundingBox();
    const picture = await p.$eval('#crop-box', (el) => el.parentElement.getBoundingClientRect().toJSON());
    expect(Math.abs(after.x - picture.x) < 2 && Math.abs(after.y - picture.y) < 2, `the box sits ${(after.x - picture.x).toFixed(0)},${(after.y - picture.y).toFixed(0)} from the picture's corner`);
    expect(Math.abs(after.height / picture.height - 0.5) < 0.03, `the box is ${(after.height / picture.height).toFixed(2)} of the picture tall, not half`);
    await p.click('#crop-use');
    // the version is in seconds and this save can land in the same one as the last: new bytes, not a new number, say it arrived
    let bytes = offlineBytes;
    for (let i = 0; i < 50 && bytes.equals(offlineBytes); i++) {
      await sleep(300);
      bytes = await (await anon.get(`/api/streamers/${NAME}/offline?v=${Date.now()}`)).body();
    }
    expect(!bytes.equals(offlineBytes), 'the offline picture did not change');
    expect(bytes.length <= 512 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8, `${bytes.length} bytes, not a jpeg under 512 kb`);
    // the gradient runs orange at the top left to blue at the bottom right. the middle cut ends deep in the blue;
    // the top left quarter ends near the picture's centre, still more orange than blue
    const middle = await cornerOf(p, offlineBytes);
    const corner = await cornerOf(p, bytes);
    expect(middle.b > middle.r + 100, `the middle cut's far corner is rgb(${middle.r},${middle.g},${middle.b}), not blue`);
    expect(corner.r > corner.b, `the top left cut's far corner is rgb(${corner.r},${corner.g},${corner.b}), not warmer than blue`);
    offlineBytes = bytes;
    await p.close();
    return `middle ends rgb(${middle.r},${middle.g},${middle.b}), the corner rgb(${corner.r},${corner.g},${corner.b})`;
  });

  await step("a claimed name's pictures and line: anonymous 403, the owner 200", async () => {
    const CLAIMED = 'pvacct' + RUN;
    const signup = await owner.post('/api/signup', { data: { name: CLAIMED, password: 'correct horse battery' } });
    expect(signup.status() === 201, `signup got ${signup.status()}`);
    const no = await put(anon, CLAIMED, JPEG);
    expect(no.status() === 403, `anonymous got ${no.status()}`);
    const yes = await put(owner, CLAIMED, JPEG);
    expect(yes.status() === 200, `owner got ${yes.status()}`);
    const del = await anon.delete(`/api/streamers/${CLAIMED}/avatar`);
    expect(del.status() === 403, `anonymous delete got ${del.status()}`);
    const noOffline = await putOffline(anon, CLAIMED, JPEG);
    const noNote = await putNote(anon, CLAIMED, 'not mine');
    const noOfflineDel = await anon.delete(`/api/streamers/${CLAIMED}/offline`);
    expect(noOffline.status() === 403 && noNote.status() === 403 && noOfflineDel.status() === 403, `anonymous offline picture ${noOffline.status()}, line ${noNote.status()}, delete ${noOfflineDel.status()}`);
    const yesOffline = await putOffline(owner, CLAIMED, JPEG);
    const yesNote = await putNote(owner, CLAIMED, 'mine');
    expect(yesOffline.status() === 200 && yesNote.status() === 200, `owner offline picture ${yesOffline.status()}, line ${yesNote.status()}`);
    await owner.post('/api/logout');
    return `${CLAIMED}`;
  });

  let publisher;
  await step('live: the share link has ?s=<session>', async () => {
    publisher = await fresh();
    // no name box on /live: a guest streams as the nick in the corner panel (localstorage, json the way jotai keeps it)
    await publisher.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), NAME);
    await publisher.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await publisher.waitForFunction(() => !document.querySelector('#start').disabled);
    await publisher.click('#start');
    await waitStatus(publisher, /^live$/);
    const href = await publisher.getAttribute('#watchurl', 'href');
    expect(new RegExp(`/watch/${NAME}\\?s=\\d+$`).test(href), `link ${href}`);
    return href.replace(BASE, '');
  });

  await step('live: og:title says live, og:image is the thumbnail once there is one (<= 15s), not the offline picture', async () => {
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
    // the word beside the name is the presence word (docs/status.md): `streaming`, the title alone says live
    expect(html.includes('>streaming</p>'), 'the card does not say streaming');
    expect(hasCard(html) && !html.includes('background-image:url('), 'the player box wears the offline picture while live');
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

  await step('remove the offline picture: 204, then 404, the card is the face again; an empty line clears it', async () => {
    const del = await anon.delete(`/api/streamers/${NAME}/offline`);
    expect(del.status() === 204, `delete got ${del.status()}`);
    const gone = await anon.get(`/api/streamers/${NAME}/offline?v=${offlineVersion}`);
    expect(gone.status() === 404, `get after delete got ${gone.status()}`);
    const cleared = await (await putNote(anon, NAME, '   ')).json();
    expect(cleared.offline_note === '', `the cleared line is ${JSON.stringify(cleared)}`);
    const html = await (await anon.get(`/watch/${NAME}`)).text();
    expect((meta(html, 'og:image') || '').endsWith(`/api/streamers/${NAME}/avatar?v=${version}`), `og:image ${meta(html, 'og:image')}`);
    expect(meta(html, 'twitter:card') === 'summary', `twitter:card ${meta(html, 'twitter:card')}`);
    expect(hasCard(html) && !html.includes('background-image:url('), 'the player box still wears a picture');
    return 'the face again';
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
