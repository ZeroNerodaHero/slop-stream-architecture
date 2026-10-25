// Screen sharing: a publisher shares screens beside the camera, one per press, into slots
// offered empty when going live, so nobody renegotiates. A watcher already watching gets the
// screen big and the camera as a tile; a tile clicked goes big; a second screen is a second
// tile; a screen stopped goes from every watcher; a watcher arriving mid-share sees it all at
// once. Chrome picks the screen on its own (--auto-select-desktop-capture-source). Which
// picture is where is read off the tiles (#tile-<slot>, the big one is the slot without a
// tile) and off track identity (a track that moves from a tile to #video is the same track);
// not off sizes, which the encoder changes with the bitrate.
// Run through ./test.sh, or: BASE_URL=https://<ip> node screen.js
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

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const pub = await (await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] })).newPage();
  const newWatcher = async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    await ctx.addInitScript(recordPeerConnections);
    return ctx.newPage();
  };
  const w = await newWatcher();
  /** The camera's and the screens' tracks as the watcher knows them, by slot, learnt as they show. */
  const track = {};

  await step(`publisher goes live as ${NAME}; the share button is there and enabled, no screens yet`, async () => {
    await pub.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await pub.fill('#name', NAME);
    await pub.waitForFunction(() => !document.querySelector('#start').disabled);
    expect((await pub.$('#share-screen')) === null, 'the share button shows before going live');
    await pub.click('#start');
    await waitStatus(pub, /^live$/);
    await pub.waitForFunction(() => document.querySelector('#share-screen') && !document.querySelector('#share-screen').disabled, null, { timeout: 5000 });
    expect((await pub.$('#screens')) === null, 'a screens strip shows with nothing shared');
    return 'live, #share-screen enabled';
  });

  await step(`watcher: /watch/${NAME} plays the camera big, no tiles, one video stream coming in`, async () => {
    await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(w, /^watching$/);
    await waitTiles(w, []);
    track.camera = await trackId(w, '#video');
    const flow = await framesFlow(w, '#video');
    const n = await flowingVideos(w);
    expect(n === 1, `${n} video streams flowing, not 1`);
    return flow;
  });

  await step('publisher shares a screen: a preview with its stop, labelled "screen"; the button stays enabled', async () => {
    await pub.click('#share-screen');
    await pub.waitForSelector('#screen-0', { timeout: 10000 });
    const label = (await pub.textContent('#screen-0 span')).trim();
    expect(label === 'screen', `the preview is labelled "${label}"`);
    expect((await pub.$('#stop-screen-0')) !== null, 'no stop on the preview');
    expect(!(await pub.$eval('#share-screen', (b) => b.disabled)), 'the share button went disabled with slots left');
    return await framesFlow(pub, '#screen-0-video');
  });

  await step('watcher, already watching: the screen goes big, the camera is a tile, the sound stays on the one <video>', async () => {
    await waitTiles(w, [CAMERA]);
    track.screen1 = await trackId(w, '#video');
    expect(track.screen1 && track.screen1 !== track.camera, `the big video still plays the camera's track`);
    expect((await trackId(w, '#tile-0-video')) === track.camera, 'the tile does not play the camera track');
    const big = await audioTracks(w, '#video');
    const tile = await audioTracks(w, '#tile-0-video');
    expect(big.tracks === 1, `the big video has ${big.tracks} audio tracks`);
    expect(tile.tracks === 0 && tile.muted, `the tile carries sound: ${JSON.stringify(tile)}`);
    const flow = `${await framesFlow(w, '#video')} · tile ${await framesFlow(w, '#tile-0-video')}`;
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return flow;
  });

  await step('watcher clicks the camera tile: the camera is big again and the screen is the tile, the same tracks swapped', async () => {
    await w.click('#tile-0');
    await waitTiles(w, [SCREEN1]);
    expect((await trackId(w, '#video')) === track.camera, 'the big video is not the camera track');
    expect((await trackId(w, '#tile-1-video')) === track.screen1, 'the tile is not the screen track');
    return await framesFlow(w, '#tile-1-video');
  });

  await step('publisher shares a second screen: "screen 2", a second tile for the watcher, the camera stays big as chosen', async () => {
    await pub.click('#share-screen');
    await pub.waitForSelector('#screen-1', { timeout: 10000 });
    const label = (await pub.textContent('#screen-1 span')).trim();
    expect(label === 'screen 2', `the second preview is labelled "${label}"`);
    await waitTiles(w, [SCREEN1, SCREEN2]);
    track.screen2 = await trackId(w, '#tile-2-video');
    expect(track.screen2 && ![track.camera, track.screen1].includes(track.screen2), 'the second screen tile plays a track seen before');
    expect((await trackId(w, '#video')) === track.camera, 'the big picture changed although the camera was chosen');
    const flow = await framesFlow(w, '#tile-2-video');
    const n = await flowingVideos(w);
    expect(n === 3, `${n} video streams flowing, not 3`);
    return flow;
  });

  await step('a watcher arriving now: the first screen big, the camera and the second screen as tiles, three streams', async () => {
    const late = await newWatcher();
    await late.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
    await waitStatus(late, /^watching$/);
    await waitTiles(late, [CAMERA, SCREEN2]);
    const ids = [await trackId(late, '#video'), await trackId(late, '#tile-0-video'), await trackId(late, '#tile-2-video')];
    expect(ids.every(Boolean) && new Set(ids).size === 3, `the three videos do not play three tracks: ${JSON.stringify(ids)}`);
    const flow = `${await framesFlow(late, '#video')} · ${await framesFlow(late, '#tile-0-video')} · ${await framesFlow(late, '#tile-2-video')}`;
    const n = await flowingVideos(late);
    expect(n === 3, `${n} video streams flowing, not 3`);
    await late.context().close();
    return flow;
  });

  await step('publisher stops the first screen: its preview goes, the watcher loses that tile and keeps the other', async () => {
    await pub.click('#stop-screen-0');
    await pub.waitForSelector('#screen-0', { state: 'detached', timeout: 5000 });
    expect((await pub.$('#screen-1')) !== null, 'the second preview went too');
    await waitTiles(w, [SCREEN2]);
    expect((await trackId(w, '#video')) === track.camera, 'the big picture changed');
    const flow = await framesFlow(w, '#tile-2-video');
    const n = await flowingVideos(w);
    expect(n === 2, `${n} video streams flowing, not 2`);
    return flow;
  });

  await step('publisher stops the stream: the watcher sees ended, the previews are gone, the button with them', async () => {
    await pub.click('#stop');
    await waitStatus(w, /ended/);
    await pub.waitForSelector('#screens', { state: 'detached', timeout: 5000 });
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
