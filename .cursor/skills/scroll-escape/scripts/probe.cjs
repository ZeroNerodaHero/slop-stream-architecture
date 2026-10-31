#!/usr/bin/env node
// Scroll-escape probe (../SKILL.md). Opens the site in headless chromium and, on every surface
// it is pointed at, looks for the three shapes of the bug that blanked the user modal:
//
//   escaped   an `absolute` box whose containing block is outside its scroll container. It does
//             not scroll with the pane, and it hangs out of whatever holds the scroller
//   overflow  an overflow-hidden box with scrollable overflow and a focusable inside: a focus
//             can scroll it, and nothing scrolls it back. What sticks out is listed
//   focus     a focusable whose focus() did scroll an overflow-hidden ancestor. The proof
//
// usage:  node probe.cjs [url] [step ...]
//   url             default http://localhost:42069 (`npm run dev` in frontend), or BASE_URL
//   step            a css selector to click (a js click, so a control hidden until hover works too),
//                   goto:<path>, or wait:<ms>. The page is audited at the start and after every step
//   LOGIN=name:pw   log in first through /login, the way test/*.js does, for the logged-in surfaces
//
// exit 1 when an escaped or focus finding came up. Playwright comes from test/node_modules
// (cd test && npm install).

const path = require('path');

const { chromium } = require(path.join(__dirname, '..', '..', '..', '..', 'test', 'node_modules', 'playwright'));

const args = process.argv.slice(2);
const base = (args[0] && /^https?:\/\//.test(args[0]) ? args.shift() : process.env.BASE_URL || 'http://localhost:42069').replace(/\/$/, '');
const steps = args;

/** Runs in the page. Self-contained: nothing from this file is in scope there. */
function audit() {
  const describe = (el) => {
    if (!el) return '(none)';
    if (el === document.documentElement) return 'html';
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    const attr = el.getAttribute('for') || el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('role');
    if (attr) s += `[${attr}]`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += `.${cls.slice(0, 3).join('.')}`;
    return s;
  };
  const style = (el) => getComputedStyle(el);
  const clips = (el) => {
    const cs = style(el);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  };
  const scrolls = (el) => {
    const cs = style(el);
    return /auto|scroll|hidden/.test(`${cs.overflowX} ${cs.overflowY}`);
  };
  const hidden = (el) => {
    const cs = style(el);
    return cs.overflowX === 'hidden' || cs.overflowY === 'hidden';
  };
  // what an absolute box is placed in: the nearest positioned ancestor, or one that transforms, filters, or contains
  const anchors = (el) => {
    const cs = style(el);
    return (
      cs.position !== 'static' ||
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.perspective !== 'none' ||
      /paint|layout|strict|content/.test(cs.contain) ||
      cs.willChange.includes('transform')
    );
  };
  const up = (el, test) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (test(p)) return p;
    return null;
  };
  const containingBlock = (el) => up(el, anchors) || document.documentElement;
  // tailwind's sr-only: absolute, 1px square, clipped away
  const srOnly = (el) => {
    const cs = style(el);
    return cs.position === 'absolute' && cs.width === '1px' && cs.height === '1px' && cs.clip === 'rect(0px, 0px, 0px, 0px)';
  };
  const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]';
  const focusable = (el) => el.matches(FOCUSABLE) && !el.disabled && !el.closest('[inert]') && !el.closest('dialog:not([open])');
  // a descendant `d` of `p` is clipped by `p`'s overflow unless it is absolute and placed above `p`
  const clippedBy = (d, p) => {
    if (!clips(p)) return false;
    if (style(d).position !== 'absolute') return true;
    const cb = containingBlock(d);
    return p === cb || p.contains(cb);
  };

  const all = [...document.body.querySelectorAll('*')];
  const findings = [];

  for (const el of all) {
    if (style(el).position !== 'absolute') continue;
    const scroller = up(el, scrolls);
    if (!scroller) continue;
    const cb = containingBlock(el);
    if (cb === scroller || scroller.contains(cb)) continue;
    findings.push({
      kind: 'escaped',
      el: describe(el),
      srOnly: srOnly(el),
      focusable: focusable(el),
      parent: describe(el.parentElement),
      parentPosition: style(el.parentElement).position,
      containingBlock: describe(cb),
      scroller: describe(scroller)
    });
  }

  for (const el of all) {
    if (!hidden(el)) continue;
    const dy = el.scrollHeight - el.clientHeight;
    const dx = el.scrollWidth - el.clientWidth;
    if (dy <= 1 && dx <= 1) continue;
    const inside = [...el.querySelectorAll(FOCUSABLE)].filter(focusable);
    if (inside.length === 0) continue;
    const box = el.getBoundingClientRect();
    const out = [];
    for (const d of el.querySelectorAll('*')) {
      const r = d.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const by = Math.max(r.bottom - box.bottom, box.top - r.top, r.right - box.right, box.left - r.left);
      if (by <= 1) continue;
      let clipped = false;
      for (let p = d.parentElement; p && p !== el; p = p.parentElement) {
        if (clippedBy(d, p)) {
          clipped = true;
          break;
        }
      }
      if (!clipped) out.push({ el: describe(d), by: Math.round(by) });
    }
    out.sort((a, b) => b.by - a.by);
    findings.push({ kind: 'overflow', el: describe(el), scrollable: { x: dx, y: dy }, focusablesInside: inside.length, stickingOut: out.slice(0, 5) });
  }

  for (const el of all) {
    if (!focusable(el)) continue;
    const ancestors = [];
    for (let p = el.parentElement; p; p = p.parentElement) if (hidden(p)) ancestors.push(p);
    if (ancestors.length === 0) continue;
    const before = ancestors.map((a) => [a.scrollTop, a.scrollLeft]);
    el.focus();
    const moved = ancestors
      .map((a, i) => ({ a, dy: a.scrollTop - before[i][0], dx: a.scrollLeft - before[i][1] }))
      .filter((m) => m.dx !== 0 || m.dy !== 0);
    ancestors.forEach((a, i) => {
      a.scrollTop = before[i][0];
      a.scrollLeft = before[i][1];
    });
    el.blur();
    for (const m of moved) findings.push({ kind: 'focus', el: describe(el), scrolled: describe(m.a), by: { x: m.dx, y: m.dy } });
  }

  return findings;
}

(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const settle = async () => {
    await page.waitForSelector('#root > *', { state: 'attached', timeout: 20000 });
    await page.waitForTimeout(600);
  };

  if (process.env.LOGIN) {
    const [name, ...rest] = process.env.LOGIN.split(':');
    await page.goto(`${base}/login`, { waitUntil: 'load' });
    await page.fill('#auth-name', name);
    await page.fill('#auth-password', rest.join(':'));
    await page.click('#auth-submit');
    await page.waitForFunction((n) => document.querySelector('#me')?.textContent === n, name, { timeout: 10000 });
  }
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await settle();

  let bad = 0;
  const run = async (label) => {
    const findings = await page.evaluate(audit);
    const counts = { escaped: 0, overflow: 0, focus: 0 };
    for (const f of findings) counts[f.kind] += 1;
    console.log(`\n== ${label}: ${findings.length === 0 ? 'clean' : `${counts.escaped} escaped, ${counts.overflow} overflow, ${counts.focus} focus`}`);
    for (const f of findings) console.log(`  ${JSON.stringify(f)}`);
    bad += counts.escaped + counts.focus;
  };

  await run(`${base}/`);
  for (const step of steps) {
    if (step.startsWith('goto:')) {
      await page.goto(base + step.slice(5), { waitUntil: 'load' });
      await settle();
    } else if (step.startsWith('wait:')) {
      await page.waitForTimeout(Number(step.slice(5)));
    } else {
      const there = await page.waitForSelector(step, { state: 'attached', timeout: 10000 }).catch(() => null);
      if (!there) {
        console.log(`\n== ${step}: not on the page, skipped`);
        continue;
      }
      await page.evaluate((s) => document.querySelector(s)?.click(), step);
      await page.waitForTimeout(500);
    }
    await run(step);
  }
  if (errors.length) console.log('\npage errors:', errors);
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
