const { chromium } = require('playwright');
const { execSync } = require('child_process');

const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const SOCKETS = process.env.RT_SOCKETS || '';
const ARGS = ['--ignore-certificate-errors'];
const RUN = Date.now() % 100000;
const ROOM = `rtpage${RUN}`;
const W = { timeout: 15000 };

let failed = 0;
let passed = 0;
async function step(name, fn) {
  const start = Date.now();
  try {
    const note = await fn();
    passed++;
    console.log(`PASS  ${name.padEnd(76)} ${String(Date.now() - start).padStart(5)} ms  ${note || ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name.padEnd(76)} ${String(Date.now() - start).padStart(5)} ms`);
    console.log(`      ${String(err && err.message ? err.message : err).split('\n')[0]}`);
  }
}

function expect(ok, why) {
  if (!ok) throw new Error(why);
}

async function joinAs(page, nick) {
  await page.waitForSelector('#chat-nick', W);
  await page.fill('#chat-nick', nick);
  await page.click('#chat-join');
  await page.waitForSelector('#chat-text', W);
  await page.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, W);
}

async function say(page, text) {
  await page.fill('#chat-text', text);
  await page.click('#chat-send');
}

const sees = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#chat-lines').textContent), re.source, W);

function established(port) {
  const out = execSync(`ss -Htn state established '( dport = :${port} )'`).toString();
  return out.split('\n').filter((l) => l.trim()).length;
}

(async () => {
  console.log(`rt pages: ${BASE}/watch/${ROOM}?rt=1`);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: process.env.HEADED !== '1', args: ARGS });
  const one = await browser.newContext({ ignoreHTTPSErrors: true });
  const two = await browser.newContext({ ignoreHTTPSErrors: true });
  const bare = await browser.newContext({ ignoreHTTPSErrors: true });
  await bare.addInitScript(() => {
    delete window.SharedWorker;
  });
  const url = `${BASE}/watch/${ROOM}?rt=1`;
  const a1 = await one.newPage();
  const a2 = await one.newPage();
  const b = await two.newPage();
  try {
    await step('two tabs of one browser and a second browser join a room over /rt', async () => {
      await a1.goto(url);
      await a2.goto(url);
      await b.goto(url);
      await joinAs(a1, `ra${RUN}`);
      await a2.waitForSelector('#chat-text', W);
      await joinAs(b, `rb${RUN}`);
      await b.waitForFunction(() => /^2 here/.test(document.querySelector('#chat-count').textContent), null, W);
      return `count "${await b.textContent('#chat-count')}": one per browser, not per tab`;
    });

    await step('a line said in one tab reaches the other tab and the other browser', async () => {
      await say(a1, 'hello over rt');
      await sees(a2, /hello over rt/);
      await sees(b, /hello over rt/);
      await say(b, 'and back');
      await sees(a1, /and back/);
      await sees(a2, /and back/);
    });

    await step('a browser holds one /rt socket and no /events or /chat socket', async () => {
      if (!LOCAL || !SOCKETS) return 'skipped: LOCAL=1 RT_SOCKETS=<chat port> counts sockets on this machine';
      const [chat, events] = SOCKETS.split(',').map(Number);
      await new Promise((r) => setTimeout(r, 500));
      const n = established(chat);
      expect(n === 2, `${n} sockets to the chat process for two browsers`);
      if (events) expect(established(events) === 0, 'an /events socket is open');
      return `${n} for two browsers with three tabs`;
    });

    await step('closing one tab leaves the other tab live on the shared socket', async () => {
      await a1.close();
      await say(b, 'after a tab closed');
      await sees(a2, /after a tab closed/);
    });

    await step('without SharedWorker a tab opens its own /rt socket and chats', async () => {
      const c = await bare.newPage();
      await c.goto(url);
      await joinAs(c, `rc${RUN}`);
      await say(c, 'from a tab of its own');
      await sees(b, /from a tab of its own/);
      await sees(a2, /from a tab of its own/);
    });

    await step('a press peeks the room without counting, and the page it opens takes the peek over', async () => {
      const three = await browser.newContext({ ignoreHTTPSErrors: true });
      await three.addInitScript(() => localStorage.setItem('perfdebug', '1'));
      const p = await three.newPage();
      const perf = [];
      p.on('console', (m) => {
        if (m.text().startsWith('[rt perf]')) perf.push(m.text());
      });
      await p.goto(`${BASE}/?rt=1`);
      await p.waitForFunction(() => document.readyState === 'complete', null, W);
      await new Promise((r) => setTimeout(r, 1000));
      const before = await b.textContent('#chat-count');
      await p.evaluate((room) => {
        const a = document.createElement('a');
        a.id = 'rt-press';
        a.href = `/watch/${room}`;
        a.textContent = room;
        a.style.cssText = 'position:fixed;top:40px;left:40px;z-index:99999;padding:20px;background:#fff';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          history.pushState({}, '', a.href);
          dispatchEvent(new PopStateEvent('popstate'));
        });
        document.body.append(a);
      }, ROOM);
      const box = await p.locator('#rt-press').boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.waitForFunction((room) => performance.getEntriesByName(`rt:chat:${room}:press`).length > 0, ROOM, W);
      await new Promise((r) => setTimeout(r, 1500));
      const during = await b.textContent('#chat-count');
      expect(during === before, `the count went from "${before}" to "${during}" on a press`);
      await p.mouse.up();
      await p.waitForSelector('#chat-count', W);
      const want = Number(before.split(' ')[0]) + 1;
      await b.waitForFunction((n) => new RegExp(`^${n} here`).test(document.querySelector('#chat-count').textContent), want, W);
      await p.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, W);
      await new Promise((r) => setTimeout(r, 500));
      const line = perf.find((t) => t.includes(`chat:${ROOM}`) && t.includes('press 0'));
      expect(line, `no perf line from the press: ${JSON.stringify(perf)}`);
      const at = (phase) => Number(new RegExp(`${phase} (\\d+)`).exec(line)[1]);
      expect(at('subbed') - at('mount') < 100, `subbed ${at('subbed') - at('mount')}ms after the mount: the peek was not held`);
      await three.close();
      return `"${before}" while pressed, ${want} after; ${line.replace('[rt perf] ', '')}`;
    });

    await step('with no flag a page is on /rt; ?rt=0 still gets the legacy /chat socket', async () => {
      const plain = await browser.newContext({ ignoreHTTPSErrors: true });
      const d = await plain.newPage();
      const own = [];
      d.on('websocket', (ws) => own.push(new URL(ws.url()).pathname));
      await d.goto(`${BASE}/watch/${ROOM}`);
      await d.waitForFunction(() => /live/.test(document.querySelector('#chat-count')?.textContent || ''), null, W);
      expect(!own.some((p) => p.startsWith('/chat/')), `the page opened ${JSON.stringify(own)}`);
      await d.goto(`${BASE}/watch/${ROOM}?rt=0`);
      await d.waitForFunction(() => /live/.test(document.querySelector('#chat-count')?.textContent || ''), null, W);
      expect(own.some((p) => p === `/chat/${ROOM}`), `?rt=0 opened ${JSON.stringify(own)}`);
      await d.goto(`${BASE}/watch/${ROOM}`);
      await d.waitForFunction(() => /live/.test(document.querySelector('#chat-count')?.textContent || ''), null, W);
      const legacy = own.filter((p) => p === `/chat/${ROOM}`).length;
      expect(legacy === 2, `the opt-out was not remembered: ${JSON.stringify(own)}`);
      await d.goto(`${BASE}/watch/${ROOM}?rt=1`);
      await d.waitForFunction(() => /live/.test(document.querySelector('#chat-count')?.textContent || ''), null, W);
      expect(own.filter((p) => p === `/chat/${ROOM}`).length === legacy, '?rt=1 did not bring /rt back');
      await plain.close();
      return `no page /chat socket by default, ${legacy} legacy loads with the opt-out, then /rt again`;
    });
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} of ${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
