// The about tab (docs/about.md): the about me first (a few paragraphs, through the api on a free
// name, first on the tab for a watcher, and written in place by the owner, the box opening where
// the words are), then the page of their own under the player, drawn from blocks. The sample
// document's blocks are on the page (a heading, a picture, a clip, the music player, links) and
// its media comes from this origin; the player plays on a press and pauses on the next; the
// sample's own sheet stays under the box's id. Run through ./scripts/test.sh, or:
// BASE_URL=https://<ip> node about.js
const { chromium, request } = require('playwright');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
/** a free name, nobody's, not live: the page is the profile and the tabs, and its about me is anyone's to write */
const NAME = 'ab1';
const BOX = `#about-${NAME}`;
/** the about me this suite writes: through the api (two paragraphs, kept), then in the box on the page */
const ABOUT_API = 'written through the api.\n\ntwo paragraphs, kept.';
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
(async () => {
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  await step(`preflight: ${NAME} is not live, and nobody's`, async () => {
    const who = await (await api.get(`/api/streamers/${NAME}`)).json();
    expect(who && who.presence !== 'streaming', `${NAME} is ${who && who.presence}; is another run going?`);
    expect(who.verified !== true, `${NAME} has an account on this box: this suite writes its about me as nobody`);
  });

  await step('about me through the api: a free name is anyone\'s, the ends are trimmed and paragraphs stay, the profile read and the watch grant both carry it', async () => {
    const clear = await api.put(`/api/streamers/${NAME}/about`, { data: { about: '' } });
    expect(clear.status() === 200, `clearing got ${clear.status()}`);
    const res = await api.put(`/api/streamers/${NAME}/about`, { data: { about: `  ${ABOUT_API}\n\n\n\n` } });
    const saved = await res.json();
    expect(res.status() === 200 && saved.about === ABOUT_API, `the put got ${res.status()}: ${JSON.stringify(saved)}`);
    const read = await (await api.get(`/api/streamers/${NAME}`)).json();
    expect(read.about === ABOUT_API, `the profile read says ${JSON.stringify(read.about)}`);
    const grant = await (await api.post(`/api/streams/${NAME}/watch`)).json();
    expect(grant.about === ABOUT_API, `the watch grant says ${JSON.stringify(grant.about)}`);
    const bad = await api.put(`/api/streamers/${NAME}/about`, { data: { words: 'x' } });
    expect(bad.status() === 400, `a body with no about got ${bad.status()}`);
    return 'cleared, written, read back on both';
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

  await step('the about tab has no about-me paragraph; the status is the one line under the name', async () => {
    expect((await page.$$('#about-me, #about-me-edit, #about-me-editor')).length === 0, 'the about me box is still on the tab');
    return 'no about me on the tab';
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

  await step('the sample css is on the page with every selector under the box', async () => {
    const selectors = await selectorsOf(page);
    expect(selectors.length > 0, 'no style in the box');
    const loose = selectors.filter((s) => !s.split(',').every((part) => part.trim().startsWith(BOX)));
    expect(loose.length === 0, `selectors outside the box: ${JSON.stringify(loose)}`);
    expect((await page.$$(`#about-${NAME}-css`)).length === 0, 'the css box is still on the page');
    const color = await page.$eval(`${BOX} .about-text`, (el) => getComputedStyle(el).color);
    expect(color === 'rgb(154, 163, 178)', `.about-text is ${color}, the sample css did not land`);
    return `${selectors.length} rule(s)`;
  });

  await step('the calendar tab and back: the player is silent', async () => {
    await page.click('#tab-calendar');
    await page.waitForSelector('#calendar', { timeout: 10000 });
    expect((await page.$$(BOX)).length === 0, 'the box is still on the page under the calendar tab');
    await page.click('#tab-about');
    await page.waitForSelector(`${BOX} .about-heading`, { timeout: 10000 });
    const playing = (await page.$$(`${BOX} .about-music[data-playing]`)).length;
    expect(playing === 0, 'the player came back playing');
  });

  await step(`as ${NAME}: the about tab still has no about-me box`, async () => {
    await page.hover('#user-panel');
    await page.waitForSelector('#username', { timeout: 15000 });
    await page.fill('#username', NAME);
    await page.press('#username', 'Enter');
    await page.mouse.move(1200, 360);
    await page.waitForSelector('#user-panel[data-open="false"]', { timeout: 10000 });
    expect((await page.$$('#about-me, #about-me-edit, #about-me-editor')).length === 0, 'the about me box is on my page');
    const clear = await api.put(`/api/streamers/${NAME}/about`, { data: { about: '' } });
    expect(clear.status() === 200, `clearing got ${clear.status()}`);
    return 'no about me, about cleared';
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
