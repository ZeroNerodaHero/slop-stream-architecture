// Picture in picture: with it on, leaving the watch page keeps the stream playing in a corner
// of every other page (#pip-player); coming back takes the same stream over without a second
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
const frames = (p, sel) => p.$eval(sel, (v) => ({ w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, muted: v.muted }));
async function framesFlow(p, sel) {
  const a = await frames(p, sel);
  await sleep(1500);
  const b = await frames(p, sel);
  expect(b.w > 0 && b.frames > a.frames, `${sel}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return `${b.w}px wide, ${b.frames - a.frames} frames in 1.5s${b.muted ? ', muted' : ', sound on'}`;
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

  await step(`watcher: /watch/${A} plays; sound on; the picture in picture button is there`, async () => {
    await w.goto(`${BASE}/watch/${A}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    await w.click('#unmute');
    const pressed = await w.getAttribute('#pip', 'aria-pressed');
    expect(pressed === 'false', `#pip aria-pressed ${pressed} before the click`);
    return await framesFlow(w, '#video');
  });

  await step('turn it on: the button says so', async () => {
    await w.click('#pip');
    expect((await w.getAttribute('#pip', 'aria-pressed')) === 'true', 'aria-pressed is not true');
    expect(/on/.test(await w.textContent('#pip')), `button reads "${await w.textContent('#pip')}"`);
    expect((await w.$('#pip-player')) === null, 'the corner player showed on the stream\'s own page');
    return `"${(await w.textContent('#pip')).trim()}"`;
  });

  await step('go home: the stream keeps playing in the corner, with its name and status', async () => {
    await w.click('header a[href="/"]');
    await w.waitForSelector('#pip-player', { timeout: 10000 });
    await w.waitForSelector('#list article', { timeout: 10000 });
    await w.waitForFunction(() => /^watching$/i.test(document.querySelector('#pip-status')?.textContent || ''), null, { timeout: 10000 });
    const name = (await w.textContent('#pip-player a.font-semibold')).trim();
    expect(name === A, `player names "${name}"`);
    const tap = await w.$('#pip-unmute');
    const flow = await framesFlow(w, '#pip-video');
    return `${flow}${tap ? ` · the player offers "${(await tap.textContent()).trim()}"` : ''}`;
  });

  await step('click the player: back on the page, the same stream is taken over (no second /watch call)', async () => {
    const before = watchCalls[A];
    await w.click('#pip-player a.font-semibold');
    await w.waitForURL(`**/watch/${A}`, { timeout: 10000 });
    await waitStatus(w, /^watching$/, 10000);
    expect((await w.$('#pip-player')) === null, 'the corner player is still there on the stream\'s own page');
    expect((await w.getAttribute('#pip', 'aria-pressed')) === 'true', 'picture in picture turned itself off');
    await framesFlow(w, '#video');
    expect(watchCalls[A] === before, `/watch was called again (${before} -> ${watchCalls[A]})`);
    return `${watchCalls[A]} watch call in total for ${A}`;
  });

  await step(`home, then ${B}'s card: the new stream replaces the old one, picture in picture stays on`, async () => {
    await w.click('header a[href="/"]');
    await w.waitForSelector('#pip-player', { timeout: 10000 });
    await w.click(`#list a[aria-label="watch ${B}"]`);
    await w.waitForURL(`**/watch/${B}`, { timeout: 10000 });
    await waitStatus(w, /^watching$/);
    expect((await w.$('#pip-player')) === null, `the corner player is still there on ${B}'s own page`);
    expect((await w.getAttribute('#pip', 'aria-pressed')) === 'true', 'picture in picture turned itself off on the switch');
    expect(watchCalls[B] === 1, `${watchCalls[B]} watch calls for ${B}`);
    return await framesFlow(w, '#video');
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

  await step(`back to /watch/${A} after the close: a fresh start, button off`, async () => {
    await w.goto(`${BASE}/watch/${A}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    expect((await w.getAttribute('#pip', 'aria-pressed')) === 'false', 'picture in picture is on after a page load');
    return await status(w);
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
