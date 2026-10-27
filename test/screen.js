// Screen sharing: a publisher shares screens beside the camera, one per press, into slots
// offered empty when going live, so nobody renegotiates. A watcher already watching gets the
// screen big and the camera over it where the streamer put it (the layout: a box dragged
// around the preview, sized with a dial, or set beside the screen as a tile), and every change
// of the layout follows to the watcher within a beat; the camera clicked goes big and the
// screen is a tile; a second screen is a second tile; a screen stopped goes from every watcher;
// a watcher arriving mid-share sees it all at once, layout included. Chrome picks the screen on
// its own (--auto-select-desktop-capture-source). Which picture is where is read off the tiles
// (#tile-<slot>, the big one is the slot without a tile), off the camera's box (#camera-overlay,
// its place and width as fractions of the frame) and off track identity (a track that moves
// from a tile to #video is the same track); not off sizes, which the encoder changes with the
// bitrate.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node screen.js
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
/** The video track a <video> plays, by id: the same track keeps its id as it moves between the big video and a tile. */
const trackId = (p, sel) => p.$eval(sel, (v) => v.srcObject?.getVideoTracks()[0]?.id ?? null);
const audioTracks = (p, sel) => p.$eval(sel, (v) => ({ tracks: v.srcObject?.getAudioTracks().length ?? 0, muted: v.muted }));
/** The tiles under the video, in order: the button's id and the label on it. */
const tiles = (p) => p.$$eval('#tiles button[id^="tile-"]', (els) => els.map((el) => ({ id: el.id, label: el.parentElement.querySelector('span').textContent.trim() })));
const sameTiles = (got, want) => got.length === want.length && got.every((t, i) => t.id === want[i].id && t.label === want[i].label);
/** Until the tiles are exactly these (none: no strip at all). */
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
/**
 * The camera's box over the big picture, as fractions of the frame (what the layout says, read
 * back off the inline style the box is drawn with), or null when the camera is not over it.
 */
const overlay = (p) =>
  p.evaluate(() => {
    const el = document.querySelector('#camera-overlay');
    if (!el) return null;
    const pct = (v) => Math.round(parseFloat(v) * 10) / 1000;
    return { x: pct(el.style.left), y: pct(el.style.top), w: pct(el.style.width) };
  });
const TOL = 0.02;
const near = (got, want) => got !== null && Math.abs(got.x - want.x) < TOL && Math.abs(got.y - want.y) < TOL && Math.abs(got.w - want.w) < TOL;
const fmt = (b) => (b ? `${Math.round(b.x * 100)}%,${Math.round(b.y * 100)}% ${Math.round(b.w * 100)}% wide` : 'none');
/** Until the camera's box is about here (null: until there is no box). */
async function waitOverlay(p, want, timeout = 10000) {
  const t0 = Date.now();
  let got = null;
  while (Date.now() - t0 < timeout) {
    got = await overlay(p);
    if (want === null ? got === null : near(got, want)) return got;
    await sleep(100);
  }
  throw new Error(`the camera's box is ${fmt(got)}, wanted ${fmt(want)}`);
}
// Every RTCPeerConnection the page makes, for getStats: installed before navigation.
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
/** How many video streams this watcher is really receiving: inbound video sections whose decoded frames grow over a second. Idle slots get padding, no frames. */
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
const SCREEN1 = { id: 'tile-1', label: 'screen' };
const SCREEN2 = { id: 'tile-2', label: 'screen 2' };
/** Where the camera starts: bottom right, a quarter wide (relay.ts DEFAULT_LAYOUT). */
const DEFAULT = { x: 0.73, y: 0.73, w: 0.25 };
/** Where the drag below puts it: up and left by 0.3 of the frame. */
const MOVED = { x: 0.43, y: 0.43, w: 0.25 };
/** And the dial after that. */
const SIZED = { ...MOVED, w: 0.4 };

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const pubContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  // the layout is this browser's, kept between streams (localstorage, read when the page boots):
  // start from the default, whatever an earlier run left there
  await pubContext.addInitScript(() => localStorage.removeItem('settings.cameraLayout'));
  const pub = await pubContext.newPage();
  const newWatcher = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addInitScript(recordPeerConnections);
    return ctx.newPage();
  };
  const w = await newWatcher();
  /** The camera's and the screens' tracks as the watcher knows them, by slot, learnt as they show. */
  const track = {};

  await step(`publisher goes live as ${NAME}; the share button is there and enabled, no screens, no layout row`, async () => {
    await pub.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await pub.fill('#name', NAME);
    await pub.waitForFunction(() => !document.querySelector('#start').disabled);
    expect((await pub.$('#share-screen')) === null, 'the share button shows before going live');
    await pub.click('#start');
    await waitStatus(pub, /^live$/);
    await pub.waitForFunction(() => document.querySelector('#share-screen') && !document.querySelector('#share-screen').disabled, null, { timeout: 5000 });
    expect((await pub.$('#screens')) === null, 'a screens strip shows with nothing shared');
    expect((await pub.$('#layout')) === null, 'the layout row shows with nothing shared');
    expect((await pub.$('#camera-overlay')) === null, 'the camera is drawn over the preview with nothing shared');
    track.pubCamera = await trackId(pub, '#preview');
    return 'live, #share-screen enabled';
  });

  await step(`watcher: /watch/${NAME} plays the camera big, no tiles, no box over it, one video stream coming in`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    await waitTiles(w, []);
    expect((await overlay(w)) === null, 'a camera box over the camera');
    track.camera = await trackId(w, '#video');
    const flow = await framesFlow(w, '#video');
    const n = await flowingVideos(w);
    expect(n === 1, `${n} video streams flowing, not 1`);
    return flow;
  });

  await step('publisher shares a screen: the preview is the screen with the camera over it bottom right, a "screen" tile with its stop, the layout row', async () => {
    await pub.click('#share-screen');
    await pub.waitForSelector('#screen-0', { timeout: 10000 });
    const label = (await pub.textContent('#screen-0 span')).trim();
    expect(label === 'screen', `the tile is labelled "${label}"`);
    expect((await pub.$('#stop-screen-0')) !== null, 'no stop on the tile');
    expect(!(await pub.$eval('#share-screen', (b) => b.disabled)), 'the share button went disabled with slots left');
    // the big preview is what a watcher gets big: the screen now, the camera in its box
    await pub.waitForFunction((id) => document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.id !== id, track.pubCamera, { timeout: 5000 });
    const box = await waitOverlay(pub, DEFAULT);
    expect((await trackId(pub, '#camera-overlay-video')) === track.pubCamera, 'the box over the preview does not play the camera');
    expect((await pub.$('#camera-tile')) === null, 'a camera tile in the strip while the camera is over the screen');
    expect(await pub.$eval('#camera-over', (b) => b.getAttribute('aria-pressed') === 'true'), '"on the screen" is not the pressed one');
    expect(!(await pub.$eval('#camera-size', (i) => i.disabled)), 'the size dial is disabled with the camera on the screen');
    return `${fmt(box)} · screen ${await framesFlow(pub, '#preview')} · camera ${await framesFlow(pub, '#camera-overlay-video')}`;
  });

  await step('watcher, already watching: the screen goes big, the camera is a box over it where the streamer has it, no tiles, the sound stays on the one <video>', async () => {
    const box = await waitOverlay(w, DEFAULT);
    await waitTiles(w, []);
    track.screen1 = await trackId(w, '#video');
    expect(track.screen1 && track.screen1 !== track.camera, `the big video still plays the camera's track`);
    expect((await trackId(w, '#camera-overlay-video')) === track.camera, 'the box does not play the camera track');
    const big = await audioTracks(w, '#video');
    const small = await audioTracks(w, '#camera-overlay-video');
    expect(big.tracks === 1, `the big video has ${big.tracks} audio tracks`);
    expect(small.tracks === 0 && small.muted, `the box carries sound: ${JSON.stringify(small)}`);
    const flow = `${await framesFlow(w, '#video')} · box ${await framesFlow(w, '#camera-overlay-video')}`;
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return `${fmt(box)} · ${flow}`;
  });

  await step('publisher drags the camera up and left across the preview: its box moves there, and the watcher\'s follows', async () => {
    const frame = await pub.$eval('#preview', (v) => {
      const r = v.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    const from = await pub.$eval('#camera-overlay', (b) => {
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await pub.mouse.move(from.x, from.y);
    await pub.mouse.down();
    await pub.mouse.move(from.x - frame.w * 0.3, from.y - frame.h * 0.3, { steps: 12 });
    await pub.mouse.up();
    const mine = await waitOverlay(pub, MOVED, 2000);
    const theirs = await waitOverlay(w, MOVED, 5000);
    return `mine ${fmt(mine)} · theirs ${fmt(theirs)}`;
  });

  await step('publisher turns the size dial to 40%: both boxes are 40% of the frame wide, and the layout is kept in this browser', async () => {
    await pub.fill('#camera-size', '0.4');
    const mine = await waitOverlay(pub, SIZED, 2000);
    const theirs = await waitOverlay(w, SIZED, 5000);
    const kept = await pub.evaluate(() => JSON.parse(localStorage.getItem('settings.cameraLayout') || 'null'));
    expect(kept && kept.camera === 'over' && near(kept, SIZED), `localstorage holds ${JSON.stringify(kept)}`);
    return `mine ${fmt(mine)} · theirs ${fmt(theirs)}`;
  });

  await step('watcher clicks the camera box: the camera is big and the screen is a tile, the same tracks swapped; the screen tile clicked puts it back', async () => {
    await w.click('#camera-overlay');
    await waitTiles(w, [SCREEN1]);
    await waitOverlay(w, null, 2000);
    expect((await trackId(w, '#video')) === track.camera, 'the big video is not the camera track');
    expect((await trackId(w, '#tile-1-video')) === track.screen1, 'the tile is not the screen track');
    const flow = await framesFlow(w, '#tile-1-video');
    await w.click('#tile-1');
    await waitTiles(w, []);
    await waitOverlay(w, SIZED, 2000);
    expect((await trackId(w, '#video')) === track.screen1, 'the big video is not the screen track again');
    return flow;
  });

  await step('publisher picks "beside it": the camera is a tile for the watcher and first in the publisher\'s strip; "on the screen" brings the box back where it was', async () => {
    await pub.click('#camera-beside');
    await waitOverlay(pub, null, 2000);
    await pub.waitForSelector('#camera-tile', { timeout: 2000 });
    expect(await pub.$eval('#screens', (s) => s.firstElementChild?.id === 'camera-tile'), 'the camera tile is not first in the strip');
    expect((await trackId(pub, '#camera-tile-video')) === track.pubCamera, 'the camera tile does not play the camera');
    expect(await pub.$eval('#camera-size', (i) => i.disabled), 'the size dial is enabled with the camera beside the screen');
    await waitTiles(w, [CAMERA]);
    await waitOverlay(w, null, 2000);
    expect((await trackId(w, '#tile-0-video')) === track.camera, 'the tile does not play the camera track');
    expect((await trackId(w, '#video')) === track.screen1, 'the big picture changed');
    await pub.click('#camera-over');
    const mine = await waitOverlay(pub, SIZED, 2000);
    await pub.waitForSelector('#camera-tile', { state: 'detached', timeout: 2000 });
    const theirs = await waitOverlay(w, SIZED, 5000);
    await waitTiles(w, []);
    return `back to mine ${fmt(mine)} · theirs ${fmt(theirs)}`;
  });

  await step('publisher shares a second screen: "screen 2", a tile for the watcher, the first screen stays big with the camera over it', async () => {
    await pub.click('#share-screen');
    await pub.waitForSelector('#screen-1', { timeout: 10000 });
    const label = (await pub.textContent('#screen-1 span')).trim();
    expect(label === 'screen 2', `the second tile is labelled "${label}"`);
    expect((await trackId(pub, '#preview')) !== track.pubCamera, 'the preview went back to the camera');
    await waitTiles(w, [SCREEN2]);
    track.screen2 = await trackId(w, '#tile-2-video');
    expect(track.screen2 && ![track.camera, track.screen1].includes(track.screen2), 'the second screen tile plays a track seen before');
    expect((await trackId(w, '#video')) === track.screen1, 'the big picture changed although the first screen was chosen');
    expect(near(await overlay(w), SIZED), 'the camera box moved');
    const flow = await framesFlow(w, '#tile-2-video');
    const n = await flowingVideos(w);
    expect(n === 3, `${n} video streams flowing, not 3`);
    return flow;
  });

  await step('a watcher arriving now: the first screen big, the camera over it where it was put, the second screen a tile, three streams', async () => {
    const late = await newWatcher();
    await late.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(late, /^watching$/);
    await waitTiles(late, [SCREEN2]);
    const box = await waitOverlay(late, SIZED, 5000);
    const ids = [await trackId(late, '#video'), await trackId(late, '#camera-overlay-video'), await trackId(late, '#tile-2-video')];
    expect(ids.every(Boolean) && new Set(ids).size === 3, `the three videos do not play three tracks: ${JSON.stringify(ids)}`);
    const flow = `${await framesFlow(late, '#video')} · ${await framesFlow(late, '#camera-overlay-video')} · ${await framesFlow(late, '#tile-2-video')}`;
    const n = await flowingVideos(late);
    expect(n === 3, `${n} video streams flowing, not 3`);
    await late.context().close();
    return `${fmt(box)} · ${flow}`;
  });

  await step('publisher stops the first screen: its tile goes, the watcher gets the second screen big with the camera over it, no tiles', async () => {
    await pub.click('#stop-screen-0');
    await pub.waitForSelector('#screen-0', { state: 'detached', timeout: 5000 });
    expect((await pub.$('#screen-1')) !== null, 'the second tile went too');
    await waitTiles(w, []);
    await w.waitForFunction((id) => document.querySelector('#video')?.srcObject?.getVideoTracks()[0]?.id === id, track.screen2, { timeout: 5000 });
    expect(near(await overlay(w), SIZED), 'the camera box is not over the second screen');
    const flow = await framesFlow(w, '#video');
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return flow;
  });

  await step('publisher stops the stream: the watcher sees ended, the tiles, the layout row and the button are gone', async () => {
    await pub.click('#stop');
    await waitStatus(w, /ended/);
    await pub.waitForSelector('#screens', { state: 'detached', timeout: 5000 });
    expect((await pub.$('#layout')) === null, 'the layout row shows after stop');
    expect((await pub.$('#camera-overlay')) === null, 'the camera box shows after stop');
    expect((await pub.$('#share-screen')) === null, 'the share button shows after stop');
    await waitTiles(w, []);
    return 'ended';
  });

  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
