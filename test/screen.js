const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const NAME = 'screentest';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--auto-select-desktop-capture-source=Entire screen'];
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
const waitStatus = (p, re, timeout = 20000) => p.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#status')?.textContent || ''), re.source, { timeout });
const frames = (p, sel) => p.$eval(sel, (v) => ({ w: v.videoWidth, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
async function framesFlow(p, sel) {
  const a = await frames(p, sel);
  await sleep(1500);
  const b = await frames(p, sel);
  expect(b.w > 0 && b.frames > a.frames, `${sel}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return `${b.w}px wide, ${b.frames - a.frames} frames in 1.5s`;
}
const trackId = (p, sel) => p.$eval(sel, (v) => v.srcObject?.getVideoTracks()[0]?.id ?? null);
const audioTracks = (p, sel) => p.$eval(sel, (v) => ({ tracks: v.srcObject?.getAudioTracks().length ?? 0, muted: v.muted }));
const tiles = (p) => p.$$eval('#tiles button[id^="tile-"]', (els) => els.map((el) => ({ id: el.id, label: el.parentElement.querySelector('span')?.textContent.trim() ?? el.textContent.trim() })));
const sameTiles = (got, want) => got.length === want.length && got.every((t, i) => t.id === want[i].id && t.label === want[i].label);
async function waitTiles(p, want, timeout = 10000) {
  const t0 = Date.now();
  let got = [];
  while (Date.now() - t0 < timeout) {
    got = await tiles(p);
    if (sameTiles(got, want)) return got;
    await sleep(200);
  }
  throw new Error(`tiles are ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
const layerBox = (p, id) =>
  p.evaluate((id) => {
    const el = document.getElementById(`layer-${id}`);
    if (!el) return null;
    const f = (v) => Math.round(parseFloat(v) * 10) / 1000;
    return { x: f(el.style.left), y: f(el.style.top), w: f(el.style.width), h: f(el.style.height), kind: el.dataset.kind };
  }, id);
const TOL = 0.02;
const near = (got, want) => got !== null && ['x', 'y', 'w', 'h'].every((k) => Math.abs(got[k] - want[k]) < TOL);
const fmt = (b) => (b ? `${Math.round(b.x * 100)},${Math.round(b.y * 100)} ${Math.round(b.w * 100)}x${Math.round(b.h * 100)}%` : 'none');
async function waitBox(p, id, want, timeout = 10000) {
  const t0 = Date.now();
  let got = null;
  while (Date.now() - t0 < timeout) {
    got = await layerBox(p, id);
    if (want === null ? got === null : near(got, want)) return got;
    await sleep(100);
  }
  throw new Error(`layer ${id} is ${fmt(got)}, wanted ${want ? fmt(want) : 'none'}`);
}
const order = (p) => p.$$eval('#scene > [id^="layer-"]', (els) => els.map((el) => el.id.replace('layer-', '')));
async function waitOrder(p, want, timeout = 5000) {
  const t0 = Date.now();
  let got = [];
  while (Date.now() - t0 < timeout) {
    got = await order(p);
    if (got.join() === want.join()) return got;
    await sleep(100);
  }
  throw new Error(`the layers are ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
async function dragRow(p, id, rows) {
  const handle = await (await p.$(`#source-drag-${id}`)).boundingBox();
  const pitch = await p.$$eval('#source-list > li', (els) => els[1].getBoundingClientRect().top - els[0].getBoundingClientRect().top);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x, y + rows * pitch, { steps: 8 });
  await p.mouse.up();
}
async function meter(p, sel, ms = 1500, attr = 'aria-valuenow') {
  const t0 = Date.now();
  const levels = new Set();
  let peak = 0;
  while (Date.now() - t0 < ms) {
    const now = Number(await p.getAttribute(sel, attr));
    levels.add(now);
    peak = Math.max(peak, now);
    await sleep(25);
  }
  return { peak, distinct: levels.size };
}
const voice = (p, id, ms = 1500) => meter(p, `#layer-${id}-avatar`, ms, 'data-voice');
const trackCounts = (p, sel) => p.$eval(sel, (v) => ({ video: v.srcObject?.getVideoTracks().length ?? 0, audio: v.srcObject?.getAudioTracks().length ?? 0 }));
function recordPeerConnections() {
  window.__pcs = [];
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Orig, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      window.__pcs.push(pc);
      return pc;
    }
  });
}
async function flowingVideos(p) {
  const sample = () =>
    p.evaluate(async () => {
      const out = {};
      for (const pc of window.__pcs || []) {
        if (pc.connectionState !== 'connected') continue;
        for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'video') out[s.mid ?? s.id] = s.framesDecoded || 0;
      }
      return out;
    });
  const a = await sample();
  await sleep(1000);
  const b = await sample();
  return Object.keys(b).filter((k) => b[k] > (a[k] || 0)).length;
}
const CAMERA = { id: 'tile-0', label: 'camera' };
const SCREEN2 = { id: 'tile-2', label: 'screen 2' };
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const CORNER = { x: 0.73, y: 0.714, w: 0.25, h: 0.25 };
const MOVED = { x: 0.43, y: 0.414, w: 0.25, h: 0.25 };
const SIZED = { x: 0.43, y: 0.414, w: 0.4, h: 0.4 };
const SECOND = { x: 0.02, y: 0.631, w: 0.333, h: 0.333 };

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const pubContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await pubContext.addInitScript(() => {
    for (const key of ['settings.lastArrangement', 'settings.livePanels', 'settings.mixer', 'settings.cameraLayout', 'settings.micOnly']) localStorage.removeItem(key);
  });
  const pub = await pubContext.newPage();
  const newWatcher = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addInitScript(recordPeerConnections);
    return ctx.newPage();
  };
  const w = await newWatcher();
  const track = {};

  await step(`publisher goes live as ${NAME}: the sources, the camera layer and the faders are there before start, the share button comes with the stream`, async () => {
    await pub.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), NAME);
    await pub.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await pub.waitForFunction(() => !document.querySelector('#start').disabled);
    expect((await pub.$('#share-screen')) === null, 'the share button shows before going live');
    await pub.waitForSelector('#gain-mic', { timeout: 5000 });
    expect((await pub.$('#gain-master')) !== null, 'the master fader is not there before going live');
    await pub.waitForSelector('#source-cam', { timeout: 5000 });
    const cam = await waitBox(pub, 'cam', FULL, 5000);
    expect(cam.kind === 'camera', `the camera layer is a ${cam.kind}`);
    track.pubCamera = await trackId(pub, '#preview');
    expect(track.pubCamera, 'the preview plays no track');
    await pub.click('#start');
    await waitStatus(pub, /^live$/);
    await pub.waitForFunction(() => document.querySelector('#share-screen') && !document.querySelector('#share-screen').disabled, null, { timeout: 5000 });
    await pub.waitForSelector('#mixer', { timeout: 5000 });
    for (const sel of ['#level-mic', '#gain-mic', '#mute-mic', '#level-master', '#gain-master', '#mute-master']) expect((await pub.$(sel)) !== null, `${sel} is not in the mixer`);
    expect((await trackId(pub, '#preview')) === track.pubCamera, 'the preview changed track on start');
    return 'live, #share-screen enabled, the mixer up';
  });

  await step(`watcher: /watch/${NAME} plays the camera big in its one full layer, no tiles, one video stream coming in`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    await waitBox(w, 'cam', FULL);
    await waitTiles(w, []);
    track.camera = await trackId(w, '#video');
    expect(await w.$eval('#layer-cam #video', () => true).catch(() => false), 'the camera layer does not hold #video');
    const flow = await framesFlow(w, '#video');
    const n = await flowingVideos(w);
    expect(n === 1, `${n} video streams flowing, not 1`);
    return flow;
  });

  await step('publisher adds a screen from the +: a row, the screen the whole frame, the camera a layer over it bottom right', async () => {
    await pub.click('#add-source');
    await pub.click('#add-screen');
    await pub.waitForSelector('#source-s1', { timeout: 10000 });
    expect((await pub.$('#source-remove-s1')) !== null, 'no × on the screen row');
    await waitBox(pub, 's1', FULL, 5000);
    await waitBox(pub, 'cam', CORNER, 5000);
    await waitOrder(pub, ['s1', 'cam']);
    await pub.waitForFunction((id) => document.querySelector('#layer-s1 #preview')?.srcObject?.getVideoTracks()[0]?.id !== id, track.pubCamera, { timeout: 5000 });
    expect((await trackId(pub, '#layer-cam-video')) === track.pubCamera, 'the camera layer does not play the camera');
    expect(!(await pub.$eval('#share-screen', (b) => b.disabled)), 'the share button went disabled with slots left');
    return `${await framesFlow(pub, '#preview')} · camera ${await framesFlow(pub, '#layer-cam-video')}`;
  });

  await step('watcher, already watching: the same frame, the sound on #video only, two streams', async () => {
    await waitBox(w, 's1', FULL);
    const cam = await waitBox(w, 'cam', CORNER);
    await waitTiles(w, []);
    track.screen1 = await trackId(w, '#video');
    expect(track.screen1 && track.screen1 !== track.camera, 'the big video still plays the camera track');
    expect((await trackId(w, '#layer-cam-video')) === track.camera, 'the camera layer does not play the camera track');
    const big = await audioTracks(w, '#video');
    const small = await audioTracks(w, '#layer-cam-video');
    expect(big.tracks === 1, `the big video has ${big.tracks} audio tracks`);
    expect(small.tracks === 0 && small.muted, `the camera layer carries sound: ${JSON.stringify(small)}`);
    const flow = `${await framesFlow(w, '#video')} · camera ${await framesFlow(w, '#layer-cam-video')}`;
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return `${fmt(cam)} · ${flow}`;
  });

  await step('publisher drags the camera up and left across the preview: it moves, and the watcher\'s follows', async () => {
    const frame = await pub.$eval('#scene', (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const from = await pub.$eval('#layer-cam', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await pub.mouse.move(from.x, from.y);
    await pub.mouse.down();
    await pub.mouse.move(from.x - frame.w * 0.3, from.y - frame.h * 0.3, { steps: 12 });
    await pub.mouse.up();
    const mine = await waitBox(pub, 'cam', MOVED, 2000);
    const theirs = await waitBox(w, 'cam', MOVED, 5000);
    return `mine ${fmt(mine)} · theirs ${fmt(theirs)}`;
  });

  await step('a corner pulled: the camera is 40% wide on both sides, its shape kept and its top left corner where it was', async () => {
    expect((await pub.getAttribute('#layer-cam', 'aria-pressed')) === 'true', 'the dragged layer is not the selected one');
    const frame = await pub.$eval('#scene', (el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const h = await (await pub.$('#layer-cam-resize-se')).boundingBox();
    await pub.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await pub.mouse.down();
    await pub.mouse.move(h.x + h.width / 2 + frame.w * 0.15, h.y + h.height / 2 + frame.h * 0.15, { steps: 10 });
    await pub.mouse.up();
    const mine = await waitBox(pub, 'cam', SIZED, 2000);
    const theirs = await waitBox(w, 'cam', SIZED, 5000);
    await pub.waitForFunction(() => {
      const last = JSON.parse(localStorage.getItem('settings.lastArrangement') || 'null');
      return !!last && last.boxes.some((b) => b.role === 'camera' && Math.abs(b.w - 0.4) < 0.02);
    }, null, { timeout: 3000 });
    return `mine ${fmt(mine)} · theirs ${fmt(theirs)}`;
  });

  await step("the order follows the sidebar: the camera's row dragged down by its handle goes under the screen on both sides, dragged back up it is over it again, and the handle's arrow keys do the same", async () => {
    await dragRow(pub, 'cam', 1);
    await waitOrder(pub, ['cam', 's1']);
    await waitOrder(w, ['cam', 's1']);
    await dragRow(pub, 'cam', -1);
    await waitOrder(pub, ['s1', 'cam']);
    await waitOrder(w, ['s1', 'cam']);
    await pub.focus('#source-drag-cam');
    await pub.keyboard.press('Space');
    await pub.keyboard.press('ArrowDown');
    await pub.keyboard.press('Space');
    await waitOrder(pub, ['cam', 's1']);
    await waitOrder(w, ['cam', 's1']);
    await pub.keyboard.press('Space');
    await pub.keyboard.press('ArrowUp');
    await pub.keyboard.press('Space');
    await waitOrder(pub, ['s1', 'cam']);
    await waitOrder(w, ['s1', 'cam']);
    await pub.keyboard.press('Space');
    await pub.keyboard.press('ArrowDown');
    await pub.keyboard.press('Escape');
    await waitOrder(pub, ['s1', 'cam']);
    return 'dragged down and up, then the keys, then escape';
  });

  await step('the eye: the camera taken off the stream is a tile for the watcher, and put back it is where it was', async () => {
    await pub.click('#source-eye-cam');
    await waitBox(pub, 'cam', null, 2000);
    await waitBox(w, 'cam', null, 5000);
    await waitTiles(w, [CAMERA]);
    expect((await trackId(w, '#tile-0-video')) === track.camera, 'the tile does not play the camera track');
    expect((await trackId(w, '#video')) === track.screen1, 'the big picture changed');
    await pub.click('#source-eye-cam');
    await waitBox(pub, 'cam', SIZED, 2000);
    await waitBox(w, 'cam', SIZED, 5000);
    await waitTiles(w, []);
    return 'beside, then back';
  });

  await step("the mixer's bars move with the fake mic: the mic's and the master's", async () => {
    const mic = await meter(pub, '#level-mic');
    const master = await meter(pub, '#level-master');
    expect(mic.peak > 0 && mic.distinct > 3, `the mic bar: ${JSON.stringify(mic)}`);
    expect(master.peak > 0 && master.distinct > 3, `the master bar: ${JSON.stringify(master)}`);
    return `mic peak ${mic.peak}% · master peak ${master.peak}%`;
  });

  await step("the mic's fader at 0 flattens the master; back at 1 it moves; the mute flattens it too", async () => {
    await pub.fill('#gain-mic', '0');
    await sleep(600);
    const quiet = await meter(pub, '#level-master', 1000);
    expect(quiet.peak <= 2, `the master still moves with the mic fader at 0: ${JSON.stringify(quiet)}`);
    await pub.fill('#gain-mic', '1');
    const loud = await meter(pub, '#level-master');
    expect(loud.peak > 0 && loud.distinct > 3, `the master does not move with the fader back at 1: ${JSON.stringify(loud)}`);
    await pub.click('#mute-mic');
    expect((await pub.getAttribute('#mute-mic', 'aria-pressed')) === 'true', 'the mute is not pressed');
    await sleep(600);
    const muted = await meter(pub, '#level-master', 1000);
    expect(muted.peak <= 2, `the master still moves with the mic muted: ${JSON.stringify(muted)}`);
    await pub.click('#mute-mic');
    return 'flat at 0, moving at 1, flat muted';
  });

  await step('a second screen, from the share button: its own corner bottom left on both sides; taken off the stream it is a tile', async () => {
    await pub.click('#share-screen');
    await pub.waitForSelector('#source-s2', { timeout: 10000 });
    await waitBox(pub, 's2', SECOND, 5000);
    await waitBox(w, 's2', SECOND, 5000);
    track.screen2 = await trackId(w, '#layer-s2-video');
    expect(track.screen2 && ![track.camera, track.screen1].includes(track.screen2), 'the second screen plays a track seen before');
    let n = await flowingVideos(w);
    expect(n === 3, `${n} video streams flowing, not 3`);
    await pub.click('#source-eye-s2');
    await waitBox(w, 's2', null, 5000);
    await waitTiles(w, [SCREEN2]);
    expect((await trackId(w, '#tile-2-video')) === track.screen2, 'the tile does not play the second screen');
    n = await flowingVideos(w);
    expect(n === 3, `${n} video streams flowing, not 3: a tile is still received`);
    return 'a corner, then a tile';
  });

  await step('a watcher arriving now gets the whole frame at once: the screen big, the camera over it, the second screen a tile', async () => {
    const late = await newWatcher();
    await late.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(late, /^watching$/);
    await waitBox(late, 's1', FULL);
    await waitBox(late, 'cam', SIZED);
    await waitTiles(late, [SCREEN2]);
    const ids = [await trackId(late, '#video'), await trackId(late, '#layer-cam-video'), await trackId(late, '#tile-2-video')];
    expect(ids.every(Boolean) && new Set(ids).size === 3, `the three videos do not play three tracks: ${JSON.stringify(ids)}`);
    const flow = `${await framesFlow(late, '#video')} · ${await framesFlow(late, '#layer-cam-video')} · ${await framesFlow(late, '#tile-2-video')}`;
    const n = await flowingVideos(late);
    expect(n === 3, `${n} video streams flowing, not 3`);
    await late.context().close();
    return flow;
  });

  await step("the first screen's × stops sharing it: the row and the layer go, the camera is the big picture, the tile stays", async () => {
    await pub.click('#source-remove-s1');
    await pub.waitForSelector('#source-s1', { state: 'detached', timeout: 5000 });
    await waitBox(pub, 's1', null, 2000);
    await waitBox(w, 's1', null, 5000);
    await w.waitForFunction((id) => document.querySelector('#layer-cam #video')?.srcObject?.getVideoTracks()[0]?.id === id, track.camera, { timeout: 5000 });
    await waitTiles(w, [SCREEN2]);
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return 'the camera big, screen 2 a tile';
  });

  await step('stop: the watcher sees ended; the button goes, the faders and the sources stay, and the camera fills the frame again', async () => {
    await pub.click('#stop');
    await waitStatus(w, /ended/);
    expect((await pub.$('#gain-mic')) !== null, 'the mic fader went with the stream');
    expect((await pub.$('#share-screen')) === null, 'the share button shows after stop');
    expect((await pub.$('#source-s2')) === null, 'the screen row stays after stop');
    expect((await pub.$('#source-cam')) !== null, 'the camera row went with the stream');
    await waitBox(pub, 'cam', FULL, 2000);
    expect((await trackId(pub, '#preview')) === track.pubCamera, 'the preview is not the camera after stop');
    await waitTiles(w, []);
    return 'ended';
  });

  await step("mic only: the camera's × turns it off, the avatar is a source and fills the frame as the face, the mic stays, and it is kept for the next visit", async () => {
    await pub.click('#source-remove-cam');
    await pub.waitForSelector('#source-cam', { state: 'detached', timeout: 5000 });
    await pub.waitForSelector('#source-me', { timeout: 5000 });
    const me = await waitBox(pub, 'me', FULL, 2000);
    expect(me.kind === 'avatar', `the avatar layer is a ${me.kind}`);
    await waitStatus(pub, /^mic ready$/);
    const tracks = await trackCounts(pub, '#preview');
    expect(tracks.video === 0 && tracks.audio === 1, `the stream is ${JSON.stringify(tracks)}, not the mic alone`);
    expect(!(await pub.$eval('#start', (b) => b.disabled)), 'start is disabled with the mic alone');
    const kept = await pub.evaluate(() => localStorage.getItem('settings.micOnly'));
    expect(kept === 'true', `settings.micOnly is ${kept}`);
    return `the avatar ${fmt(me)}, ${JSON.stringify(tracks)}`;
  });

  await step('start again, mic only: the watcher is watching on the sound alone, the avatar big, nothing coming in on video, and the avatar moves with the voice on both sides', async () => {
    await pub.click('#start');
    await waitStatus(pub, /^live$/);
    await waitStatus(w, /^watching$/);
    await waitBox(w, 'me', FULL);
    await waitTiles(w, []);
    const tracks = await trackCounts(w, '#video');
    expect(tracks.video === 0 && tracks.audio === 1, `the watcher's stream is ${JSON.stringify(tracks)}`);
    const n = await flowingVideos(w);
    expect(n === 0, `${n} video streams flowing, not 0: the avatar is drawn, not sent`);
    await w.click('#unmute');
    const mine = await voice(pub, 'me');
    const theirs = await voice(w, 'me');
    expect(mine.peak > 0 && mine.distinct > 3, `my avatar does not move: ${JSON.stringify(mine)}`);
    expect(theirs.peak > 0 && theirs.distinct > 3, `their avatar does not move: ${JSON.stringify(theirs)}`);
    return `mine peak ${mine.peak}% · theirs peak ${theirs.peak}%`;
  });

  await step('the + puts the camera back, live: the camera fills the frame on both sides with frames flowing, the avatar goes off the stream (its row stays), mic only is forgotten', async () => {
    await pub.click('#add-source');
    await pub.click('#add-camera');
    await pub.waitForSelector('#source-cam', { timeout: 10000 });
    await waitBox(pub, 'cam', FULL, 5000);
    await waitBox(pub, 'me', null, 2000);
    expect((await pub.$('#source-me')) !== null, 'the avatar row went with the camera');
    await waitBox(w, 'cam', FULL, 5000);
    await waitBox(w, 'me', null, 5000);
    await w.waitForFunction(() => document.querySelector('#layer-cam #video')?.srcObject?.getVideoTracks().length === 1, null, { timeout: 5000 });
    const flow = await framesFlow(w, '#video');
    const kept = await pub.evaluate(() => localStorage.getItem('settings.micOnly'));
    expect(kept === 'false', `settings.micOnly is ${kept}`);
    return flow;
  });

  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
