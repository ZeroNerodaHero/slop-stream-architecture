// Picture in picture for the broadcast: leaving the go live page with a stream up keeps it. A
// plain home click, no button, lands with your stream in a corner of every other page
// (#live-pip-player: your camera, the status word `live`, how many are watching) while watchers
// keep getting frames, with no stop call and the name still listed; you can open another
// stream's page and watch it with your own still going; the corner's chat is your own room with
// your lines marked; coming back takes the stream over (one go-live in total); the page's
// button is the same home click; one corner at a time: while yours is there, picture in picture
// on another stream's page is disabled and says so, and works again once yours is closed; × ends
// it; leaving with nothing on air (stopped on the page) puts nothing in the corner; a tab closed
// with the stream in the corner ends it too (the tab-close listener outlives the page); and
// start with someone else's stream in the corner ends that one (their player goes, their count
// drops). Two publishers with fake cameras and one watcher.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node live-pip.js
const { chromium } = require('playwright');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const ME = 'livepip';
const OTHER = 'livepip2';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    results.push('pass');
    console.log(`PASS  ${name.padEnd(78)} ${ms()} ms  ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${name.padEnd(78)} ${ms()} ms\n      ${e.message}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (p, sel) => p.textContent(sel).then((t) => (t || '').trim());
const waitText = (p, sel, re, timeout = 20000) =>
  p.waitForFunction(([s, src]) => new RegExp(src, 'i').test(document.querySelector(s)?.textContent || ''), [sel, re.source], { timeout });
const waitStatus = (p, re, timeout = 20000) => waitText(p, '#status', re, timeout);
// frames decoded into a <video>, so "playing" means pictures, not just a src
const frames = (p, sel) => p.$eval(sel, (v) => ({ w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, muted: v.muted }));
async function framesFlow(p, sel) {
  const a = await frames(p, sel);
  await sleep(1500);
  const b = await frames(p, sel);
  expect(b.w > 0 && b.frames > a.frames, `${sel}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return `${sel} ${b.w}px wide, ${b.frames - a.frames} frames in 1.5s${b.muted ? ', muted' : ''}`;
}
const rect = (p, sel) => p.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
// the mic meter's level over 1.5s. the fake mic beeps every half second, so the bar jumps and falls back between beeps
async function micMoves(p, sel) {
  const levels = await p.$eval(sel, async (el) => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      out.push(Number(el.getAttribute('aria-valuenow')));
      await new Promise((r) => setTimeout(r, 25));
    }
    return out;
  });
  const peak = Math.max(...levels);
  expect(peak > 0 && new Set(levels).size > 3, `${sel} does not move: ${levels.join(',')}`);
  return `${sel} peaks at ${peak}%`;
}
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
const listed = async (p, name) => (await p.evaluate(() => fetch('/api/streams').then((r) => r.json()))).some((s) => s.name === name);
const waitListed = async (p, name, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await listed(p, name)) return;
    await sleep(500);
  }
  throw new Error(`${name} is not listed on /api/streams after ${timeout}ms`);
};
const waitUnlisted = async (p, name, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (!(await listed(p, name))) return;
    await sleep(500);
  }
  throw new Error(`${name} is still listed on /api/streams after ${timeout}ms`);
};

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const newStreamer = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
    return ctx.newPage();
  };
  const goLive = async (p, name) => {
    await p.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await p.fill('#name', name);
    await p.waitForFunction(() => !document.querySelector('#start').disabled);
    await p.click('#start');
    await waitStatus(p, /^live$/);
  };

  const other = await newStreamer();
  await step(`${OTHER} goes live: the other stream, to watch while streaming`, async () => {
    await goLive(other, OTHER);
    return 'live';
  });

  const s = await newStreamer();
  // every go-live and stop the streamer's tab makes for ME: taking the stream back must not add a go-live
  const calls = { goLive: 0, stop: 0 };
  s.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().includes(`/api/streams/${ME}/go-live`)) calls.goLive++;
    if (r.url().includes(`/api/streams/${ME}/stop`)) calls.stop++;
  });

  await step(`${ME} goes live; the picture in picture button is on the preview only once live`, async () => {
    await s.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await s.fill('#name', ME);
    await s.waitForFunction(() => !document.querySelector('#start').disabled);
    expect((await s.$('#live-pip')) === null, 'the picture in picture button is up before start');
    expect((await s.$('#live-mic')) === null, 'the mic meter is up before start');
    await s.click('#start');
    await waitStatus(s, /^live$/);
    await s.waitForSelector('#live-pip', { timeout: 5000 });
    expect((await s.$('#live-pip-player')) === null, "the corner player showed on the stream's own page");
    return `${calls.goLive} go-live call`;
  });

  await step("the preview's top left is the mic meter, and its bar moves with the mic", async () => {
    await s.waitForSelector('#live-mic[data-mic="on"]', { timeout: 5000 });
    const mic = await rect(s, '#live-mic');
    const preview = await rect(s, '#preview');
    expect(near(mic.left, preview.left + 12) && near(mic.top, preview.top + 12), `the meter is at ${at(mic)} on a preview at ${at(preview)}`);
    return await micMoves(s, '#live-mic');
  });

  const w = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  let box;
  await step('a plain home click, no button: home, with your stream in the bottom right corner saying live, the camera playing; no stop call, still listed', async () => {
    await s.click('header a[href="/"]');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    await waitText(s, '#live-pip-status', /^live$/, 10000);
    const name = await text(s, '#live-pip-player a.font-semibold');
    expect(name === ME, `the player names "${name}"`);
    expect((await s.$('#pip-player')) === null, 'a watch player showed with nothing being watched');
    expect(calls.stop === 0, `${calls.stop} stop calls: leaving the page stopped the stream`);
    await waitListed(s, ME);
    box = await rect(s, '#live-pip-player');
    const view = await s.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(near(box.right, view.w - 24) && near(box.bottom, view.h - 24), `not in the corner: ${at(box)} in ${view.w}×${view.h}`);
    const v = await frames(s, '#live-pip-video');
    expect(v.muted, 'your own camera is not muted in the corner');
    return `${at(box)} · ${await framesFlow(s, '#live-pip-video')}`;
  });

  await step('the corner has the mic meter too, top left, moving', async () => {
    await s.waitForSelector('#live-pip-mic[data-mic="on"]', { timeout: 5000 });
    const mic = await rect(s, '#live-pip-mic');
    const video = await rect(s, '#live-pip-video');
    expect(near(mic.left, video.left + 12) && mic.top >= video.top + 8 && mic.top < video.top + 20, `the meter is at ${at(mic)} on a picture at ${at(video)}`);
    return await micMoves(s, '#live-pip-mic');
  });

  await step(`the stream survived leaving the page: a watcher at /watch/${ME} gets frames, and the corner counts them`, async () => {
    await w.goto(`${BASE}/watch/${ME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    const flow = await framesFlow(w, '#video');
    await s.waitForSelector('#live-pip-viewers[data-viewers]', { timeout: 15000 });
    const viewers = Number(await s.getAttribute('#live-pip-viewers', 'data-viewers'));
    expect(viewers >= 1, `the corner says ${viewers} watching`);
    expect(calls.goLive === 1 && calls.stop === 0, `go-live ${calls.goLive}, stop ${calls.stop}`);
    return `${flow} · "${await text(s, '#live-pip-viewers')}"`;
  });

  await step(`watching different stuff while live: ${OTHER}'s page plays, the corner stays, its chat button yields to the page's chat; the page's picture in picture is disabled: one corner at a time`, async () => {
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    const page = await framesFlow(s, '#video');
    expect((await s.$('#live-pip-player')) !== null, "the corner player is gone on another stream's page");
    expect(/^live$/i.test(await text(s, '#live-pip-status')), `the corner says "${await text(s, '#live-pip-status')}"`);
    expect(await s.$eval('#live-pip-chat', (b) => b.disabled), 'the corner chat button is not disabled on a page with its own chat');
    // your stream has the corner: theirs cannot go there too, and the button says why
    const label = await s.getAttribute('#pip', 'aria-label');
    expect(await s.$eval('#pip', (b) => b.disabled), 'the picture in picture button is enabled with your own stream in the corner');
    expect(label === 'your stream is in the corner', `the button is named "${label}"`);
    const corner = await framesFlow(s, '#live-pip-video');
    const theirs = await framesFlow(w, '#video');
    return `${page} · ${corner} · watcher still gets ${theirs} · "${label}"`;
  });

  await step("home: the corner's chat opens your own room, no nick needed, and your line reaches a watcher marked as the streamer's", async () => {
    await s.click('header a[href="/"]');
    await s.waitForSelector('#list article', { timeout: 10000 });
    await s.click('#live-pip-chat');
    await s.waitForSelector('#live-pip-player #chat', { timeout: 5000 });
    expect((await s.getAttribute('#live-pip-chat', 'aria-pressed')) === 'true', 'the chat button is not pressed');
    await s.waitForSelector('#live-pip-player #chat-text', { timeout: 10000 });
    expect((await s.$('#live-pip-player #chat-nick')) === null, 'the streamer was asked for a nick in their own room');
    await s.waitForSelector('#live-pip-player #chat[data-phase="open"]', { timeout: 10000 });
    // the watcher joins the room, then hears the line
    await w.fill('#chat-nick', 'lpviewer');
    await w.click('#chat-join');
    await waitText(w, '#chat-count', /live/, 10000);
    const line = `hi from the corner ${Date.now()}`;
    await s.fill('#live-pip-player #chat-text', line);
    await s.click('#live-pip-player #chat-send');
    await w.waitForFunction((t) => [...document.querySelectorAll('#chat-lines p[data-streamer="true"]')].some((p) => p.textContent.includes(t)), line, { timeout: 10000 });
    await s.click('#live-pip-chat');
    await s.waitForSelector('#live-pip-player #chat', { state: 'detached', timeout: 5000 });
    return `"${line}" marked streamer on the watcher's page`;
  });

  await step('click the corner: back on the page, the same stream is taken over (no second go-live), the preview and the watcher keep playing', async () => {
    await s.click('#live-pip-player a.font-semibold');
    await s.waitForURL('**/live', { timeout: 10000 });
    await waitStatus(s, /^live$/, 10000);
    expect((await s.$('#live-pip-player')) === null, "the corner player is still there on the stream's own page");
    expect((await s.$('#stop')) !== null, 'no stop button');
    expect(calls.goLive === 1, `go-live was called again (${calls.goLive} in total)`);
    const preview = await framesFlow(s, '#preview');
    const theirs = await framesFlow(w, '#video');
    return `${preview} · watcher ${theirs}`;
  });

  await step(`the page's button is the same home click: your stream in the corner, alone (${OTHER}'s page cannot add theirs)`, async () => {
    await s.click('#live-pip');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    expect(calls.goLive === 1 && calls.stop === 0, `go-live ${calls.goLive}, stop ${calls.stop}`);
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    expect(await s.$eval('#pip', (b) => b.disabled), 'the picture in picture button is enabled with your own stream in the corner');
    await s.click('header a[href="/"]');
    await s.waitForSelector('#list article', { timeout: 10000 });
    await sleep(300);
    expect((await s.$('#pip-player')) === null, 'a watched player showed beside yours');
    const mine = await rect(s, '#live-pip-player');
    const view = await s.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(near(mine.right, view.w - 24) && near(mine.bottom, view.h - 24), `your own is not at the corner: ${at(mine)}`);
    box = mine;
    return `mine ${at(mine)} · ${await framesFlow(s, '#live-pip-video')}`;
  });

  await step('drag your own player away: it follows, leaves the stack, and the drop is not a click back to the page', async () => {
    box = await rect(s, '#live-pip-player');
    await drag(s, '#live-pip-video', -300, -200);
    const b = await rect(s, '#live-pip-player');
    expect(near(b.left, box.left - 300) && near(b.top, box.top - 200), `${at(box)} -> ${at(b)}`);
    expect(new URL(s.url()).pathname === '/', `went to ${new URL(s.url()).pathname}`);
    return `${at(box)} -> ${at(b)}`;
  });

  await step('× on your player asks first: "no" (and escape) keep streaming, nothing stopped, the player stays', async () => {
    await s.click('#live-pip-close');
    await s.waitForSelector('#live-pip-confirm[open]', { timeout: 5000 });
    const words = await text(s, '#live-pip-confirm-message');
    expect(/stop the stream/i.test(words), `the question says "${words}"`);
    expect(await s.evaluate(() => document.activeElement?.id === 'live-pip-confirm-no'), `focus is on #${await s.evaluate(() => document.activeElement?.id)}, not on no`);
    await s.click('#live-pip-confirm-no');
    await s.waitForSelector('#live-pip-confirm', { state: 'detached', timeout: 5000 });
    expect((await s.$('#live-pip-player')) !== null, 'the player went on a no');
    // escape is a no too
    await s.click('#live-pip-close');
    await s.waitForSelector('#live-pip-confirm[open]', { timeout: 5000 });
    await s.keyboard.press('Escape');
    await s.waitForSelector('#live-pip-confirm', { state: 'detached', timeout: 5000 });
    await sleep(300);
    expect((await s.$('#live-pip-player')) !== null, 'the player went on escape');
    expect(calls.stop === 0, `${calls.stop} stop calls: a no stopped the stream`);
    expect(/^live$/i.test(await text(s, '#live-pip-status')), `the corner says "${await text(s, '#live-pip-status')}"`);
    return `"${words}" · still live, ${await framesFlow(w, '#video')}`;
  });

  await step(`× then "yes, stop": it goes, the watcher sees ended, one stop call, ${ME} unlisted; and the corner is free: ${OTHER}'s page offers picture in picture again, and it works`, async () => {
    await s.click('#live-pip-close');
    await s.waitForSelector('#live-pip-confirm[open]', { timeout: 5000 });
    await s.click('#live-pip-confirm-yes');
    await s.waitForSelector('#live-pip-player', { state: 'detached', timeout: 5000 });
    await waitStatus(w, /ended/, 15000);
    expect(calls.stop === 1, `${calls.stop} stop calls in total`);
    await waitUnlisted(s, ME);
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    const label = await s.getAttribute('#pip', 'aria-label');
    expect(!(await s.$eval('#pip', (b) => b.disabled)) && label === 'picture in picture', `the button is still off with the corner free (named "${label}")`);
    await s.click('#pip');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#pip-player', { timeout: 10000 });
    await waitText(s, '#pip-status', /^(\d+ )?watching$/, 10000);
    await s.click('#pip-close');
    await s.waitForSelector('#pip-player', { state: 'detached', timeout: 5000 });
    return `ended, unlisted; then ${OTHER} in the corner, and closed`;
  });

  await step('stop on the page, then home: nothing on air, so nothing in the corner, and leaving adds no second stop call', async () => {
    await goLive(s, ME);
    await s.click('#stop');
    await waitStatus(s, /^stopped$/);
    await s.click('header a[href="/"]');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await sleep(300);
    expect((await s.$('#live-pip-player')) === null, 'the corner player showed with nothing on air');
    expect(calls.stop === 2, `${calls.stop} stop calls in total: one for the button, none for leaving`);
    await waitUnlisted(s, ME);
    return 'nothing in the corner, unlisted';
  });

  await step('live once more, a plain home click keeps it in the corner, then the document is left: the stream ends at once (the tab-close stop outlived the page) and the new load starts clean', async () => {
    await goLive(s, ME);
    await s.click('header a[href="/"]');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    await w.goto(`${BASE}/watch/${ME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    // a full load, not a route change: pagehide fires, as it does for a closed tab
    await s.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /ended/, 15000);
    await waitUnlisted(w, ME, 6000); // the beacon told the api; video's own stop call would take longer
    await s.waitForSelector('#list article, #empty', { timeout: 10000 }).catch(() => undefined);
    expect((await s.$('#live-pip-player')) === null, 'the corner player showed after a page load');
    return 'ended and unlisted within 6s; nothing in the corner after the load';
  });

  await step(`${OTHER} in picture in picture, then start on the go live page: your stream going up closes the watched player, and ${OTHER} counts 0 watching`, async () => {
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    await s.click('#pip');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#pip-player', { timeout: 10000 });
    // every page here is one address, so the one watching tab is "1 watching" on the streamer's page
    await other.waitForFunction(() => document.querySelector('#viewers')?.dataset.viewers === '1', null, { timeout: 15000 });
    // a route change, not a load: the watched player comes along to the go live page
    await s.click('#go-live');
    await s.waitForURL('**/live', { timeout: 10000 });
    expect((await s.$('#pip-player')) !== null, 'the watched player went before start');
    await s.fill('#name', ME);
    await s.waitForFunction(() => !document.querySelector('#start').disabled);
    await s.click('#start');
    await s.waitForSelector('#pip-player', { state: 'detached', timeout: 5000 });
    await waitStatus(s, /^live$/);
    // not hidden, ended: the streamer's count drops
    await other.waitForFunction(() => document.querySelector('#viewers')?.dataset.viewers === '0', null, { timeout: 15000 });
    expect((await s.$('#pip-player')) === null, 'the watched player came back');
    await s.click('#stop');
    await waitStatus(s, /^stopped$/);
    return `the watched player went on start; ${OTHER} counts "${await text(other, '#viewers')}"`;
  });

  await s.close();
  await other.click('#stop').catch(() => undefined);
  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
