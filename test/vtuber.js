// The model as a face cam (docs/vtuber.md): on the go live page a streamer picks a 3d model (one
// of the site's demo models out of the bucket, or a file of their own), their browser
// reads their face from the camera and draws the model moving with it, and that drawing is sent
// where the camera's picture would go. To the box and to a watcher it is a camera.
//
// What is checked: the api's three routes for the demo models; the picker (the shelf as the api
// lists it, a file from the computer kept in this browser and put up nowhere, a bad file refused
// in words, the other sites it names as links); a file that is no vrm, a .glb or an .fbx out of
// another tool, worn by the names of its bones and its shapes, and refused in words when it has
// no head or keeps its pictures in other files; a model on its way on says how far along it is,
// on its card and over the preview;
// a demo model is downloaded once and kept in this browser (the picker says so, and the next
// pick and the next visit ask the server for nothing); the page says what of a model's face the
// reader can move, and offers the expressions switch only on a model with brows or a smile; the
// model's picture in the preview and, live, on a watcher's page; the rigging panel under the
// preview (the camera's picture with the reader's marks on it and the numbers they become, its
// eye, its fold, and its picture off the page before a shared screen could see it, before start
// and live, for as long as the screen is shared); the one rule, that the
// camera's own track goes to the face reader, is shown in the rigging panel and nowhere else on
// the page, and is in no sender, on a pick, on a reload with a model kept, and when the model's
// worker dies mid stream (mic only, never the camera); and that the way back to the camera asks
// first.
//
// Which picture is which is read off its corners: the model is drawn on a flat colour the
// streamer picks, and the test picks one no camera makes. The face reader's state and numbers
// are read off #face-status (data-face, data-reads, data-fps, ...), and the rigging's off
// #rig-marks (data-points, data-frames) and its bars, never off the picture.
// Chrome's fake camera has no face in it, so the reader says `no face in view`, its light beside
// the model's name is red, and the model moves on its own. FACE_CLIP=/path/to/a/face.mjpeg feeds
// it one, and then the numbers must move and the light is green.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node vtuber.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const NAME = 'vtubertest';
const FACE_CLIP = process.env.FACE_CLIP ? path.resolve(process.env.FACE_CLIP) : '';
// swiftshader: a machine with no gpu (a server running its own tests) still gets a webgl to draw the model with.
// no audio output: the mixer's meters are read off a web audio graph, which stands still on a machine whose
// speakers are asleep (a laptop with its screen off); a sink that plays to nobody keeps it running anywhere
// the screen that is shared for a moment is picked by chrome itself (as in screen.js)
const ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--ignore-certificate-errors',
  '--enable-unsafe-swiftshader',
  '--disable-audio-output',
  '--auto-select-desktop-capture-source=Entire screen'
];
if (FACE_CLIP) ARGS.push(`--use-file-for-fake-video-capture=${FACE_CLIP}`);
/** The file "from the computer": the smallest of the repo's demo models. */
const OWN_FILE = path.join(__dirname, '..', 'random-media', 'vrms', 'orion.vrm');
/**
 * A model that is no vrm, the kind of file another tool writes: a puppet made of boxes on a skeleton whose bones
 * are named the plain way (Head, Neck, Chest, LeftArm, ...), with two shapes (Blink, MouthOpen) and one small
 * picture for its colours. The same puppet as a glb, as an fbx with the picture inside it, and as an fbx with the
 * picture left outside. fixtures/puppet.py is the blender script that made all three.
 */
const PUPPET = {
  glb: path.join(__dirname, 'fixtures', 'puppet.glb'),
  fbx: path.join(__dirname, 'fixtures', 'puppet.fbx'),
  loose: path.join(__dirname, 'fixtures', 'puppet-loose.fbx')
};
const results = []; // 'pass' | 'fail' | 'skip'
// fn returns a string (shown after PASS) or { skip: 'why' } when it could not check anything
async function step(name, fn) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(6);
  try {
    const info = await fn();
    if (info && typeof info === 'object' && info.skip) {
      results.push('skip');
      console.log(`SKIP  ${name.padEnd(70)} ${ms()} ms  ${info.skip}`);
      return;
    }
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
/** The video track a <video> plays: its id, and its label (a camera's is the camera's name). */
const trackOf = (p, sel) =>
  p.$eval(sel, (v) => {
    const t = v.srcObject?.getVideoTracks()[0];
    return t ? { id: t.id, label: t.label } : null;
  });
/** A meter's bar over 1.5s: its peak and how many different readings it gave. The fake mic beeps about twice a second. */
async function meter(p, sel, ms = 1500) {
  const t0 = Date.now();
  const levels = new Set();
  let peak = 0;
  while (Date.now() - t0 < ms) {
    const now = Number(await p.getAttribute(sel, 'aria-valuenow'));
    levels.add(now);
    peak = Math.max(peak, now);
    await sleep(25);
  }
  return { peak, distinct: levels.size };
}
/** A layer of the frame is there (or, `there` false, is not). */
const waitLayer = (p, id, there = true, timeout = 10000) => p.waitForFunction(([id, there]) => !!document.getElementById(`layer-${id}`) === there, [id, there], { timeout });

// ---- which picture is it: the colour in its corners ----
/** The colour behind the model unless the streamer picks another (publish-atoms' default). */
const DARK = [0x18, 0x1b, 0x22];
/** The one this test picks: no camera's picture has it in both top corners. */
const MAGENTA = [255, 0, 255];
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const close = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** The colours at the two top corners and the middle of a <video>'s picture; null before its first frame. */
const colours = (p, sel) =>
  p.$eval(sel, (v) => {
    if (!v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0);
    const at = (x, y) => Array.from(ctx.getImageData(Math.round(c.width * x), Math.round(c.height * y), 1, 1).data.slice(0, 3));
    return { left: at(0.02, 0.03), right: at(0.98, 0.03), middle: at(0.5, 0.45) };
  });
/** The picture is a model drawn on `colour`: both top corners are it, and the middle (the face) is not. The codec moves a colour a little: `tol`. */
const isModelOn = (px, colour, tol = 40) => px !== null && close(px.left, colour, tol) && close(px.right, colour, tol) && !close(px.middle, colour, tol);
/** Until `sel` shows a model on `colour` (or, `model` false, until it shows something that is not one). */
async function waitPicture(p, sel, colour, model = true, timeout = 15000) {
  const t0 = Date.now();
  let px = null;
  while (Date.now() - t0 < timeout) {
    px = await colours(p, sel).catch(() => null);
    if (px !== null && isModelOn(px, colour) === model) return px;
    await sleep(200);
  }
  throw new Error(`${sel} ${model ? 'is not' : 'is still'} a model on ${hex(colour)}: its corners are ${JSON.stringify(px)}`);
}
const fmtPx = (px) => `corners ${hex(px.left)} ${hex(px.right)}, middle ${hex(px.middle)}`;

// ---- the face reader, off #face-status ----
const face = (p) => p.$eval('#face-status', (el) => ({ face: el.dataset.face, yaw: Number(el.dataset.yaw), pitch: Number(el.dataset.pitch), roll: Number(el.dataset.roll), mouth: Number(el.dataset.mouth), fps: Number(el.dataset.fps), reads: Number(el.dataset.reads), words: el.textContent.trim() }));
const waitFace = (p, state, timeout = 45000) => p.waitForFunction((state) => document.querySelector('#face-status')?.dataset.face === state, state, { timeout });
/**
 * The reader's light beside the model's name, as someone looking sees it, with the state it is for: which of
 * the theme's colours it is (`green`, `red`, or the css colour when neither) and the words that stand beside
 * it. Words kept for a screen reader alone have a box of one pixel, and are not counted.
 */
const light = (p) =>
  p.$eval('#face-status', (el) => {
    const theme = getComputedStyle(document.documentElement);
    const of = (name) => `rgb(${theme.getPropertyValue(name).trim().split(/\s+/).join(', ')})`;
    const colour = getComputedStyle(el.querySelector('#face-light')).backgroundColor;
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let shown = '';
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      const box = node.parentElement.getBoundingClientRect();
      if (box.width > 1 && box.height > 1) shown += node.textContent;
    }
    return { face: el.dataset.face, colour: colour === of('--increase') ? 'green' : colour === of('--decrease') ? 'red' : colour, shown: shown.trim() };
  });
/** A switch drawn as an icon (`aria-pressed`): pressed until it is on, or off. */
async function press(p, sel, on) {
  if ((await p.getAttribute(sel, 'aria-pressed')) !== String(on)) await p.click(sel);
  await p.waitForFunction(([sel, want]) => document.querySelector(sel)?.getAttribute('aria-pressed') === want, [sel, String(on)], { timeout: 5000 }).catch(() => {
    throw new Error(`${sel} is not ${on ? 'on' : 'off'} after a press`);
  });
}

// Before any of the page's code, on the publisher: every track a sender is given and every video
// track a <video> is given, by the label of what it came from. A camera's label is the camera's
// name; the model's track has another. `connected`: the <video> is on the page (the face
// reader's own, on a browser where the page feeds it, never is). What the rigging panel's
// <video> was playing (`rig`) at the two moments a share of this page could first carry it out:
// when the browser's picker hands a screen over (`__picked`), and when a track is given to a
// sender. And every step the two loading things went through (the picked card's veil, the
// preview's), as they went: a model out of this browser is on in under a second, faster than a
// test can look.
function recordTracks() {
  window.__sent = [];
  window.__shown = [];
  window.__picked = [];
  window.__loading = [];
  const rigPlays = () => document.querySelector('#rig-video')?.srcObject?.getVideoTracks()[0]?.label ?? null;
  const pick = navigator.mediaDevices?.getDisplayMedia;
  if (pick) {
    navigator.mediaDevices.getDisplayMedia = async function (...options) {
      const display = await pick.apply(this, options);
      // before the page hears of it: this runs first, the page's own `await` after
      window.__picked.push({ label: display.getVideoTracks()[0]?.label ?? null, rig: rigPlays() });
      return display;
    };
  }
  const noteLoading = () => {
    for (const [what, sel] of [['card', '#model-card-loading'], ['preview', '#model-loading']]) {
      const step = document.querySelector(sel)?.dataset.step;
      const line = `${what}:${step ?? 'gone'}`;
      const last = window.__loading.filter((l) => l.startsWith(`${what}:`)).pop();
      if (last !== line && (step || last)) window.__loading.push(line);
    }
  };
  new MutationObserver(noteLoading).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-step'] });
  const add = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
    if (typeof trackOrKind !== 'string') window.__sent.push({ how: 'addTransceiver', kind: trackOrKind.kind, label: trackOrKind.label, rig: rigPlays() });
    return add.call(this, trackOrKind, init);
  };
  const replace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    if (track) window.__sent.push({ how: 'replaceTrack', kind: track.kind, label: track.label, rig: rigPlays() });
    return replace.call(this, track);
  };
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() {
      return srcObject.get.call(this);
    },
    set(stream) {
      for (const t of stream?.getVideoTracks?.() ?? []) window.__shown.push({ el: this.id, label: t.label, connected: this.isConnected });
      srcObject.set.call(this, stream);
    }
  });
}
/**
 * Where the camera's own track went, on this page load: the senders that were given it (`sent`),
 * how many times the rigging panel's <video> was (`rig`: the one place its picture is shown),
 * and any other <video> on the page that was (`elsewhere`).
 */
const cameraWent = (p, label) =>
  p.evaluate((label) => {
    const shown = window.__shown.filter((s) => s.connected && s.label === label);
    return {
      sent: window.__sent.filter((s) => s.kind === 'video' && s.label === label),
      rig: shown.filter((s) => s.el === 'rig-video').length,
      elsewhere: shown.filter((s) => s.el !== 'rig-video'),
      senders: window.__sent.filter((s) => s.kind === 'video').length
    };
  }, label);
/** The rigging panel's marks: how many points it last drew, how many times it has drawn, how far its view is in on the face. */
const rigMarks = (p) => p.$eval('#rig-marks', (el) => ({ points: Number(el.dataset.points), frames: Number(el.dataset.frames), zoom: Number(el.dataset.zoom) }));
/** And its numbers, in the order they stand: the five bars (0 to 100), then the head's turn, nod and tilt in degrees. */
const rigNumbers = (p) =>
  p.evaluate(() => [
    ...['mouth', 'blink', 'smile', 'brows-up', 'brows-down'].map((id) => Number(document.querySelector(`#rig-${id}`).getAttribute('aria-valuenow'))),
    ...['turn', 'nod', 'tilt'].map((id) => Number(document.querySelector(`#rig-${id}`).dataset.value))
  ]);
/** The last screen the browser's picker handed over: its track's label, and what the rigging panel's <video> was playing at that moment (`rig`). */
const lastPick = (p) => p.evaluate(() => window.__picked[window.__picked.length - 1] ?? null);
/** The shared screen taken away again, if it is still there: a step that failed with it on would fail the steps after it for the wrong reason. */
const dropScreen = async (p) => {
  if ((await p.$('#source-remove-s1')) === null) return;
  await p.click('#source-remove-s1');
  await p.waitForSelector('#source-s1', { state: 'detached', timeout: 5000 });
};
/** Until the rigging panel's <video> plays `label`'s track, or (null) nothing at all. */
const waitRigPicture = (p, label, timeout = 10000) =>
  p.waitForFunction((label) => (document.querySelector('#rig-video')?.srcObject?.getVideoTracks()[0]?.label ?? null) === label, label, { timeout }).catch(() => {
    throw new Error(`the rigging panel's picture is not ${label === null ? 'gone' : `"${label}"`}`);
  });

/** The steps the two loading things went through since the last ask, each in order (`file`, `model`, `reader`, `gone`): `{ card, preview }`. */
const loadingSeen = (p) =>
  p.evaluate(() => {
    const seen = window.__loading.splice(0);
    const of = (what) => seen.filter((l) => l.startsWith(`${what}:`)).map((l) => l.split(':')[1]);
    return { card: of('card'), preview: of('preview') };
  });
/** They were shown, in the order a load goes, and are not shown any more. The reader's step is there only when the reader is slower than the model. */
const wentThrough = (steps) => ['file,model,gone', 'file,model,reader,gone'].includes(steps.join());
/** A demo model's file as the page asks for it: `/api/models/<id>`, with or without a `?v=`, and not its thumbnail. */
const isFileOf = (id) => (r) => new URL(r.url).pathname === `/api/models/${id}`;

/** A glb's bytes around `json`: the 12 byte header, then the json chunk, padded to four. */
function glb(json) {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(20 + body.length);
  out.writeUInt32LE(0x46546c67, 0); // "glTF"
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(body.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  body.copy(out, 20);
  return out;
}

(async () => {
  expect(fs.existsSync(OWN_FILE), `${OWN_FILE} is not there: the test wears one of the repo's demo models`);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  // a new context: nothing kept from an earlier run (the model, the colour, the shelf of kept files)
  const pubContext = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  await pubContext.addInitScript(recordTracks);
  // no name box on /live: a guest streams as the nick in the corner panel (localstorage, json the way jotai keeps it)
  await pubContext.addInitScript((n) => localStorage.setItem('nick', JSON.stringify(n)), NAME);
  /** Everything the publisher's pages ask for, to see that nothing is put up and nothing goes to another origin. */
  const asked = [];
  pubContext.on('request', (r) => asked.push({ method: r.method(), url: r.url() }));
  const pub = await pubContext.newPage();
  const w = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();

  /** The api's list of demo models, as step one read it, smallest first. */
  let demos = [];
  /**
   * The demo model the publisher wears: the second smallest, when there is more than one. The
   * smallest of the repo's own (orion) is the file the test also picks from the computer, and a
   * model with no face to move: the next one up has brows and a smile, and so the switch for them.
   */
  let wear = null;
  /** The camera's track as the page first had it: what must never be sent or shown while a model is on. */
  let camera = null;
  /** No webgl in this browser on this machine: nothing can draw a model, and the steps that need one say so. */
  let canDraw = true;
  const drawn = (fn) => () => (canDraw ? fn() : { skip: 'no webgl in this browser on this machine, so no model can be drawn' });
  /** The picker: from `another model` while one is on, else from the + and its `model`. */
  const openPicker = async () => {
    if ((await pub.$('#model-change')) !== null) await pub.click('#model-change');
    else {
      await pub.click('#add-source');
      await pub.click('#add-model');
    }
    await pub.waitForSelector('#model-dialog[open]', { timeout: 5000 });
  };
  const closePicker = async () => {
    await pub.click('#model-dialog-close');
    await pub.waitForSelector('#model-dialog', { state: 'detached', timeout: 5000 });
  };
  /** Until the model in the picker is on: the picker closes itself, and the controls are there. */
  const waitWorn = async () => {
    await pub.waitForSelector('#model-dialog', { state: 'detached', timeout: 90000 });
    await pub.waitForSelector('#model-controls', { timeout: 5000 });
  };

  await step('the api: the demo models are one list (a name, a licence, a size, a thumbnail), each file a glb, an unknown id a 404', async () => {
    const res = await pubContext.request.get(`${BASE}/api/models`);
    expect(res.status() === 200, `GET /api/models is ${res.status()}: this api is from before the demo models (./scripts/deploy.sh api)`);
    const list = (await res.json()).models;
    expect(Array.isArray(list), 'the answer has no models list');
    for (const m of list) {
      const ok = /^[a-z0-9_-]{1,48}$/.test(m.id) && typeof m.name === 'string' && m.name !== '' && ['0', '1'].includes(m.vrm) && m.bytes > 0 && /^[0-9a-f]{12}$/.test(m.v) && typeof m.thumb === 'boolean';
      expect(ok, `not a model's entry: ${JSON.stringify(m)}`);
    }
    for (const url of ['/api/models/no-such-model', '/api/models/no-such-model/thumb', '/api/models/NOT%20AN%20ID']) {
      const gone = await pubContext.request.get(`${BASE}${url}`);
      expect(gone.status() === 404, `GET ${url} is ${gone.status()}, not 404`);
    }
    demos = [...list].sort((a, b) => a.bytes - b.bytes);
    wear = demos[Math.min(1, demos.length - 1)] ?? null;
    if (!demos.length) return 'none in the bucket (./scripts/models.sh puts random-media/vrms there): the shelf is empty, the rest wears a file';
    const small = demos[0];
    const file = await pubContext.request.get(`${BASE}/api/models/${small.id}?v=${small.v}`);
    const body = await file.body();
    expect(file.status() === 200 && file.headers()['content-type'] === 'model/gltf-binary', `${small.id}: ${file.status()} ${file.headers()['content-type']}`);
    expect(body.length === small.bytes && body.subarray(0, 4).toString('latin1') === 'glTF', `${small.id}: ${body.length} bytes for the ${small.bytes} listed, starting ${body.subarray(0, 4).toString('latin1')}`);
    expect(/immutable/.test(file.headers()['cache-control'] || ''), `${small.id} is not kept by the browser: ${file.headers()['cache-control']}`);
    const pictured = demos.find((m) => m.thumb);
    if (pictured) {
      const thumb = await pubContext.request.get(`${BASE}/api/models/${pictured.id}/thumb?v=${pictured.v}`);
      expect(thumb.status() === 200 && /^image\/(jpeg|png|webp)$/.test(thumb.headers()['content-type'] || ''), `${pictured.id}'s thumbnail: ${thumb.status()} ${thumb.headers()['content-type']}`);
    }
    return `${demos.length} models: ${demos.map((m) => `${m.name} (${m.licence || 'no licence named'})`).join(', ')}`;
  });

  await step('publisher: /live opens with the camera, the + has `model`, and its picker shows the shelf as the api lists it', async () => {
    await pub.goto(`${BASE}/live`, { waitUntil: 'domcontentloaded' });
    await pub.waitForFunction(() => document.querySelector('#start')?.disabled === false);
    await pub.waitForFunction(() => document.querySelector('#preview')?.videoWidth > 0, null, { timeout: 15000 });
    camera = await trackOf(pub, '#preview');
    expect(camera && camera.label, `the preview plays ${JSON.stringify(camera)}`);
    expect((await pub.$('#model-controls')) === null, 'the face controls show with no model on');
    canDraw = await pub.evaluate(() => {
      try {
        return !!new OffscreenCanvas(8, 8).getContext('webgl2');
      } catch {
        return false;
      }
    });
    await openPicker();
    if (!demos.length) {
      await pub.waitForSelector('#model-demos-none', { timeout: 5000 });
      return `camera "${camera.label}"; the picker says there are no demo models here`;
    }
    await pub.waitForSelector('#model-demos li', { timeout: 5000 });
    const cards = await pub.$$eval('#model-demos button', (els) =>
      els.map((el) => ({ id: el.id.replace('model-demo-', ''), name: el.querySelector('span span')?.textContent.trim(), picture: !!el.querySelector('img'), kept: el.closest('li').dataset.kept }))
    );
    expect(cards.length === demos.length && demos.every((m) => cards.some((c) => c.id === m.id && c.name === m.name && c.picture === m.thumb)), `the cards are ${JSON.stringify(cards)}`);
    expect(cards.every((c) => c.kept === 'false'), `a new browser has a demo model downloaded already: ${JSON.stringify(cards)}`);
    await pub.waitForFunction(() => [...document.querySelectorAll('#model-demos img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    return `camera "${camera.label}"; ${cards.length} cards, their thumbnails drawn`;
  });

  await step('the picker names a few other sites that have models to download, each a link that opens in a tab of its own and is asked for nothing until it is clicked', async () => {
    const places = await pub.$$eval('#model-places a', (els) => els.map((a) => ({ name: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel })));
    expect(places.length >= 3, `the picker lists ${places.length} places`);
    for (const place of places) {
      const safe = /^https:\/\//.test(place.href) && place.target === '_blank' && /\bnoopener\b/.test(place.rel) && /\bnoreferrer\b/.test(place.rel);
      expect(safe, `not a link that leaves the way a link should: ${JSON.stringify(place)}`);
    }
    const hosts = places.map((place) => new URL(place.href).host);
    expect(!asked.some((r) => hosts.includes(new URL(r.url).host)), 'the page asked one of those sites for something with nobody clicking');
    return places.map((place) => place.name).join(', ');
  });

  await step('a file that is no model, and a model that points outside its own file, are each refused in words: nothing changes', async () => {
    const before = await trackOf(pub, '#preview');
    await pub.setInputFiles('#model-file', { name: 'notes.vrm', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a model') });
    await pub.waitForFunction(() => /not a \.vrm/.test(document.querySelector('#model-status')?.textContent || ''), null, { timeout: 5000 });
    const first = (await pub.textContent('#model-status')).trim();
    // a vrm by its own word, whose buffer is a url: drawing it would have this browser ask a stranger's server
    const calls = glb({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta: { name: 'calls home' } } }, buffers: [{ uri: 'https://example.com/model.bin', byteLength: 4 }] });
    await pub.setInputFiles('#model-file', { name: 'calls-home.vrm', mimeType: 'model/gltf-binary', buffer: calls });
    await pub.waitForFunction(() => /points outside/.test(document.querySelector('#model-status')?.textContent || ''), null, { timeout: 5000 });
    const second = (await pub.textContent('#model-status')).trim();
    expect((await pub.$('#model-dialog[open]')) !== null, 'the picker closed on a refused file');
    expect((await trackOf(pub, '#preview')).id === before.id && (await pub.$('#model-controls')) === null, 'something changed on the stream');
    expect(!asked.some((r) => r.url.includes('example.com')), 'the page asked example.com for the model\'s buffer');
    return `"${first}" · "${second}"`;
  });

  await step('a .glb with nothing called a head, and an .fbx whose pictures are in other files, are each refused in words, and neither is kept', async () => {
    const before = await trackOf(pub, '#preview');
    // a glb with no vrm in it is a model by the names of its bones, and this one is a cube with no bone at all
    const cube = glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Cube' }] });
    await pub.setInputFiles('#model-file', { name: 'cube.glb', mimeType: 'model/gltf-binary', buffer: cube });
    await pub.waitForFunction(() => /nothing called a head/.test(document.querySelector('#model-status')?.textContent || ''), null, { timeout: 5000 });
    const first = (await pub.textContent('#model-status')).trim();
    // only the one file is picked: an fbx that names its pictures by where they were on its maker's disk would be drawn bare
    await pub.setInputFiles('#model-file', PUPPET.loose);
    await pub.waitForFunction(() => /pictures in other files/.test(document.querySelector('#model-status')?.textContent || ''), null, { timeout: 5000 });
    const second = (await pub.textContent('#model-status')).trim();
    expect((await pub.$('#model-dialog[open]')) !== null, 'the picker closed on a refused file');
    expect((await trackOf(pub, '#preview')).id === before.id && (await pub.$('#model-controls')) === null, 'something changed on the stream');
    expect((await pub.$$('#model-kept button[id^="model-kept-"]')).length === 0, 'a refused file is on the shelf');
    return `"${first}" · "${second}"`;
  });

  await step(
    'a model is picked: its card and the preview say how far along it is, then its picture takes the camera\'s place, 1280 wide, on the colour behind it',
    drawn(async () => {
      await loadingSeen(pub);
      if (wear) await pub.click(`#model-demo-${wear.id}`);
      else await pub.setInputFiles('#model-file', OWN_FILE);
      await waitWorn();
      const { card, preview: over } = await loadingSeen(pub);
      expect(wentThrough(over), `over the preview the loading went ${over.join(' > ') || 'unseen'}`);
      // a demo model has its card from the start; a file from the computer gets one only once it is kept
      if (wear) expect(wentThrough(card), `on its card the loading went ${card.join(' > ') || 'unseen'}`);
      await pub.waitForFunction((id) => document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.id !== id && document.querySelector('#preview').videoWidth === 1280, camera.id, { timeout: 15000 });
      const now = await trackOf(pub, '#preview');
      expect(now.label !== camera.label, `the preview still plays the camera ("${now.label}")`);
      const px = await waitPicture(pub, '#preview', DARK);
      const name = (await pub.textContent('#model-name')).trim();
      expect(name === (wear ? wear.name : 'Orion'), `the model is called "${name}"`);
      await waitStatus(pub, /^model ready$/);
      const kept = JSON.parse(await pub.evaluate(() => localStorage.getItem('settings.model')));
      expect(kept && kept.name === name, `kept for next time: ${JSON.stringify(kept)}`);
      return `loading ${over.join(' > ')} · ${name} · ${fmtPx(px)} · ${await framesFlow(pub, '#preview')}`;
    })
  );

  await step(
    'the page says what of this model a face moves, and has the expressions switch only where there are brows or a smile to move',
    drawn(async () => {
      const rig = await pub.$eval('#model-rig', (el) => ({ kind: el.dataset.kind, parts: el.dataset.parts.split(' ').filter(Boolean), words: el.textContent.trim() }));
      expect(['arkit', 'shapes', 'presets', 'none'].includes(rig.kind) && rig.words !== '', `the model's face is ${JSON.stringify(rig)}`);
      expect((await pub.getAttribute('#face-status', 'data-rig')) === rig.kind, 'the face status names another kind of face');
      const moods = rig.parts.includes('brows') || rig.parts.includes('smile');
      expect(((await pub.$('#face-expressions')) !== null) === moods, `the expressions switch is ${moods ? 'missing' : 'there with nothing to switch'}: ${JSON.stringify(rig)}`);
      if (!moods) return `${rig.kind}: "${rig.words}", no switch`;
      await press(pub, '#face-expressions', false);
      expect((await pub.evaluate(() => localStorage.getItem('settings.faceExpressions'))) === 'false', 'the switch is not kept');
      await press(pub, '#face-expressions', true);
      expect((await pub.evaluate(() => localStorage.getItem('settings.faceExpressions'))) === 'true', 'the switch is not kept');
      return `${rig.kind}: "${rig.words}", the switch off and on again`;
    })
  );

  await step(
    FACE_CLIP
      ? 'the face reader finds the face in the clip, the head and the mouth it reads move, and the light beside the name is green and wordless'
      : 'the face reader is up and reading frames: no face in the fake camera, so a red light that says `no face`, and a model that moves on its own',
    drawn(async () => {
      await waitFace(pub, FACE_CLIP ? 'on' : 'lost');
      const seen = new Set();
      let mouth = 0;
      let last = await face(pub);
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        last = await face(pub);
        seen.add(`${last.yaw},${last.pitch},${last.roll}`);
        mouth = Math.max(mouth, last.mouth);
      }
      expect(last.reads >= 5, `the reader reads ${last.reads} frames a second`);
      expect(last.fps >= 15, `the model is drawn ${last.fps} times a second`);
      if (FACE_CLIP) expect(seen.size >= 3, `the head did not move in 6 s: ${[...seen].join(' ')}`);
      else expect(last.face === 'lost' && last.yaw === 0 && last.mouth === 0, `with no face the reader says ${JSON.stringify(last)}`);
      // the light goes by the state it was read with: a clip's face can be out of view for a moment
      const lit = await light(pub);
      expect(lit.face === 'on' || lit.face === 'lost', `the reader went ${lit.face}`);
      const want = lit.face === 'on' ? { colour: 'green', shown: '' } : { colour: 'red', shown: 'no face' };
      expect(lit.colour === want.colour && lit.shown === want.shown, `${lit.face}: the light is ${lit.colour} and says "${lit.shown}", not ${want.colour} and "${want.shown}"`);
      return `"${last.words}" · a ${lit.colour} light${lit.shown ? ` that says "${lit.shown}"` : ''} · drawn ${last.fps}/s, read ${last.reads}/s${FACE_CLIP ? ` · ${seen.size} head poses in 6 s, the mouth up to ${mouth}%` : ''}`;
    })
  );

  await step(
    FACE_CLIP
      ? "the rigging, under the preview: the camera's picture with the reader's marks on the face and the numbers moving, an eye for the marks alone, a fold"
      : "the rigging, under the preview: the camera's picture with no face to mark and the numbers at rest, an eye for the marks alone, a fold",
    drawn(async () => {
      await pub.waitForSelector('#rig-body', { timeout: 5000 });
      const boxes = await pub.evaluate(() => {
        const box = (sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        return { scene: box('#scene'), rig: box('#rig') };
      });
      expect(boxes.rig.top >= boxes.scene.bottom && Math.abs(boxes.rig.left - boxes.scene.left) <= 1 && Math.abs(boxes.rig.right - boxes.scene.right) <= 1, `the rigging is not under the preview: ${JSON.stringify(boxes)}`);
      // its picture is the camera's own: the one place on the page that has it
      await waitRigPicture(pub, camera.label);
      await pub.waitForFunction(() => document.querySelector('#rig-video').videoWidth > 0, null, { timeout: 10000 });
      let said;
      if (FACE_CLIP) {
        await pub.waitForFunction(() => Number(document.querySelector('#rig-marks')?.dataset.points) > 400, null, { timeout: 20000 });
        const a = await rigMarks(pub);
        const seen = new Set();
        for (let i = 0; i < 12; i++) {
          await sleep(250);
          seen.add((await rigNumbers(pub)).join());
        }
        const b = await rigMarks(pub);
        expect(b.frames - a.frames >= 15, `the marks were drawn ${b.frames - a.frames} times in 3 s`);
        expect(seen.size >= 3, `the numbers did not move in 3 s: ${[...seen].join(' | ')}`);
        said = `${b.points} points on the face, drawn ${b.frames - a.frames} times in 3 s, the numbers read ${seen.size} ways, the view ${b.zoom} times in on the face`;
      } else {
        await pub.waitForFunction(() => document.querySelector('#rig-words')?.textContent === 'no face in view', null, { timeout: 20000 });
        const marks = await rigMarks(pub);
        const numbers = await rigNumbers(pub);
        expect(marks.points === 0 && marks.zoom === 1 && numbers.every((n) => n === 0), `with no face the rigging draws ${marks.points} points, ${marks.zoom} times in, and says ${numbers.join()}`);
        said = '"no face in view", no points, every number at rest, the whole frame';
      }
      // the eye: the marks alone, and the camera in no <video> at all. kept
      await press(pub, '#rig-picture', false);
      await waitRigPicture(pub, null);
      expect((await pub.evaluate(() => localStorage.getItem('settings.rigPicture'))) === 'false', 'the eye is not kept');
      await press(pub, '#rig-picture', true);
      await waitRigPicture(pub, camera.label);
      // folded, nothing of it is on the page, and it stays folded
      await pub.click('#rig-toggle');
      await pub.waitForSelector('#rig-body', { state: 'detached', timeout: 5000 });
      expect(JSON.parse(await pub.evaluate(() => localStorage.getItem('settings.livePanels'))).rig === false, 'the fold is not kept');
      await pub.click('#rig-toggle');
      await waitRigPicture(pub, camera.label);
      const went = await cameraWent(pub, camera.label);
      expect(went.sent.length === 0, `the camera's track went to a sender: ${JSON.stringify(went.sent)}`);
      return `${said} · "${(await pub.textContent('#rig-note')).trim()}"`;
    })
  );

  await step(
    "a screen is shared: the rigging's picture is off the page before the browser hands the screen over, and for as long as it is shared, so a share of this page cannot carry the camera out; then it is back",
    drawn(async () => {
      await pub.click('#add-source');
      if ((await pub.$('#add-screen')) === null) {
        await pub.keyboard.press('Escape');
        return { skip: 'this browser shares no screens' };
      }
      await pub.click('#add-screen');
      await pub.waitForSelector('#source-s1', { timeout: 10000 });
      let note;
      try {
        // gone when the picker handed the screen over, not once the page had it among its sources: a share sees the page from then
        const picked = await lastPick(pub);
        expect(picked && picked.rig === null, `when the picker handed the screen over the rigging panel was playing ${JSON.stringify(picked)}`);
        await waitRigPicture(pub, null);
        note = (await pub.textContent('#rig-note')).trim();
        expect(/hidden while you share a screen/.test(note), `the rigging says "${note}"`);
        expect(await pub.$eval('#rig-picture', (b) => b.disabled && b.getAttribute('aria-pressed') === 'false'), 'the eye still takes a press, or says it is on');
      } finally {
        await dropScreen(pub);
      }
      await waitRigPicture(pub, camera.label);
      // the model is the whole picture again, as it was
      await waitPicture(pub, '#preview', DARK);
      return `"${note}"`;
    })
  );

  await step(
    'a demo model is downloaded once: the picker says so, and a reload opens it out of this browser, with the server asked for nothing',
    drawn(async () => {
      if (!wear) return { skip: 'no demo models in the bucket' };
      const worn = wear;
      const asks = () => asked.filter(isFileOf(worn.id)).length;
      // one by the page for the pick (step one's own check of the file was the test's, not the page's)
      const before = asks();
      await openPicker();
      await pub.waitForFunction((id) => document.querySelector(`#model-demo-${id}`)?.closest('li').dataset.kept === 'true', worn.id, { timeout: 10000 });
      const line = await pub.$eval(`#model-demo-${worn.id}`, (el) => el.querySelector(':scope > span:last-child > span:last-child').textContent);
      expect(/downloaded$/.test(line), `its card says "${line}"`);
      await closePicker();
      await pub.reload({ waitUntil: 'domcontentloaded' });
      await pub.waitForSelector('#model-controls', { timeout: 90000 });
      await waitStatus(pub, /^model ready$/);
      expect((await pub.textContent('#model-name')).trim() === worn.name, `the model is called "${await pub.textContent('#model-name')}"`);
      expect(asks() === before, `the page asked the server for the file ${asks() - before} more time(s)`);
      const { preview: over } = await loadingSeen(pub);
      expect(wentThrough(over), `over the preview the loading went ${over.join(' > ') || 'unseen'}`);
      await waitPicture(pub, '#preview', DARK);
      return `"${line}" · after the reload: loading ${over.join(' > ')}, ${asks() - before} requests for the file`;
    })
  );

  await step(
    'a .glb with no vrm in it, then an .fbx: each is a model by the names of its bones and its shapes, worn, kept, and forgotten again from its ×',
    drawn(async () => {
      const said = [];
      for (const file of [PUPPET.glb, PUPPET.fbx]) {
        const was = await trackOf(pub, '#preview');
        await openPicker();
        await pub.setInputFiles('#model-file', file);
        await waitWorn();
        await pub.waitForFunction((id) => document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.id !== id, was.id, { timeout: 15000 });
        // neither kind of file has a name for its model in it: it goes by its file's
        expect((await pub.textContent('#model-name')).trim() === 'puppet', `the model is called "${await pub.textContent('#model-name')}"`);
        // its head is the bone called Head, and its blink and its mouth are the shapes called Blink and MouthOpen
        const rig = await pub.$eval('#model-rig', (el) => ({ kind: el.dataset.kind, parts: el.dataset.parts }));
        expect(rig.kind === 'presets' && rig.parts === 'blink mouth', `${path.basename(file)}: the page says its face is ${JSON.stringify(rig)}`);
        const px = await waitPicture(pub, '#preview', DARK);
        said.push(`${path.basename(file)}: ${rig.parts}, ${fmtPx(px)}`);
      }
      // both are on the shelf, and the × on a card takes its file out of this browser. the one that is on stays on
      await openPicker();
      const kept = await pub.$$eval('#model-kept button[id^="model-kept-"]', (els) =>
        els.filter((el) => el.querySelector('span span')?.textContent.trim() === 'puppet').map((el) => el.id.replace('model-kept-', ''))
      );
      expect(kept.length === 2, `the shelf has ${kept.length} puppets, not the glb and the fbx`);
      for (const id of kept) {
        await pub.hover(`#model-kept-${id}`);
        await pub.click(`#model-forget-${id}`);
        await pub.waitForSelector(`#model-kept-${id}`, { state: 'detached', timeout: 5000 });
      }
      await closePicker();
      expect((await pub.$('#model-controls')) !== null, 'forgetting the file took the model off');
      return said.join(' · ');
    })
  );

  await step(
    'a .vrm from the computer: read here, worn, kept on this browser\'s shelf, and put up nowhere',
    drawn(async () => {
      const before = asked.length;
      const was = await trackOf(pub, '#preview');
      await openPicker();
      await pub.setInputFiles('#model-file', OWN_FILE);
      await waitWorn();
      await pub.waitForFunction((id) => document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.id !== id, was.id, { timeout: 15000 });
      expect((await pub.textContent('#model-name')).trim() === 'Orion', `the model is called "${await pub.textContent('#model-name')}"`);
      const sent = asked.slice(before).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');
      expect(sent.length === 0, `the pick sent ${sent.map((r) => `${r.method} ${r.url}`).join(', ')}`);
      const kept = JSON.parse(await pub.evaluate(() => localStorage.getItem('settings.model')));
      expect(kept && kept.kind === 'kept', `kept for next time: ${JSON.stringify(kept)}`);
      await openPicker();
      const shelf = await pub.$$eval('#model-kept button[id^="model-kept-"]', (els) => els.map((el) => ({ name: el.querySelector('span span')?.textContent.trim(), on: el.getAttribute('aria-pressed') })));
      expect(shelf.length === 1 && shelf[0].name === 'Orion' && shelf[0].on === 'true', `the shelf is ${JSON.stringify(shelf)}`);
      await closePicker();
      return `${fs.statSync(OWN_FILE).size} bytes read in the page, no request but GETs`;
    })
  );

  await step(
    'the colour behind it: picked, it is the picture\'s corners at once, and kept; mirror and rest face are kept and taken',
    drawn(async () => {
      await pub.fill('#model-background', hex(MAGENTA));
      const px = await waitPicture(pub, '#preview', MAGENTA, true, 5000);
      await press(pub, '#face-mirror', false);
      await pub.click('#face-rest');
      const kept = await pub.evaluate(() => ({ colour: localStorage.getItem('settings.modelBackground'), mirror: localStorage.getItem('settings.faceMirror') }));
      expect(kept.colour === JSON.stringify('#ff00ff') && kept.mirror === 'false', `kept: ${JSON.stringify(kept)}`);
      await press(pub, '#face-mirror', true);
      expect((await pub.$('#model-controls')) !== null, 'the model went');
      // the worker says how it is doing twice a second, and this model has only just gone on
      await pub.waitForFunction(() => Number(document.querySelector('#face-status')?.dataset.fps) >= 15, null, { timeout: 5000 }).catch(() => {
        throw new Error('the model is not being drawn');
      });
      return fmtPx(px);
    })
  );

  await step(
    `start as ${NAME}: live with the model and the mic, and /watch/${NAME} plays the model's picture where a camera's would be, with the sound`,
    drawn(async () => {
      await pub.click('#start');
      await waitStatus(pub, /^live$/);
      // the model took the picture's place, not the mic's: the mixer's mic bar moves with the fake mic
      await pub.waitForSelector('#level-mic', { timeout: 5000 });
      const mic = await meter(pub, '#level-mic');
      expect(mic.peak > 0 && mic.distinct > 3, `the mic does not move with a model on: ${JSON.stringify(mic)}`);
      await w.goto(`${BASE}/watch/${NAME}`, { waitUntil: 'domcontentloaded' });
      await waitStatus(w, /^watching$/);
      await waitLayer(w, 'cam');
      expect(await w.$eval('#layer-cam #video', () => true).catch(() => false), 'the camera layer does not hold #video');
      const px = await waitPicture(w, '#video', MAGENTA);
      const tracks = await w.$eval('#video', (v) => ({ video: v.srcObject?.getVideoTracks().length ?? 0, audio: v.srcObject?.getAudioTracks().length ?? 0 }));
      expect(tracks.video === 1 && tracks.audio === 1, `the watcher's stream is ${JSON.stringify(tracks)}`);
      return `${fmtPx(px)} · ${await framesFlow(w, '#video')} · the mic's bar up to ${mic.peak}%`;
    })
  );

  await step(
    "the one rule: the camera's own track went to no sender, and since the model went on it is in the rigging panel and in no other <video> on the page",
    drawn(async () => {
      const went = await cameraWent(pub, camera.label);
      expect(went.senders > 0, 'no video track was given to a sender at all');
      expect(went.sent.length === 0, `the camera's track went to a sender: ${JSON.stringify(went.sent)}`);
      expect(went.rig > 0, 'the rigging panel was never given the camera');
      // the page's own first look, before the model: the preview and the row's thumbnail. after it, of every <video> but the rigging panel's, none
      const after = await pub.evaluate((label) => {
        const others = window.__shown.filter((s) => s.el !== 'rig-video');
        const last = others.map((s) => s.label).lastIndexOf(label);
        return others.slice(last + 1).length;
      }, camera.label);
      expect(after > 0, "no <video> but the rigging panel's was given the model after the camera");
      const now = await trackOf(pub, '#preview');
      expect(now.label !== camera.label, 'the preview plays the camera');
      expect((await trackOf(pub, '#rig-video'))?.label === camera.label, 'the rigging panel does not play the camera');
      return `${went.senders} video track(s) given to senders, none "${camera.label}"; on the page it is the rigging panel's alone`;
    })
  );

  await step(
    "live, a screen is shared: the camera's picture is off the page before the screen's track is given to a sender; the screen stopped, it is back, and the watcher has the model",
    drawn(async () => {
      await pub.click('#add-source');
      if ((await pub.$('#add-screen')) === null) {
        await pub.keyboard.press('Escape');
        return { skip: 'this browser shares no screens' };
      }
      await waitRigPicture(pub, camera.label);
      const picks = await pub.evaluate(() => window.__picked.length);
      await pub.click('#add-screen');
      await pub.waitForSelector('#source-s1', { timeout: 10000 });
      let picked;
      let sent;
      try {
        picked = await lastPick(pub);
        expect((await pub.evaluate(() => window.__picked.length)) === picks + 1 && picked, 'the picker handed nothing over');
        expect(picked.rig === null, `when the picker handed the screen over the rigging panel was playing "${picked.rig}"`);
        // live, the screen's track goes into its sender before the page has the screen among its sources
        sent = await pub.evaluate((label) => window.__sent.filter((s) => s.kind === 'video' && s.label === label), picked.label);
        expect(sent.length > 0, `the screen's track ("${picked.label}") was given to no sender`);
        expect(sent.every((s) => s.rig === null), `the rigging panel was playing the camera when the screen's track was given to a sender: ${JSON.stringify(sent)}`);
      } finally {
        await dropScreen(pub);
      }
      await waitRigPicture(pub, camera.label);
      expect((await cameraWent(pub, camera.label)).sent.length === 0, 'the camera was sent');
      await waitLayer(w, 'cam');
      return `"${picked.label}" given to a sender ${sent.length} time(s), the rigging panel playing nothing each time · ${fmtPx(await waitPicture(w, '#video', MAGENTA))}`;
    })
  );

  await step(
    'live, `use the camera` asks first, and `no` leaves the model on for the watcher',
    drawn(async () => {
      await pub.click('#source-real-cam');
      await pub.waitForSelector('#real-camera-confirm', { timeout: 5000 });
      await pub.click('#real-camera-confirm-no');
      await pub.waitForSelector('#real-camera-confirm', { state: 'detached', timeout: 5000 });
      await sleep(1000);
      expect((await pub.$('#model-controls')) !== null, 'the model went');
      expect((await cameraWent(pub, camera.label)).sent.length === 0, 'the camera was sent');
      return fmtPx(await waitPicture(w, '#video', MAGENTA));
    })
  );

  await step(
    'live, the model\'s worker dies: mic only on both sides and said in words, never the camera, kept that way',
    drawn(async () => {
      const worker = pub.workers().find((x) => /face\.worker/.test(x.url()));
      expect(worker, `no face worker among ${pub.workers().map((x) => x.url()).join(' ') || 'no workers'}`);
      // an error nobody catches, in the worker: the page hears of it as the worker's `error`
      await worker.evaluate(() => {
        setTimeout(() => {
          throw new Error('the test pulled the plug');
        }, 0);
      });
      await pub.waitForFunction(() => /the model stopped/.test(document.querySelector('#source-status')?.textContent || ''), null, { timeout: 10000 });
      await pub.waitForSelector('#model-controls', { state: 'detached', timeout: 5000 });
      await waitLayer(pub, 'me');
      await waitLayer(pub, 'cam', false);
      await waitStatus(pub, /^live$/);
      await waitLayer(w, 'me');
      await waitLayer(w, 'cam', false);
      const went = await cameraWent(pub, camera.label);
      expect(went.sent.length === 0, `the camera's track went to a sender: ${JSON.stringify(went.sent)}`);
      const kept = await pub.evaluate(() => ({ model: localStorage.getItem('settings.model'), micOnly: localStorage.getItem('settings.micOnly') }));
      expect(kept.model === 'null' && kept.micOnly === 'true', `kept: ${JSON.stringify(kept)}`);
      return `"${(await pub.textContent('#source-status')).trim()}"`;
    })
  );

  await step(
    'live and mic only, the model back from its shelf: the watcher has its picture again',
    drawn(async () => {
      await openPicker();
      await pub.click('#model-kept button[id^="model-kept-"]');
      await waitWorn();
      await waitLayer(pub, 'cam');
      await waitLayer(w, 'cam');
      const px = await waitPicture(w, '#video', MAGENTA);
      expect((await cameraWent(pub, camera.label)).sent.length === 0, 'the camera was sent');
      return `${fmtPx(px)} · ${await framesFlow(w, '#video')}`;
    })
  );

  await step(
    "stop, then a reload with the model kept: the model is what opens, and the camera is in no <video> on the page but the rigging panel's",
    drawn(async () => {
      await pub.click('#stop');
      await waitStatus(w, /ended/);
      expect((await pub.$('#model-controls')) !== null, 'the model went with the stream');
      await pub.reload({ waitUntil: 'domcontentloaded' });
      await pub.waitForSelector('#model-controls', { timeout: 90000 });
      await waitStatus(pub, /^model ready$/);
      const { preview: over } = await loadingSeen(pub);
      expect(wentThrough(over), `over the preview the loading went ${over.join(' > ') || 'unseen'}`);
      const px = await waitPicture(pub, '#preview', MAGENTA);
      await waitRigPicture(pub, camera.label);
      const went = await cameraWent(pub, camera.label);
      expect(went.elsewhere.length === 0, `a <video> that is not the rigging panel's was given the camera's track: ${JSON.stringify(went.elsewhere)}`);
      const shown = await pub.evaluate(() => window.__shown.filter((s) => s.connected).length);
      expect(shown > 0, 'no <video> on the page was given anything');
      expect((await pub.textContent('#model-name')).trim() === 'Orion', `the model is called "${await pub.textContent('#model-name')}"`);
      return `${shown} video track(s) given to the page's <video>s, "${camera.label}" to the rigging panel's alone · ${fmtPx(px)}`;
    })
  );

  await step(
    'start after the reload: the watcher gets the model, and the camera\'s track has gone to no sender',
    drawn(async () => {
      await pub.waitForFunction(() => document.querySelector('#start')?.disabled === false);
      await pub.click('#start');
      await waitStatus(pub, /^live$/);
      await waitStatus(w, /^watching$/);
      const px = await waitPicture(w, '#video', MAGENTA);
      const went = await cameraWent(pub, camera.label);
      expect(went.senders > 0 && went.sent.length === 0, `senders were given ${went.senders} video track(s), the camera's among them ${went.sent.length} time(s)`);
      return fmtPx(px);
    })
  );

  await step(
    'live, `use the camera` and `yes`: now the watcher sees the camera\'s own picture, and the model is not kept',
    drawn(async () => {
      await pub.click('#source-real-cam');
      await pub.waitForSelector('#real-camera-confirm', { timeout: 5000 });
      await pub.click('#real-camera-confirm-yes');
      await pub.waitForFunction((label) => document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.label === label, camera.label, { timeout: 15000 });
      await pub.waitForSelector('#model-controls', { state: 'detached', timeout: 5000 });
      const px = await waitPicture(w, '#video', MAGENTA, false);
      const kept = await pub.evaluate(() => localStorage.getItem('settings.model'));
      expect(kept === 'null', `settings.model is ${kept}`);
      await waitStatus(pub, /^live$/);
      return fmtPx(px);
    })
  );

  await step('stop: the watcher sees ended, and nothing on the publisher\'s pages asked any other origin for anything', async () => {
    if ((await pub.$('#stop')) !== null) {
      await pub.click('#stop');
      await waitStatus(w, /ended/);
    }
    const origin = new URL(BASE).origin;
    const elsewhere = asked.filter((r) => /^https?:/.test(r.url) && new URL(r.url).origin !== origin);
    expect(elsewhere.length === 0, `${elsewhere.length} request(s) left the site: ${elsewhere.slice(0, 5).map((r) => r.url).join(' ')}`);
    return `${asked.length} requests, all to ${origin}`;
  });

  await browser.close();
  const failed = results.filter((r) => r === 'fail').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
