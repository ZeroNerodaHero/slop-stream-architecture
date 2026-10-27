// The about tab (docs/about.md): the page of their own under the player, drawn from blocks, with
// css of their own over it that cannot leave the box. The sample document's blocks are on the
// page (a heading, a picture, a clip, the music player, links) and its media comes from this
// origin; the player plays on a press and pauses on the next; every selector of the css ends up
// under the box's id; css that tries to hide the page, restyle the title, load a picture or a
// font from elsewhere, import a sheet, pin itself over the page, or close the style tag is
// stripped, with nothing fetched and nothing outside the box touched; a selector list with
// `body` in it does not reach the body. Run through ./scripts/test.sh, or:
// BASE_URL=https://<ip> node about.js
const { chromium, request } = require('playwright');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
/** a free name, nobody's, not live: the page is the profile and the tabs */
const NAME = 'ab1';
const BOX = `#about-${NAME}`;
const EDITOR = `#about-${NAME}-css`;
const ARGS = ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'];
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
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

/** the sanitizer runs 150ms after the last keystroke; a fill is one change */
const typeCss = async (page, css) => {
  await page.fill(EDITOR, css);
  await sleep(600);
};
/** every selector of the box's <style>, media and supports rules walked into */
const selectorsOf = (page) =>
  page.evaluate((box) => {
    const style = document.querySelector(`${box} style`);
    if (!style || !style.sheet) return [];
    const out = [];
    const walk = (rules) => {
      for (const r of rules) {
        if (r.selectorText !== undefined) out.push(r.selectorText);
        if (r.cssRules) walk(r.cssRules);
      }
    };
    walk(style.sheet.cssRules);
    return out;
  }, BOX);
const styleText = (page) => page.evaluate((box) => document.querySelector(`${box} style`)?.textContent ?? '', BOX);

(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  // nothing the page does may reach another host: a sample's css or a document's media loading from
  // elsewhere would hand the viewer's address to whoever put it there
  const elsewhere = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) elsewhere.push(r.url());
  });

  await step(`preflight: ${NAME} is not live`, async () => {
    const who = await (await api.get(`/api/streamers/${NAME}`)).json();
    expect(who && who.presence !== 'streaming', `${NAME} is ${who && who.presence}; is another run going?`);
  });

  await step(`/watch/${NAME}: the about tab is open by default and the sample's blocks are on the page`, async () => {
    await page.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 15000 });
    await page.waitForSelector(`${BOX} .about-heading`, { timeout: 10000 });
    const kinds = ['.about-heading', '.about-text', '.about-image img', '.about-video video', '.about-music', '.about-links a'];
    for (const k of kinds) expect((await page.$$(`${BOX} ${k}`)).length > 0, `no ${k} in the box`);
    const heading = (await page.textContent(`${BOX} .about-heading`)).trim();
    expect(heading === `about ${NAME}`, `the heading reads "${heading}"`);
    const img = await page.getAttribute(`${BOX} .about-image img`, 'src');
    const clip = await page.getAttribute(`${BOX} .about-video video`, 'src');
    expect(img.startsWith('/about-demo/') || img.startsWith('/api/streamers/'), `the picture comes from ${img}`);
    expect(clip.startsWith('/about-demo/'), `the clip comes from ${clip}`);
    const links = await page.$$eval(`${BOX} .about-links a`, (as) => as.map((a) => a.getAttribute('href')));
    expect(links.every((h) => h.startsWith('/') || h.startsWith(BASE)), `a link goes to ${JSON.stringify(links)}`);
    return `${kinds.length} kinds of block, picture ${img}`;
  });

  await step('the sample media is served from this origin with its own types', async () => {
    const want = { '/about-demo/clip.mp4': /video\/mp4/, '/about-demo/track-1.mp3': /audio\/mpeg/, '/about-demo/banner.jpg': /image\/jpeg/, '/about-demo/poster.jpg': /image\/jpeg/ };
    const got = [];
    for (const [path, type] of Object.entries(want)) {
      const res = await api.get(path);
      const ct = res.headers()['content-type'] || '';
      expect(res.status() === 200 && type.test(ct), `${path}: ${res.status()} ${ct}`);
      got.push(`${path.split('/').pop()} ${ct.split(';')[0]}`);
    }
    return got.join(', ');
  });

  await step('the music player plays on a press and pauses on the next; the next button moves to the second track', async () => {
    await page.click(`${BOX} .about-music-play`);
    await page.waitForSelector(`${BOX} .about-music[data-playing]`, { timeout: 10000 });
    const playing = await page.$eval(`${BOX} .about-music audio`, (el) => !el.paused);
    expect(playing, 'the audio element says paused while the player says playing');
    await page.click(`${BOX} .about-music-play`);
    await page.waitForSelector(`${BOX} .about-music[data-playing]`, { state: 'detached', timeout: 5000 });
    await page.click(`${BOX} .about-music button[aria-label="next track"]`);
    const now = (await page.textContent(`${BOX} .about-music-now`)).trim();
    const current = await page.$$eval(`${BOX} .about-music-track[aria-current="true"]`, (els) => els.map((e) => e.textContent.trim()));
    expect(current.length === 1 && current[0].startsWith('2.'), `the current track is ${JSON.stringify(current)}`);
    return `played, paused, then "${now}"`;
  });

  await step('the sample css is on the page with every selector under the box, and the note counts it', async () => {
    const selectors = await selectorsOf(page);
    expect(selectors.length > 0, 'no style in the box');
    const loose = selectors.filter((s) => !s.split(',').every((part) => part.trim().startsWith(BOX)));
    expect(loose.length === 0, `selectors outside the box: ${JSON.stringify(loose)}`);
    const note = (await page.textContent(`${EDITOR}-note`)).trim();
    expect(/^\d+ declarations? on · 0 dropped/.test(note), `the note reads "${note}"`);
    const color = await page.$eval(`${BOX} .about-text`, (el) => getComputedStyle(el).color);
    expect(color === 'rgb(154, 163, 178)', `.about-text is ${color}, the sample css did not land`);
    return `${selectors.length} rule(s), ${note}`;
  });

  await step('hostile css: the page stays, the title stays, nothing loads from elsewhere, fixed is not fixed, the tag is not closed', async () => {
    const title = await page.$eval('#who', (el) => getComputedStyle(el).color);
    const before = elsewhere.length;
    await typeCss(
      page,
      [
        'body { display: none !important; }',
        '#who, h1 { color: rgb(255, 0, 0) !important; }',
        'html, :root { filter: blur(10px); }',
        '@import url(https://evil.example/e.css);',
        "@font-face { font-family: x; src: url('https://evil.example/f.woff'); }",
        '.about-heading { background: url(https://evil.example/x.png); color: rgb(1, 2, 3); position: fixed; inset: 0; }',
        '.about-image img { cursor: url(https://evil.example/c.cur), auto; -webkit-mask: url(https://evil.example/m.svg); }',
        '.about-text::after { content: "</style><img src=x onerror=alert(1)>"; }',
        '.about-text { background-image: image-set("https://evil.example/i.png" 1x); behavior: url(x.htc); }',
        '.about-links a { -moz-binding: url(https://evil.example/b.xml); color: rgb(4, 5, 6); }'
      ].join('\n')
    );
    const bodyShown = await page.evaluate(() => getComputedStyle(document.body).display !== 'none');
    expect(bodyShown, 'the body is display: none');
    const titleNow = await page.$eval('#who', (el) => getComputedStyle(el).color);
    expect(titleNow === title && titleNow !== 'rgb(255, 0, 0)', `the title went from ${title} to ${titleNow}`);
    const heading = await page.$eval(`${BOX} .about-heading`, (el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundImage, position: s.position };
    });
    expect(heading.color === 'rgb(1, 2, 3)', `the allowed colour did not land: ${heading.color}`);
    expect(heading.background === 'none', `the heading has a background image: ${heading.background}`);
    expect(heading.position !== 'fixed', 'the heading is position: fixed');
    // the heading, now absolute and inset 0, stays inside the box: the box is its containing block
    const inside = await page.evaluate((box) => {
      const b = document.querySelector(box).getBoundingClientRect();
      const h = document.querySelector(`${box} .about-heading`).getBoundingClientRect();
      return h.left >= b.left - 1 && h.right <= b.right + 1 && h.top >= b.top - 1 && h.bottom <= b.bottom + 1;
    }, BOX);
    expect(inside, 'the pinned heading reaches outside the box');
    const text = await styleText(page);
    for (const bad of ['url(', '@import', '@font-face', '</style', 'image-set', 'behavior', 'binding', 'evil.example']) {
      expect(!text.toLowerCase().includes(bad), `the style still has ${bad}`);
    }
    const linkColor = await page.$eval(`${BOX} .about-links a`, (el) => getComputedStyle(el).color);
    expect(linkColor === 'rgb(4, 5, 6)', `the links' allowed colour did not land: ${linkColor}`);
    await sleep(500);
    expect(elsewhere.length === before, `requests left for ${JSON.stringify(elsewhere.slice(before))}`);
    const note = (await page.textContent(`${EDITOR}-note`)).trim();
    // the font-face rule, the two background images, the cursor, the mask, the content: six at
    // least. `behavior` and `-moz-binding` never parse in chrome, and `@import` is thrown out by
    // the parser itself, so none of those is counted
    const dropped = Number((note.match(/(\d+) dropped/) || [])[1]);
    expect(dropped >= 5, `the note counts ${dropped} dropped: "${note}"`);
    return `${dropped} dropped, title ${titleNow}, nothing fetched elsewhere`;
  });

  await step('a selector list with body in it reaches only the box, and a media rule is kept under the box', async () => {
    await typeCss(page, '.about-text, body, html body > div { visibility: hidden; }\n@media (min-width: 1px) { .about-heading { letter-spacing: 3px; } }');
    const bodyShown = await page.evaluate(() => getComputedStyle(document.body).visibility === 'visible');
    expect(bodyShown, 'the body is hidden');
    const textHidden = await page.$eval(`${BOX} .about-text`, (el) => getComputedStyle(el).visibility === 'hidden');
    expect(textHidden, 'the in-box selector of the list did not land');
    const spaced = await page.$eval(`${BOX} .about-heading`, (el) => getComputedStyle(el).letterSpacing);
    expect(spaced === '3px', `the media rule did not land: letter-spacing ${spaced}`);
    const selectors = await selectorsOf(page);
    const loose = selectors.filter((s) => !s.split(',').every((part) => part.trim().startsWith(BOX)));
    expect(loose.length === 0, `selectors outside the box: ${JSON.stringify(loose)}`);
    return `${selectors.length} rule(s): ${selectors.join(' | ')}`;
  });

  await step('the calendar tab and back: the editor is fresh, the player is silent', async () => {
    await page.click('#tab-calendar');
    await page.waitForSelector('#calendar', { timeout: 10000 });
    expect((await page.$$(BOX)).length === 0, 'the box is still on the page under the calendar tab');
    await page.click('#tab-about');
    await page.waitForSelector(`${BOX} .about-heading`, { timeout: 10000 });
    const note = (await page.textContent(`${EDITOR}-note`)).trim();
    expect(/0 dropped/.test(note), `the editor came back with "${note}"`);
    const playing = (await page.$$(`${BOX} .about-music[data-playing]`)).length;
    expect(playing === 0, 'the player came back playing');
  });

  await browser.close();
  await api.dispose();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
