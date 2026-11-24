const fs = require('fs');
const os = require('os');
const path = require('path');
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
    if (info && typeof info === 'object' && info.skip) {
      results.push('skip');
      console.log(`SKIP  ${name.padEnd(78)} ${ms()} ms  ${info.skip}`);
      return;
    }
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
const frames = (p, sel) => p.$eval(sel, (v) => ({ w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames, paused: v.paused, muted: v.muted }));
async function framesFlow(p, sel) {
  const a = await frames(p, sel);
  await sleep(1500);
  const b = await frames(p, sel);
  expect(b.w > 0 && b.frames > a.frames, `${sel}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return `${sel} ${b.w}px wide, ${b.frames - a.frames} frames in 1.5s${b.muted ? ', muted' : ''}`;
}
const rect = (p, sel) => p.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
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
  const asNick = (p, name) => p.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), name);
  const goLive = async (p, name) => {
    await asNick(p, name);
    await p.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
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
  const calls = { goLive: 0, stop: 0 };
  s.on('request', (r) => {
    if (r.method() !== 'POST') return;
    if (r.url().includes(`/api/streams/${ME}/go-live`)) calls.goLive++;
    if (r.url().includes(`/api/streams/${ME}/stop`)) calls.stop++;
  });

  await step(`${ME} goes live; the picture in picture button is on the preview only once live`, async () => {
    await asNick(s, ME);
    await s.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
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

  await step(`watching different stuff while live: ${OTHER}'s page plays, the corner stays, its chat is your own room beside the page's ${OTHER} chat; the page's picture in picture is disabled: one corner at a time`, async () => {
    await s.click(`#list a[aria-label="watch ${OTHER}"]`);
    await s.waitForURL(`**/watch/${OTHER}`, { timeout: 10000 });
    await waitStatus(s, /^watching$/);
    const page = await framesFlow(s, '#video');
    expect((await s.$('#live-pip-player')) !== null, "the corner player is gone on another stream's page");
    expect(/^live$/i.test(await text(s, '#live-pip-status')), `the corner says "${await text(s, '#live-pip-status')}"`);
    expect(!(await s.$eval('#live-pip-chat', (b) => b.disabled)), "the corner chat button is disabled on another stream's page");
    await s.click('#live-pip-chat');
    await s.waitForSelector(`#live-pip-player #chat[data-room="${ME}"]`, { timeout: 5000 });
    await s.waitForSelector(`#chat-modal #chat[data-room="${OTHER}"]`, { timeout: 5000 });
    await s.click('#live-pip-chat');
    await s.waitForSelector('#live-pip-player #chat', { state: 'detached', timeout: 5000 });
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
    await s.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /ended/, 15000);
    await waitUnlisted(w, ME, 6000);
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
    await other.waitForFunction(() => document.querySelector('#viewers')?.dataset.viewers === '1', null, { timeout: 15000 });
    await s.click('#go-live');
    await s.waitForURL('**/live', { timeout: 10000 });
    expect((await s.$('#pip-player')) !== null, 'the watched player went before start');
    await s.waitForFunction(() => document.querySelector('#start')?.disabled === false);
    await s.click('#start');
    await s.waitForSelector('#pip-player', { state: 'detached', timeout: 5000 });
    await waitStatus(s, /^live$/);
    await other.waitForFunction(() => document.querySelector('#viewers')?.dataset.viewers === '0', null, { timeout: 15000 });
    expect((await s.$('#pip-player')) === null, 'the watched player came back');
    await s.click('#stop');
    await waitStatus(s, /^stopped$/);
    return `the watched player went on start; ${OTHER} counts "${await text(other, '#viewers')}"`;
  });

  await s.close();
  await other.click('#stop').catch(() => undefined);
  await browser.close();

  const LEFT = 'livepip3';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pip-'));
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { auto_picture_in_picture: 1 } } }));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--ignore-certificate-errors', '--screen-info={1920x1080}'],
    ignoreHTTPSErrors: true,
    permissions: ['camera', 'microphone'],
    viewport: null
  });
  await ctx.addInitScript((name) => {
    try {
      localStorage.setItem('nick', JSON.stringify(name));
    } catch {
    }
    const set = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    window.__tabLeft = null;
    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (action === 'enterpictureinpicture') window.__tabLeft = handler;
      return set(action, handler);
    };
  }, LEFT);
  const t = ctx.pages()[0];
  let chatSockets = 0;
  t.on('websocket', (ws) => {
    if (ws.url().includes(`/chat/${LEFT}`)) chatSockets++;
  });
  const listening = () => t.evaluate(() => typeof window.__tabLeft === 'function');
  const waitOut = (sel, timeout = 8000) => t.waitForFunction((q) => !!window.documentPictureInPicture?.window?.document.querySelector(q), sel, { timeout });
  const waitBack = (timeout = 5000) => t.waitForFunction(() => !window.documentPictureInPicture?.window, null, { timeout });
  const outFrames = () => t.evaluate(() => window.documentPictureInPicture.window.document.querySelector('#live-pip-video').getVideoPlaybackQuality().totalVideoFrames);
  const hasLine = (p, words) => p.evaluate((w) => [...document.querySelectorAll('#chat-lines [data-streamer="true"]')].some((el) => el.textContent.includes(w)), words);
  let away;
  const windowPage = () => ctx.pages().find((p) => p !== t && p !== away);
  let win;
  let base = 0;
  let left = false;
  const NO_WINDOW = { skip: 'no window: the browser did not say the tab was left' };

  await step(`${LEFT} goes live in a browser with a profile of its own: the page listens for the tab being left only while on air`, async () => {
    await t.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await t.waitForFunction(() => document.querySelector('#start')?.disabled === false);
    if (!(await t.evaluate(() => 'documentPictureInPicture' in window))) return { skip: 'this browser has no document picture in picture' };
    expect(!(await listening()), 'the page listens for the tab being left with nothing on air');
    await t.click('#start');
    await waitStatus(t, /^live$/);
    await t.waitForSelector('#chat[data-phase="open"]', { timeout: 10000 });
    expect(await listening(), 'on air, and the page does not listen for the tab being left');
    base = chatSockets;
    return 'not before start, listening once live';
  });

  await step('another tab comes to the front: the player comes out by itself into a window of its own, your stream playing in it, nothing of it in the page', async () => {
    if (!(await listening())) return NO_WINDOW;
    if (!BASE.startsWith('https://')) return { skip: 'the browser tells only https pages that their tab was left' };
    away = await ctx.newPage();
    await away.bringToFront();
    try {
      await waitOut('#live-pip-video');
    } catch {
      return { skip: 'this browser did not say the tab was left (automatic picture in picture: chrome and edge)' };
    }
    left = true;
    const seen = await t.evaluate(() => {
      const w = window.documentPictureInPicture.window;
      const d = w.document;
      return {
        status: d.querySelector('#live-pip-status').textContent.trim(),
        name: d.querySelector('#live-pip-player a.font-semibold').textContent.trim(),
        size: `${w.innerWidth}×${w.innerHeight}`,
        bg: getComputedStyle(d.querySelector('#live-pip-player')).backgroundColor,
        font: getComputedStyle(d.body).fontFamily
      };
    });
    expect(/^live$/i.test(seen.status) && seen.name === LEFT, `the window says "${seen.status}" for "${seen.name}"`);
    expect(seen.bg !== 'rgba(0, 0, 0, 0)' && /geist/i.test(seen.font), `the window is not dressed as the page: ${JSON.stringify(seen)}`);
    expect((await t.$('#live-pip-player')) === null, "the player is in the stream's own page as well");
    const a = await outFrames();
    await sleep(1500);
    const b = await outFrames();
    expect(b > a, `no frames in the window: ${a} -> ${b}`);
    return `a ${seen.size} window · "${seen.status}" · ${b - a} frames in 1.5s`;
  });

  await step("the window's chat button: your room opens in the window on the page's own socket, no nick asked, and the go live page's panel stands aside", async () => {
    if (!left) return NO_WINDOW;
    win = windowPage();
    expect(win, 'the window is not a page to press in');
    const before = await win.evaluate(() => innerHeight);
    expect(!(await win.$eval('#live-pip-chat', (b) => b.disabled)), "the chat button is disabled in the window over the stream's own page");
    await win.click('#live-pip-chat');
    await win.waitForSelector('#live-pip-player #chat[data-phase="open"]', { timeout: 8000 });
    expect((await win.$('#chat-nick')) === null, 'the streamer was asked for a nick in their own room');
    await t
      .waitForFunction(() => document.querySelector('#chat')?.dataset.away === '' && !document.querySelector('#chat-lines'), null, { timeout: 5000 })
      .catch(() => expect(false, "the page's panel still draws the room, beside the window's"));
    expect(chatSockets === base, `${chatSockets - base} more chat sockets`);
    await sleep(300);
    const after = await win.evaluate(() => innerHeight);
    expect(after > before, `the window did not grow for the chat: ${before} -> ${after} tall`);
    return `the window ${before} -> ${after} tall · no new chat socket`;
  });

  const said = `hi from the window ${Date.now()}`;
  await step('a line typed in the window goes out as the streamer; half of another stays in the box', async () => {
    if (!left) return NO_WINDOW;
    await win.fill('#chat-text', said);
    await win.click('#chat-send');
    await win.waitForFunction((w) => [...document.querySelectorAll('#chat-lines [data-streamer="true"]')].some((el) => el.textContent.includes(w)), said, { timeout: 8000 });
    await win.fill('#chat-text', 'half a li');
    return `"${said}"`;
  });

  await step('back in the tab: the window goes by itself, and the page has its chat again with the line and the half typed one, on the same socket', async () => {
    if (!left) return NO_WINDOW;
    await t.bringToFront();
    await waitBack();
    await t.waitForSelector('#chat-lines', { timeout: 5000 });
    expect((await t.getAttribute('#chat', 'data-away')) === null, "the page's panel still stands aside");
    expect(await hasLine(t, said), 'the line said in the window is not in the page');
    const draft = await t.inputValue('#chat-text');
    expect(draft === 'half a li', `the half typed line is "${draft}"`);
    expect((await t.$('#live-pip-player')) === null, "the player is in the stream's own page");
    expect(/^live$/i.test(await text(t, '#status')), `the page says "${await text(t, '#status')}"`);
    expect(chatSockets === base, `${chatSockets - base} more chat sockets`);
    return `still live · draft "${draft}" · no new chat socket`;
  });

  await step('left again: the window is back with the chat in it; a click on the name there brings the tab to the front, and the window goes', async () => {
    if (!left) return NO_WINDOW;
    await away.bringToFront();
    await waitOut('#live-pip-player #chat[data-phase="open"]');
    win = windowPage();
    await win.click('#live-pip-player a.font-semibold');
    await waitBack();
    expect(new URL(t.url()).pathname === '/live', `the tab is on ${new URL(t.url()).pathname}`);
    return 'the tab is in front on /live, the window gone';
  });

  await step('home: the corner player with its chat; the tab left: the same box in a window, chat and all; back: in the corner again. the same socket throughout', async () => {
    if (!left) return NO_WINDOW;
    await t.click('header a[href="/"]');
    await t.waitForSelector('#live-pip-player #chat[data-phase="open"]', { timeout: 10000 });
    expect(chatSockets === base, `${chatSockets - base} more chat sockets on the way to the corner`);
    const box = await rect(t, '#live-pip-player');
    await away.bringToFront();
    await waitOut('#live-pip-player #chat[data-phase="open"]');
    expect((await t.$('#live-pip-player')) === null, 'the player is still in the page with its window open');
    win = windowPage();
    expect(await hasLine(win, said), 'the lines did not come along to the window');
    const size = await win.evaluate(() => `${innerWidth}×${innerHeight}`);
    expect(chatSockets === base, `${chatSockets - base} more chat sockets with the box in the window`);
    await t.bringToFront();
    await waitBack();
    await t.waitForSelector('#live-pip-player #chat[data-phase="open"]', { timeout: 5000 });
    expect(await hasLine(t, said), 'the lines did not come back to the corner');
    expect(chatSockets === base, `${chatSockets - base} more chat sockets back in the corner`);
    return `a ${Math.round(box.width)}×${Math.round(box.height)} box -> a ${size} window -> the corner · no new chat socket`;
  });

  await step('left once more: × in the window asks there, and yes ends the stream and the window; off air the page listens no more', async () => {
    if (!left) return NO_WINDOW;
    await away.bringToFront();
    await waitOut('#live-pip-video');
    win = windowPage();
    await win.click('#live-pip-close');
    await win.waitForSelector('#live-pip-confirm[open]', { timeout: 5000 });
    await win.click('#live-pip-confirm-yes');
    await waitBack();
    await waitUnlisted(t, LEFT);
    expect(!(await listening()), 'the page still listens for the tab being left with nothing on air');
    return 'ended, unlisted, no window, not listening';
  });

  await t.click('#stop', { timeout: 2000 }).catch(() => undefined);
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
