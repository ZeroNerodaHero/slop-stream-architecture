// Picture in picture: the button is a home click that keeps the stream, which then plays in a
// corner of every other page (#pip-player); the player drags anywhere and resizes from a
// corner, and stays where it was put; coming back takes the same stream over without a second
// /watch call; opening another stream's page replaces it and the player follows that one; the
// player's × ends it. Two publishers with fake cameras and one watcher.
// Run through ./test.sh, or: BASE_URL=https://<ip> node pip.js
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const A = 'piptest';
const B = 'piptest2';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
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
    console.log(`FAIL  ${name.padEnd(70)} ${ms()} ms\n      ${e.message}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (p) => p.textContent('#status').then((t) => t.trim());
const waitStatus = (p, re, timeout = 20000) => p.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#status')?.textContent || ''), re.source, { timeout });
// frames decoded into a <video>, so "playing" means pictures, not just a src
const frames = (p, sel) =>
  p.$eval(sel, (v) => ({ w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, muted: v.muted, volume: v.volume }));
async function framesFlow(p, sel) {
  const a = await frames(p, sel);
  await sleep(1500);
  const b = await frames(p, sel);
  expect(b.w > 0 && b.frames > a.frames, `${sel}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return `${b.w}px wide, ${b.frames - a.frames} frames in 1.5s${b.muted ? ', muted' : `, sound on at ${Math.round(b.volume * 100)}%`}`;
}
const rect = (p, sel) => p.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
const near = (a, b) => Math.abs(a - b) <= 1.5;
const at = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
// press in the middle of an element and pull it by (dx, dy)
async function drag(p, sel, dx, dy) {
  const r = await rect(p, sel);
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await p.mouse.move(x + dx, y + dy, { steps: 5 });
  await p.mouse.up();
  await sleep(100);
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const publish = async (name) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await p.fill('#name', name);
    await p.waitForFunction(() => !document.querySelector('#start').disabled);
    await p.click('#start');
    await waitStatus(p, /^live$/);
    return p;
  };
  const pubs = [];
  await step(`two publishers go live: ${A}, ${B}`, async () => {
    pubs.push(await publish(A), await publish(B));
    return 'both live';
  });

  const w = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  // every POST /api/streams/<name>/watch the watcher makes: taking a stream back must not add one
  const watchCalls = { [A]: 0, [B]: 0 };
  w.on('request', (r) => {
    const m = /\/api\/streams\/([^/]+)\/watch$/.exec(r.url());
    if (m && r.method() === 'POST') watchCalls[m[1]] = (watchCalls[m[1]] || 0) + 1;
  });

  await step(`watcher: /watch/${A} plays; unmute, the dial to the middle; the controls are on the video`, async () => {
    await w.goto(`${BASE}/watch/${A}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    await w.click('#unmute');
    expect((await w.textContent('#unmute')).trim() === 'mute', `the button reads "${await w.textContent('#unmute')}" with the sound on`);
    await w.click('#volume'); // the middle of the dial
    const v = await frames(w, '#video');
    expect(!v.muted && Math.abs(v.volume - 0.5) < 0.05, `after the dial: ${JSON.stringify(v)}`);
    const onVideo = await w.$$eval('#unmute, #volume, #pip', (els) => {
      const f = document.querySelector('#video').getBoundingClientRect();
      return els.every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= f.left && r.right <= f.right && r.top >= f.top && r.bottom <= f.bottom;
      });
    });
    expect(onVideo, 'a control is outside the video frame');
    expect((await w.$('#pip-player')) === null, 'the corner player showed on the stream\'s own page');
    return await framesFlow(w, '#video');
  });

  let box;
  await step('picture in picture: a home click that keeps the stream. it plays in the bottom right corner, with its name and status', async () => {
    await w.click('#pip');
    await w.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await w.waitForSelector('#pip-player', { timeout: 10000 });
    await w.waitForSelector('#list article', { timeout: 10000 });
    await w.waitForFunction(() => /^watching$/i.test(document.querySelector('#pip-status')?.textContent || ''), null, { timeout: 10000 });
    const name = (await w.textContent('#pip-player a.font-semibold')).trim();
    expect(name === A, `player names "${name}"`);
    const v = await frames(w, '#pip-video');
    expect(!v.muted && Math.abs(v.volume - 0.5) < 0.05, `the corner does not play at the page's level: ${JSON.stringify(v)}`);
    box = await rect(w, '#pip-player');
    const view = await w.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(near(box.right, view.w - 24) && near(box.bottom, view.h - 24), `not in the corner: ${at(box)} in ${view.w}×${view.h}`);
    const tap = await w.$('#pip-unmute');
    const flow = await framesFlow(w, '#pip-video');
    return `${at(box)} · ${flow}${tap ? ` · the player offers "${(await tap.textContent()).trim()}"` : ''}`;
  });

  await step('drag the player by its video: it follows, and the drop is not a click back to the page', async () => {
    await drag(w, '#pip-video', -300, -200);
    const b = await rect(w, '#pip-player');
    expect(near(b.left, box.left - 300) && near(b.top, box.top - 200), `${at(box)} -> ${at(b)}`);
    expect(near(b.width, box.width), `the width changed: ${box.width} -> ${b.width}`);
    expect(new URL(w.url()).pathname === '/', `went to ${new URL(w.url()).pathname}`);
    await drag(w, '#pip-status', -5000, -5000);
    const edge = await rect(w, '#pip-player');
    expect(near(edge.left, 0) && near(edge.top, 0), `pulled off the screen: ${at(edge)}`);
    box = edge;
    return `${at(b)}, then stopped at the edge: ${at(edge)}`;
  });

  await step('pull the bottom right corner: wider, still 16:9, the top left corner stays put, the frames keep coming', async () => {
    await drag(w, '#pip-resize-se', 240, 40);
    const b = await rect(w, '#pip-player');
    expect(near(b.width, box.width + 240), `width ${box.width} -> ${b.width}`);
    expect(near(b.left, box.left) && near(b.top, box.top), `the top left moved: ${at(box)} -> ${at(b)}`);
    const v = await rect(w, '#pip-video');
    expect(Math.abs((v.width * 9) / 16 - v.height) <= 2, `video ${v.width}×${v.height} is not 16:9`);
    box = b;
    return `${at(b)} · ${await framesFlow(w, '#pip-video')}`;
  });

  await step('click the player: back on the page, the same stream is taken over (no second /watch call)', async () => {
    const before = watchCalls[A];
    await w.click('#pip-player a.font-semibold');
    await w.waitForURL(`**/watch/${A}`, { timeout: 10000 });
    await waitStatus(w, /^watching$/, 10000);
    expect((await w.$('#pip-player')) === null, 'the corner player is still there on the stream\'s own page');
    await framesFlow(w, '#video');
    expect(watchCalls[A] === before, `/watch was called again (${before} -> ${watchCalls[A]})`);
    return `${watchCalls[A]} watch call in total for ${A}`;
  });

  await step(`home (the player is back where it was left), then ${B}'s card: the new stream replaces the old one, still in the corner`, async () => {
    await w.click('header a[href="/"]');
    await w.waitForSelector('#pip-player', { timeout: 10000 });
    const b = await rect(w, '#pip-player');
    expect(near(b.left, box.left) && near(b.top, box.top) && near(b.width, box.width), `the player moved: ${at(box)} -> ${at(b)}`);
    await w.click(`#list a[aria-label="watch ${B}"]`);
    await w.waitForURL(`**/watch/${B}`, { timeout: 10000 });
    await waitStatus(w, /^watching$/);
    expect((await w.$('#pip-player')) === null, `the corner player is still there on ${B}'s own page`);
    expect(watchCalls[B] === 1, `${watchCalls[B]} watch calls for ${B}`);
    return `${at(b)} · ${await framesFlow(w, '#video')}`;
  });

  await step(`home again: the corner now shows ${B}`, async () => {
    await w.click('header a[href="/"]');
    await w.waitForSelector('#pip-player', { timeout: 10000 });
    await w.waitForFunction(() => /^watching$/i.test(document.querySelector('#pip-status')?.textContent || ''), null, { timeout: 10000 });
    const name = (await w.textContent('#pip-player a.font-semibold')).trim();
    expect(name === B, `player names "${name}"`);
    return await framesFlow(w, '#pip-video');
  });

  await step('× on the player: gone, and nothing keeps asking the api about that stream', async () => {
    await w.click('#pip-close');
    await w.waitForSelector('#pip-player', { state: 'detached', timeout: 5000 });
    const before = watchCalls[B];
    await sleep(6000); // the not-live retry would ask every 5s if the session were still alive
    expect(watchCalls[B] === before, `/watch for ${B} was called after close (${before} -> ${watchCalls[B]})`);
    return 'no calls in 6s';
  });

  await step(`back to /watch/${A} after the close: a fresh start, picture in picture off, so a plain home click ends it`, async () => {
    await w.goto(`${BASE}/watch/${A}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    const word = await status(w);
    await w.click('header a[href="/"]');
    await w.waitForSelector('#list article', { timeout: 10000 });
    await sleep(500);
    expect((await w.$('#pip-player')) === null, 'the corner player showed after a page load turned picture in picture off');
    return `${word}, then home with no corner player`;
  });

  for (const p of pubs) await p.click('#stop').catch(() => undefined);
  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
