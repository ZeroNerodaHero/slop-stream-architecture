#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..', '..');
const frontend = join(repo, 'frontend');
const harness = join(here, 'harness.tsx');
const playwright = createRequire(import.meta.url)(join(repo, 'test', 'node_modules', 'playwright'));
const { createServer } = await import(pathToFileURL(join(frontend, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);

const ENGINES = ['chromium', 'webkit', 'firefox'];
const ALIAS = { chrome: 'chromium', edge: 'chromium', safari: 'webkit' };
const asked = process.argv.slice(2).map((name) => ALIAS[name] ?? name);
const unknown = asked.filter((name) => !ENGINES.includes(name));
if (unknown.length) {
  console.error(`not an engine: ${unknown.join(', ')}. the engines: ${ENGINES.join(', ')}`);
  process.exit(2);
}
const engines = asked.length ? [...new Set(asked)] : ENGINES;
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : '';
if (shots) mkdirSync(shots, { recursive: true });

process.chdir(frontend);
process.env.BACKEND = 'http://127.0.0.1:1';
process.env.SHOW_DOCS = '0';
const scratch = mkdtempSync(join(tmpdir(), 'select-probe-'));
const PAGE = '/__select-probe';
const say = console.log;
console.log = () => {};
let server;
try {
  server = await createServer({
    root: frontend,
    cacheDir: join(scratch, 'vite'),
    logLevel: process.env.VERBOSE ? 'info' : 'error',
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { entries: [harness] },
    server: { host: '127.0.0.1', port: 42390, strictPort: false, watch: null, fs: { allow: [frontend, here, scratch] } },
    plugins: [
      {
        name: 'select-probe',
        configureServer(vite) {
          vite.middlewares.use(PAGE, async (_req, res) => {
            const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>select probe</title><link rel="icon" href="data:,"></head><body><div id="probe"></div><script type="module" src="/@fs${harness}"></script></body></html>`;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(await vite.transformIndexHtml(PAGE, page));
          });
        }
      }
    ]
  });
  await server.listen();
} finally {
  console.log = say;
}
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}`;

const results = [];
async function step(engine, name, fn) {
  try {
    const info = await fn();
    results.push('pass');
    console.log(`PASS  ${engine.padEnd(9)} ${name.padEnd(74)} ${info || ''}`);
  } catch (e) {
    results.push('fail');
    console.log(`FAIL  ${engine.padEnd(9)} ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const near = (a, b, by = 1.5) => Math.abs(a - b) <= by;
const j = (v) => JSON.stringify(v);

const look = (page, id) =>
  page.evaluate((id) => {
    const box = document.getElementById(id);
    const list = document.getElementById(`${id}-list`);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const rows = list ? [...list.children] : [];
    const spare = (li) => {
      const words = document.createRange();
      words.selectNodeContents(li.firstElementChild);
      return li.firstElementChild.getBoundingClientRect().width - words.getBoundingClientRect().width;
    };
    const last = rows[rows.length - 1];
    const mid = last && rect(last);
    return {
      role: box.getAttribute('role'),
      text: box.textContent.trim(),
      value: box.dataset.value,
      expanded: box.getAttribute('aria-expanded'),
      controls: box.getAttribute('aria-controls'),
      keysOn: box.getAttribute('aria-activedescendant'),
      focused: document.activeElement === box,
      focusOn: document.activeElement?.id || document.activeElement?.tagName.toLowerCase(),
      tabIndex: box.tabIndex,
      off: box.getAttribute('aria-disabled'),
      changes: Number(document.getElementById(`${id}-wrap`).dataset.changes),
      type: getComputedStyle(box).fontSize,
      box: rect(box),
      vw: document.documentElement.clientWidth,
      vh: document.documentElement.clientHeight,
      list: list && {
        ...rect(list),
        role: list.getAttribute('role'),
        in: list.parentElement === document.body ? 'body' : `${list.parentElement.tagName.toLowerCase()}#${list.parentElement.id}`,
        type: getComputedStyle(list).fontSize,
        values: rows.map((li) => li.dataset.value),
        on: rows.filter((li) => li.getAttribute('aria-selected') === 'true').map((li) => li.dataset.value),
        cannot: rows.filter((li) => li.getAttribute('aria-disabled') === 'true').map((li) => li.dataset.value),
        active: list.querySelector('[data-active]')?.dataset.value ?? null,
        activeId: list.querySelector('[data-active]')?.id ?? null,
        cut: rows.filter((li) => spare(li) < -0.5).map((li) => li.dataset.value),
        spare: Math.round(Math.min(...rows.map(spare)) * 10) / 10,
        inView: rows.filter((li) => rect(li).top >= rect(list).top - 0.5 && rect(li).bottom <= rect(list).bottom + 0.5).map((li) => li.dataset.value),
        scrolls: list.scrollHeight > list.clientHeight,
        scrollTop: list.scrollTop,
        topmost: !!last && list.contains(document.elementFromPoint((mid.left + mid.right) / 2, (mid.top + mid.bottom) / 2))
      }
    };
  }, id);
const option = (id, value) => `#${id}-list [data-value="${value}"]`;
const shut = (page, id) => page.waitForSelector(`#${id}-list`, { state: 'detached', timeout: 3000 });
const opened = (page, id) => page.waitForSelector(`#${id}-list`, { state: 'visible', timeout: 3000 });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const forgetTyping = (page) => page.waitForTimeout(650);

async function probe(engine, page, errors) {
  const s = (name, fn) => step(engine, name, fn);

  await s('the page has none of the browser pickers', async () => {
    const n = await page.evaluate(() => document.querySelectorAll('select, option, optgroup, datalist').length);
    expect(n === 0, `${n} of them on the page`);
  });

  await s('shut: a box that says the option that is on, and no list', async () => {
    const p = await look(page, 'plain');
    expect(p.role === 'combobox' && p.expanded === 'false' && !p.list, `role ${p.role}, expanded ${p.expanded}, a list ${!!p.list}`);
    expect(p.text === "the browser's camera" && p.value === '', `it says "${p.text}" (${j(p.value)})`);
    expect(p.tabIndex === 0, `tabIndex ${p.tabIndex}`);
  });

  await s('a click opens the list under the box, in the window, and the focus is on the box', async () => {
    await page.click('#plain');
    await opened(page, 'plain');
    const p = await look(page, 'plain');
    const l = p.list;
    expect(l.role === 'listbox' && l.in === 'body', `role ${l.role}, drawn into ${l.in}`);
    expect(p.expanded === 'true' && p.controls === 'plain-list', `expanded ${p.expanded}, controls ${p.controls}`);
    expect(j(l.values) === j(['', 'mac', 'honda', 'desk', 'honda-desk']), `the options ${j(l.values)}`);
    expect(j(l.on) === j(['']) && l.active === '' && p.keysOn === l.activeId, `on ${j(l.on)}, the keys on ${j(l.active)} (${p.keysOn} / ${l.activeId})`);
    expect(near(l.left, p.box.left) && near(l.top, p.box.bottom + 4), `the list at ${l.left},${l.top}; the box ${p.box.left},${p.box.bottom}`);
    expect(l.width >= p.box.width - 0.5, `the list ${l.width}px wide, the box ${p.box.width}px`);
    expect(l.left >= 4 && l.right <= p.vw - 4 + 0.5 && l.bottom <= p.vh - 4 + 0.5, `past the window: ${j(l)} in ${p.vw}x${p.vh}`);
    expect(l.cut.length === 0 && l.spare <= 1, `as wide as its longest option: words cut short ${j(l.cut)}, ${l.spare}px to spare`);
    expect(l.type === p.type, `the list's type is ${l.type}, the box's ${p.type}`);
    expect(l.topmost, 'something is drawn over the list');
    expect(p.focused, `the focus is on ${p.focusOn}`);
    if (shots) await page.screenshot({ path: join(shots, `open-${engine}.png`), clip: { x: 0, y: 0, width: 420, height: 190 } });
    return `${Math.round(l.width)}px wide under a ${Math.round(p.box.width)}px box`;
  });

  await s('a click on an option picks it, shuts the list, and leaves the focus on the box', async () => {
    await page.click(option('plain', 'honda'));
    await shut(page, 'plain');
    const p = await look(page, 'plain');
    expect(p.value === 'honda' && p.text === '1988 Honda Accord CA5 Sedan Camera', `it says "${p.text}" (${j(p.value)})`);
    expect(p.changes === 1, `${p.changes} picks said`);
    expect(p.focused && p.expanded === 'false', `the focus is on ${p.focusOn}, expanded ${p.expanded}`);
  });

  await s('the option that is on is the ticked one, and a click on it changes nothing', async () => {
    await page.click('#plain');
    await opened(page, 'plain');
    const p = await look(page, 'plain');
    expect(j(p.list.on) === j(['honda']) && p.list.active === 'honda', `on ${j(p.list.on)}, the keys on ${j(p.list.active)}`);
    expect(
      (await page.locator(`${option('plain', 'honda')} svg`).count()) === 1 && (await page.locator('#plain-list svg').count()) === 1,
      'the tick is not on the one that is on, alone'
    );
    await page.click(option('plain', 'honda'));
    await shut(page, 'plain');
    expect((await look(page, 'plain')).changes === 1, 'a pick of the one that is on was said');
  });

  await s('a press anywhere else shuts it, unchanged', async () => {
    await page.click('#plain');
    await opened(page, 'plain');
    await page.mouse.click(700, 400);
    await shut(page, 'plain');
    const p = await look(page, 'plain');
    expect(p.value === 'honda' && p.changes === 1, `it is ${j(p.value)} after ${p.changes} picks`);
  });

  await s('so does a press on something that takes no focus, and so does the focus leaving with no press', async () => {
    await page.click('#plain');
    await opened(page, 'plain');
    await page.click('#keeps-focus');
    await shut(page, 'plain');
    await page.click('#plain');
    await opened(page, 'plain');
    await page.focus('#before');
    await shut(page, 'plain');
    const p = await look(page, 'plain');
    expect(p.value === 'honda' && p.changes === 1, `it is ${j(p.value)} after ${p.changes} picks`);
  });

  await s('the tab key stops at it, as it does at a select', async () => {
    await page.focus('#before');
    await page.keyboard.press('Tab');
    const p = await look(page, 'plain');
    expect(p.focused, `tab from the box before it went to ${p.focusOn}`);
  });

  await s('tab on an open list picks the option the keys are on, and the focus moves on', async () => {
    await page.keyboard.press('ArrowDown');
    await opened(page, 'plain');
    await page.keyboard.press('ArrowDown');
    expect((await look(page, 'plain')).list.active === 'desk', 'the arrow did not go one down');
    await page.keyboard.press('Tab');
    await shut(page, 'plain');
    const p = await look(page, 'plain');
    expect(p.value === 'desk' && p.changes === 2, `it is ${j(p.value)} after ${p.changes} picks`);
    expect(p.focusOn === 'after', `the focus went to ${p.focusOn}`);
  });

  await s('arrows open it and walk it past what cannot be picked, stopping at the ends; enter picks', async () => {
    await page.focus('#keys');
    await page.keyboard.press('ArrowDown');
    await opened(page, 'keys');
    let k = await look(page, 'keys');
    expect(k.list.active === 'alpha' && k.value === 'alpha' && k.changes === 0, `opened on ${j(k.list.active)}, the value ${j(k.value)}`);
    expect(j(k.list.cannot) === j(['bravo']), `cannot be picked: ${j(k.list.cannot)}`);
    const walk = async (key, to) => {
      await page.keyboard.press(key);
      k = await look(page, 'keys');
      expect(k.list.active === to && k.keysOn === k.list.activeId, `${key} went to ${j(k.list.active)}, not ${to}`);
    };
    await walk('ArrowDown', 'charlie');
    await walk('ArrowUp', 'alpha');
    await walk('ArrowUp', 'alpha');
    await walk('End', 'echo');
    await walk('ArrowDown', 'echo');
    await walk('Home', 'alpha');
    await walk('ArrowDown', 'charlie');
    await page.keyboard.press('Enter');
    await shut(page, 'keys');
    k = await look(page, 'keys');
    expect(k.value === 'charlie' && k.changes === 1 && k.focused, `it is ${j(k.value)} after ${k.changes} picks, the focus on ${k.focusOn}`);
  });

  await s('space opens and picks; escape shuts it, unchanged', async () => {
    await page.keyboard.press('Space');
    await opened(page, 'keys');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await shut(page, 'keys');
    let k = await look(page, 'keys');
    expect(k.value === 'delta' && k.changes === 2, `space picked ${j(k.value)} (${k.changes} picks)`);
    await page.keyboard.press('Enter');
    await opened(page, 'keys');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await shut(page, 'keys');
    k = await look(page, 'keys');
    expect(k.value === 'delta' && k.changes === 2 && k.focused, `after escape it is ${j(k.value)} (${k.changes} picks), the focus on ${k.focusOn}`);
  });

  await s('letters typed go to the option that starts with them', async () => {
    const on = async () => (await look(page, 'keys')).list.active;
    await forgetTyping(page);
    await page.keyboard.press('e');
    await opened(page, 'keys');
    expect((await on()) === 'echo', `e went to ${j(await on())}`);
    await forgetTyping(page);
    await page.keyboard.press('d');
    expect((await on()) === 'delta', `d went to ${j(await on())}`);
    await page.keyboard.press('d');
    expect((await on()) === 'desk', `d again went to ${j(await on())}`);
    await page.keyboard.press('d');
    expect((await on()) === 'delta', `d a third time went to ${j(await on())}`);
    await forgetTyping(page);
    await page.keyboard.type('des');
    expect((await on()) === 'desk', `des went to ${j(await on())}`);
    await page.keyboard.press('Enter');
    await shut(page, 'keys');
    const k = await look(page, 'keys');
    expect(k.value === 'desk' && k.changes === 3, `it is ${j(k.value)} after ${k.changes} picks`);
    await forgetTyping(page);
    await page.keyboard.press('c');
    await opened(page, 'keys');
    expect((await on()) === 'charlie', `c from shut went to ${j(await on())}`);
    await page.keyboard.press('Escape');
    await shut(page, 'keys');
  });

  await s('a long list scrolls, opens on the option that is on, cuts no row short, and the keys win over a pointer at rest', async () => {
    await page.click('#long');
    await opened(page, 'long');
    let p = await look(page, 'long');
    expect(p.list.height <= 240.5 && p.list.scrolls, `${p.list.height}px tall, scrolls: ${p.list.scrolls}`);
    expect(p.list.active === 'n20' && p.list.inView.includes('n20'), `opened on ${j(p.list.active)}, in view ${j(p.list.inView)}`);
    expect(p.list.cut.length === 0 && p.list.spare <= 1, `words cut short ${j(p.list.cut)}, ${p.list.spare}px to spare`);
    const height = p.list.height;
    const row = await page.locator(option('long', p.list.inView[1])).boundingBox();
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2, { steps: 4 });
    const pointed = await look(page, 'long');
    expect(
      pointed.list.active === p.list.inView[1] && pointed.list.scrollTop === p.list.scrollTop,
      `the pointer on ${p.list.inView[1]}: the keys on ${j(pointed.list.active)}, scrolled ${p.list.scrollTop} -> ${pointed.list.scrollTop}`
    );
    await page.keyboard.press('End');
    await page.waitForTimeout(250);
    p = await look(page, 'long');
    expect(p.list.active === 'n30' && p.list.inView.includes('n30'), `end: on ${j(p.list.active)}, in view ${j(p.list.inView)}`);
    await page.keyboard.press('PageUp');
    p = await look(page, 'long');
    expect(p.list.active === 'n20' && p.list.inView.includes('n20'), `page up: on ${j(p.list.active)}, in view ${j(p.list.inView)}`);
    await page.keyboard.press('Home');
    p = await look(page, 'long');
    expect(p.list.active === 'n1' && p.list.scrollTop === 0, `home: on ${j(p.list.active)}, scrolled ${p.list.scrollTop}`);
    await page.keyboard.press('Escape');
    await shut(page, 'long');
    return `${Math.round(height)}px of 30 options`;
  });

  await s("at the window's foot the list opens over the box", async () => {
    await page.click('#foot');
    await opened(page, 'foot');
    const p = await look(page, 'foot');
    expect(near(p.list.bottom, p.box.top - 4) && p.list.top >= 4, `the list ${p.list.top}..${p.list.bottom}, the box from ${p.box.top}`);
    expect(p.list.topmost, 'something is drawn over the list');
    await page.keyboard.press('Escape');
    await shut(page, 'foot');
  });

  await s("at the window's edge the list stays in the window", async () => {
    await page.click('#edge');
    await opened(page, 'edge');
    const p = await look(page, 'edge');
    expect(p.list.right <= p.vw - 4 + 0.5 && p.list.left >= 4, `the list ${p.list.left}..${p.list.right} in a ${p.vw}px window`);
    expect(p.list.width > p.box.width && p.list.cut.length === 0, `${p.list.width}px wide for a ${p.box.width}px box, cut short: ${j(p.list.cut)}`);
    await page.keyboard.press('Escape');
    await shut(page, 'edge');
  });

  await s('a pane that scrolls does not clip the list, and the list follows its box through a scroll', async () => {
    await page.evaluate(() => {
      const pane = document.getElementById('pane');
      pane.scrollTop = 150;
    });
    await page.click('#paned');
    await opened(page, 'paned');
    let p = await look(page, 'paned');
    const pane = await page.evaluate(() => document.getElementById('pane').getBoundingClientRect().bottom);
    expect(
      p.list.in === 'body' && p.list.bottom > pane && p.list.topmost,
      `drawn into ${p.list.in}, down to ${p.list.bottom} (the pane ends at ${pane}), topmost: ${p.list.topmost}`
    );
    const before = p.list.top;
    await page.evaluate(() => {
      document.getElementById('pane').scrollTop += 10;
    });
    await settle(page);
    p = await look(page, 'paned');
    expect(
      near(p.list.top, before - 10) && near(p.list.top, p.box.bottom + 4),
      `the pane went 10px: the list from ${before} to ${p.list.top}, the box ends at ${p.box.bottom}`
    );
    await page.evaluate(() => window.scrollBy(0, 20));
    await settle(page);
    p = await look(page, 'paned');
    expect(near(p.list.top, before - 30) && near(p.list.top, p.box.bottom + 4), `the page went 20px: the list at ${p.list.top}, the box ends at ${p.box.bottom}`);
    await page.keyboard.press('Escape');
    await shut(page, 'paned');
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await s('in a modal dialog the list is drawn into the dialog, and escape shuts the list alone', async () => {
    await page.click('#open-dialog');
    await page.waitForSelector('#dialog[open]', { timeout: 3000 });
    try {
      await page.click('#dialoged');
      await opened(page, 'dialoged');
      let p = await look(page, 'dialoged');
      expect(p.list.in === 'dialog#dialog' && p.list.topmost, `drawn into ${p.list.in}, topmost: ${p.list.topmost}`);
      expect(near(p.list.left, p.box.left) && near(p.list.top, p.box.bottom + 4), `the list at ${p.list.left},${p.list.top}; the box ${p.box.left},${p.box.bottom}`);
      await page.keyboard.press('Escape');
      await shut(page, 'dialoged');
      expect(await page.evaluate(() => document.getElementById('dialog').open), 'escape shut the dialog with the list');
      await page.click('#dialoged');
      await opened(page, 'dialoged');
      await page.click(option('dialoged', 'echo'));
      await shut(page, 'dialoged');
      p = await look(page, 'dialoged');
      expect(p.value === 'echo' && p.changes === 1 && p.focused, `it is ${j(p.value)} after ${p.changes} picks, the focus on ${p.focusOn}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('dialog').open, null, { timeout: 3000 });
    } finally {
      await page.evaluate(() => document.getElementById('dialog').close());
    }
  });

  await s('one that is off takes no focus, no click and no key', async () => {
    const before = await look(page, 'off');
    expect(before.off === 'true' && before.tabIndex === -1, `aria-disabled ${before.off}, tabIndex ${before.tabIndex}`);
    await page.click('#off', { force: true });
    await page.waitForTimeout(100);
    const p = await look(page, 'off');
    expect(!p.list && !p.focused && p.expanded === 'false', `a list: ${!!p.list}, focused: ${p.focused}`);
  });

  await s('with none of the options on, the box says its placeholder and nothing is ticked', async () => {
    let p = await look(page, 'none');
    expect(p.text === 'pick a word', `it says "${p.text}"`);
    await page.click('#none');
    await opened(page, 'none');
    p = await look(page, 'none');
    expect(p.list.on.length === 0 && p.list.active === 'alpha', `on ${j(p.list.on)}, the keys on ${j(p.list.active)}`);
    await page.keyboard.press('Escape');
    await shut(page, 'none');
  });

  await s('nothing went wrong on the page', async () => {
    expect(errors.length === 0, errors.join('\n'));
  });
}

async function finger(engine, page) {
  await step(engine, 'under a finger, in a window as wide as a phone: a tap opens it, picks, and shuts it', async () => {
    await page.tap('#plain');
    await opened(page, 'plain');
    let p = await look(page, 'plain');
    expect(
      p.list.left >= 4 && p.list.right <= p.vw - 4 + 0.5 && p.list.topmost,
      `the list ${p.list.left}..${p.list.right} in a ${p.vw}px window, topmost: ${p.list.topmost}`
    );
    const row = await page.locator(option('plain', 'mac')).boundingBox();
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    expect(!coarse || row.height >= 30, `a row is ${row.height}px tall under a finger`);
    await page.tap(option('plain', 'mac'));
    await shut(page, 'plain');
    p = await look(page, 'plain');
    expect(p.value === 'mac' && p.changes === 1, `it is ${j(p.value)} after ${p.changes} picks`);
    await page.tap('#plain');
    await opened(page, 'plain');
    await page.touchscreen.tap(300, 560);
    await shut(page, 'plain');
    await page.tap('#long');
    await opened(page, 'long');
    p = await look(page, 'long');
    expect(p.list.left >= 4 && p.list.right <= p.vw - 4 + 0.5, `the long list ${p.list.left}..${p.list.right} in a ${p.vw}px window`);
    expect(j(p.list.cut) === j(['n12']), `cut short: ${j(p.list.cut)} (the list ${p.list.width}px wide in a ${p.vw}px window, ${p.list.spare}px to spare)`);
    await page.touchscreen.tap(300, 560);
    await shut(page, 'long');
    return `a row ${Math.round(row.height)}px tall${coarse ? '' : ' (this engine does not say the pointer is a finger)'}`;
  });
}

try {
  for (const engine of engines) {
    let browser;
    try {
      browser = await playwright[engine].launch({ headless: !process.env.HEADED, ...(engine === 'chromium' && { ignoreDefaultArgs: ['--hide-scrollbars'] }) });
    } catch (e) {
      results.push('fail');
      console.log(`FAIL  ${engine.padEnd(9)} could not start. cd test && npx playwright install ${engine}\n      ${String(e.message).split('\n')[0]}`);
      continue;
    }
    try {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(base + PAGE, { waitUntil: 'load' });
      await page.waitForSelector('#plain', { timeout: 30000 });
      await probe(engine, page, errors);
      const phone = await (await browser.newContext({ viewport: { width: 360, height: 700 }, hasTouch: true })).newPage();
      phone.setDefaultTimeout(5000);
      await phone.goto(base + PAGE, { waitUntil: 'load' });
      await phone.waitForSelector('#plain', { timeout: 30000 });
      await finger(engine, phone);
    } catch (e) {
      results.push('fail');
      console.log(`FAIL  ${engine.padEnd(9)} the page did not come up\n      ${String(e.message).split('\n')[0]}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}
const fails = results.filter((r) => r === 'fail').length;
console.log(`\n${fails ? 'FAIL' : 'PASS'}  ${results.length - fails}/${results.length} in ${engines.join(', ')}`);
process.exit(fails ? 1 : 0);
