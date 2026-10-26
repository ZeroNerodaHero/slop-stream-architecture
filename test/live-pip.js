// Picture in picture for the broadcast: the go live page's button is a home click that keeps
// the stream, which then shows in a corner of every other page (#live-pip-player: your camera,
// the status word, how many are watching) while watchers keep getting frames; you can open
// another stream's page and watch it with your own still going; the corner's chat is your own
// room with your lines marked; coming back takes the stream over (one go-live in total); it
// stacks above/below a watched stream's corner player without overlapping; × ends it; and a
// tab closed with the stream in the corner ends it too (the tab-close listener outlives the
// page). A plain home click without the button still ends the stream. Two publishers with
// fake cameras and one watcher.
// Run through ./test.sh, or: BASE_URL=https://<ip> node live-pip.js
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
const near = (a, b) => Math.abs(a - b) <= 1.5;
const at = (r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;
const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
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
    await s.click('#start');
    await waitStatus(s, /^live$/);
    await s.waitForSelector('#live-pip', { timeout: 5000 });
    expect((await s.$('#live-pip-player')) === null, "the corner player showed on the stream's own page");
    return `${calls.goLive} go-live call`;
  });

  await step('without the button, a plain home click still ends the stream and releases the camera', async () => {
    await s.click('header a[href="/"]');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await sleep(300);
    expect((await s.$('#live-pip-player')) === null, 'the corner player showed without the button');
    expect(calls.stop === 1, `${calls.stop} stop calls`);
    await waitUnlisted(s, ME);
    return 'stopped, unlisted';
  });

  const w = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  let box;
  await step('live again, then the button: home, with your stream in the bottom right corner, live, the camera playing', async () => {
    await goLive(s, ME);
    await s.click('#live-pip');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    await waitText(s, '#live-pip-status', /^live$/, 10000);
    const name = await text(s, '#live-pip-player a.font-semibold');
    expect(name === ME, `the player names "${name}"`);
    expect((await s.$('#pip-player')) === null, 'a watch player showed with nothing being watched');
    box = await rect(s, '#live-pip-player');
    const view = await s.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(near(box.right, view.w - 24) && near(box.bottom, view.h - 24), `not in the corner: ${at(box)} in ${view.w}×${view.h}`);
    const v = await frames(s, '#live-pip-video');
    expect(v.muted, 'your own camera is not muted in the corner');
    return `${at(box)} · ${await framesFlow(s, '#live-pip-video')}`;
  });

  await step(`the stream survived leaving the page: a watcher at /watch/${ME} gets frames, and the corner counts them`, async () => {
    await w.goto(`${BASE}/watch/${ME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    const flow = await framesFlow(w, '#video');
    await s.waitForSelector('#live-pip-viewers[data-viewers]', { timeout: 15000 });
    const viewers = Number(await s.getAttribute('#live-pip-viewers', 'data-viewers'));
    expect(viewers >= 1, `the corner says ${viewers} watching`);
    expect(calls.goLive === 2 && calls.stop === 1, `go-live ${calls.goLive}, stop ${calls.stop}`);
    return `${flow} · "${await text(s, '#live-pip-viewers')}"`;
  });

  await step(`watching different stuff while live: ${OTHER}'s page plays, the corner stays, its chat button yields to the page's chat`, async () => {
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    const page = await framesFlow(s, '#video');
    expect((await s.$('#live-pip-player')) !== null, "the corner player is gone on another stream's page");
    expect(/^live$/i.test(await text(s, '#live-pip-status')), `the corner says "${await text(s, '#live-pip-status')}"`);
    expect(await s.$eval('#live-pip-chat', (b) => b.disabled), 'the corner chat button is not disabled on a page with its own chat');
    const corner = await framesFlow(s, '#live-pip-video');
    const theirs = await framesFlow(w, '#video');
    return `${page} · ${corner} · watcher still gets ${theirs}`;
  });

  await step("home: the corner's chat opens your own room, no nick needed, and your line reaches a watcher marked as the streamer's", async () => {
    await s.click('header a[href="/"]');
    await s.waitForSelector('#list article', { timeout: 10000 });
    await s.click('#live-pip-chat');
    await s.waitForSelector('#live-pip-player #chat', { timeout: 5000 });
    expect((await s.getAttribute('#live-pip-chat', 'aria-pressed')) === 'true', 'the chat button is not pressed');
    await s.waitForSelector('#live-pip-player #chat-text', { timeout: 10000 });
    expect((await s.$('#live-pip-player #chat-nick')) === null, 'the streamer was asked for a nick in their own room');
    await waitText(s, '#live-pip-player #chat-count', /live/, 10000);
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
    expect(calls.goLive === 2, `go-live was called again (${calls.goLive} in total)`);
    const preview = await framesFlow(s, '#preview');
    const theirs = await framesFlow(w, '#video');
    return `${preview} · watcher ${theirs}`;
  });

  await step(`both corners: ${OTHER} in picture in picture too, over your own; stacked bottom right, not overlapping, both playing`, async () => {
    await s.click('header a[href="/"]');
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    await s.click('#pip');
    await s.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await s.waitForSelector('#pip-player', { timeout: 10000 });
    await s.waitForSelector('#live-pip-player', { timeout: 10000 });
    await waitText(s, '#pip-status', /^watching$/, 10000);
    const mine = await rect(s, '#live-pip-player');
    const theirs = await rect(s, '#pip-player');
    const view = await s.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(!overlap(mine, theirs), `the players overlap: mine ${at(mine)}, theirs ${at(theirs)}`);
    expect(near(mine.right, view.w - 24) && near(mine.bottom, view.h - 24), `your own is not at the corner: ${at(mine)}`);
    expect(near(theirs.right, view.w - 24) && theirs.bottom < mine.top, `the watched one is not above yours: ${at(theirs)} over ${at(mine)}`);
    box = mine;
    return `mine ${at(mine)} · theirs ${at(theirs)} · ${await framesFlow(s, '#live-pip-video')} · ${await framesFlow(s, '#pip-video')}`;
  });

  await step('one corner chat at a time: opening the watched stream\'s chat closes your own', async () => {
    await s.click('#live-pip-chat');
    await s.waitForSelector('#live-pip-player #chat', { timeout: 5000 });
    await s.click('#pip-chat');
    await s.waitForSelector('#pip-player #chat', { timeout: 5000 });
    await s.waitForSelector('#live-pip-player #chat', { state: 'detached', timeout: 5000 });
    expect((await s.getAttribute('#live-pip-chat', 'aria-pressed')) === null, "your own chat button is still pressed");
    expect((await s.getAttribute('#pip-chat', 'aria-pressed')) === 'true', "the watched stream's chat button is not pressed");
    await s.click('#pip-chat');
    await s.waitForSelector('#pip-player #chat', { state: 'detached', timeout: 5000 });
    return 'switched, then closed';
  });

  await step('drag your own player away: it follows, leaves the stack, and the drop is not a click back to the page', async () => {
    box = await rect(s, '#live-pip-player');
    await drag(s, '#live-pip-video', -300, -200);
    const b = await rect(s, '#live-pip-player');
    expect(near(b.left, box.left - 300) && near(b.top, box.top - 200), `${at(box)} -> ${at(b)}`);
    expect(new URL(s.url()).pathname === '/', `went to ${new URL(s.url()).pathname}`);
    const theirs = await rect(s, '#pip-player');
    const view = await s.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight }));
    expect(near(theirs.bottom, view.h - 24), `the watched player did not take the corner: ${at(theirs)}`);
    return `${at(box)} -> ${at(b)}, the watched one at the corner`;
  });

  await step(`× on your player: it goes, the watcher sees ended, one stop call, ${ME} unlisted; the watched player is untouched`, async () => {
    await s.click('#live-pip-close');
    await s.waitForSelector('#live-pip-player', { state: 'detached', timeout: 5000 });
    await waitStatus(w, /ended/, 15000);
    expect(calls.stop === 2, `${calls.stop} stop calls in total`);
    await waitUnlisted(s, ME);
    expect((await s.$('#pip-player')) !== null, "the watched stream's player went with yours");
    await s.click('#pip-close');
    await s.waitForSelector('#pip-player', { state: 'detached', timeout: 5000 });
    return 'ended, unlisted';
  });

  await step('live once more, kept in the corner on home, then the document is left: the stream ends at once (the tab-close stop outlived the page) and the new load starts clean', async () => {
    await goLive(s, ME);
    await s.click('#live-pip');
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
