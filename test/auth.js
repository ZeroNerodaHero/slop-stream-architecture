// Accounts: sign up, log in, log out, a claimed name is only its owner's (go live, bio, chat),
// a login's chat lines are verified, too many tries is refused. Run through ./test.sh, or:
// BASE_URL=https://<ip> node auth.js   (LOCAL=1 also checks `api passwd` through docker compose)
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.BASE_URL || 'https://127.0.0.1';
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const NAME = 'acct' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors'];
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push(true);
    console.log(`PASS  ${name.padEnd(62)} ${String(Date.now() - t0).padStart(6)} ms  ${info || ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name.padEnd(62)} ${String(Date.now() - t0).padStart(6)} ms\n      ${e.message}`);
  }
}
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const body = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

(async () => {
  // two http clients: one that keeps the login cookie, one that never has it
  const owner = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });

  await step('sign up: short password 400, good one 201, /api/me knows me', async () => {
    const short = await owner.post('/api/signup', { data: { name: NAME, password: 'short' } });
    expect(short.status() === 400, `short password got ${short.status()}`);
    const res = await owner.post('/api/signup', { data: { name: NAME, password: PW } });
    expect(res.status() === 201, `signup got ${res.status()} ${JSON.stringify(await body(res))}`);
    const cookie = res.headers()['set-cookie'] || '';
    expect(/login=[0-9a-f]{64}/.test(cookie) && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie), `cookie: ${cookie}`);
    const me = await body(await owner.get('/api/me'));
    const nobody = await body(await anon.get('/api/me'));
    expect(me && me.name === NAME, `me = ${JSON.stringify(me)}`);
    expect(nobody && nobody.name === null, `anonymous me = ${JSON.stringify(nobody)}`);
    return `as ${NAME}`;
  });

  await step('the name is taken now: a second signup is 409', async () => {
    const res = await anon.post('/api/signup', { data: { name: NAME, password: 'another password' } });
    expect(res.status() === 409, `got ${res.status()}`);
    const reserved = await anon.post('/api/signup', { data: { name: 'dummy-' + RUN, password: PW } });
    expect(reserved.status() === 403, `dummy- signup got ${reserved.status()}`);
    return 'and dummy- names are 403';
  });

  await step('go live on a claimed name: anonymous 403, the owner 200', async () => {
    const no = await anon.post(`/api/streams/${NAME}/go-live`);
    const noBody = await body(no);
    expect(no.status() === 403 && /account/.test(noBody && noBody.error), `anonymous got ${no.status()} ${JSON.stringify(noBody)}`);
    const yes = await owner.post(`/api/streams/${NAME}/go-live`);
    const grant = await body(yes);
    expect(yes.status() === 200 && grant.session && grant.token, `owner got ${yes.status()} ${JSON.stringify(grant)}`);
    const stop = await owner.post(`/api/streams/${NAME}/stop?session=${grant.session}&token=${grant.token}`);
    expect(stop.status() === 200, `stop got ${stop.status()}`);
    // a free name still needs nothing
    const free = await anon.post(`/api/streams/free${RUN}/go-live`);
    const freeGrant = await body(free);
    expect(free.status() === 200, `free name got ${free.status()}`);
    await anon.post(`/api/streams/free${RUN}/stop?session=${freeGrant.session}&token=${freeGrant.token}`);
    return `"${noBody.error}"`;
  });

  await step('the bio of a claimed name: anonymous 403, the owner 200', async () => {
    const no = await anon.put(`/api/streamers/${NAME}`, { data: { bio: 'not mine' } });
    expect(no.status() === 403, `anonymous got ${no.status()}`);
    const yes = await owner.put(`/api/streamers/${NAME}`, { data: { bio: 'mine' } });
    expect(yes.status() === 200, `owner got ${yes.status()}`);
    const read = await body(await anon.get(`/api/streamers/${NAME}`));
    expect(read.bio === 'mine', `bio is ${JSON.stringify(read)}`);
    return 'bio stays "mine"';
  });

  await step('log out, wrong password 401, unknown name 401 (same words), right one 200', async () => {
    const out = await owner.post('/api/logout');
    expect(out.status() === 204, `logout got ${out.status()}`);
    const cleared = out.headers()['set-cookie'] || '';
    expect(/login=;/.test(cleared) && /Max-Age=0/i.test(cleared), `logout did not clear the cookie: ${cleared}`);
    const gone = await body(await owner.get('/api/me'));
    expect(gone.name === null, `after logout me = ${JSON.stringify(gone)}`);
    const wrong = await owner.post('/api/login', { data: { name: NAME, password: 'nope nope nope' } });
    const unknown = await owner.post('/api/login', { data: { name: 'nobody' + RUN, password: PW } });
    const w = await body(wrong);
    const u = await body(unknown);
    expect(wrong.status() === 401 && unknown.status() === 401 && w.error === u.error, `wrong ${wrong.status()} "${w && w.error}", unknown ${unknown.status()} "${u && u.error}"`);
    const right = await owner.post('/api/login', { data: { name: NAME.toUpperCase(), password: PW } });
    expect(right.status() === 200, `right password got ${right.status()}`);
    const me = await body(await owner.get('/api/me'));
    expect(me.name === NAME, `me = ${JSON.stringify(me)}`);
    return `"${w.error}"`;
  });

  await step('change password: old one stops working, new one works', async () => {
    const bad = await owner.post('/api/password', { data: { old: 'wrong', new: 'a brand new password' } });
    expect(bad.status() === 403, `wrong old got ${bad.status()}`);
    const ok = await owner.post('/api/password', { data: { old: PW, new: 'a brand new password' } });
    expect(ok.status() === 204, `change got ${ok.status()}`);
    const still = await body(await owner.get('/api/me'));
    expect(still.name === NAME, 'the changing login was logged out');
    const old = await anon.post('/api/login', { data: { name: NAME, password: PW } });
    const fresh = await anon.post('/api/login', { data: { name: NAME, password: 'a brand new password' } });
    expect(old.status() === 401 && fresh.status() === 200, `old ${old.status()}, new ${fresh.status()}`);
    await anon.post('/api/logout');
    return 'and this login survived';
  });

  await step('nobody: /api/password and /api/logout-all are 401. logout-all ends the other device too', async () => {
    const pw = await anon.post('/api/password', { data: { old: 'a brand new password', new: 'yet another password' } });
    const all = await anon.post('/api/logout-all');
    expect(pw.status() === 401 && all.status() === 401, `nobody got ${pw.status()} and ${all.status()}`);
    // a second device logs in; the first logs every device out
    const phone = await anon.post('/api/login', { data: { name: NAME, password: 'a brand new password' } });
    expect(phone.status() === 200, `second device got ${phone.status()}`);
    const out = await owner.post('/api/logout-all');
    expect(out.status() === 204, `logout-all got ${out.status()}`);
    const first = await body(await owner.get('/api/me'));
    const second = await body(await anon.get('/api/me'));
    expect(first.name === null && second.name === null, `after logout-all: ${JSON.stringify(first)} and ${JSON.stringify(second)}`);
    return 'both devices out';
  });

  await step('a password typed decomposed (200 raw chars) logs in composed: nfkc first, then the length rule', async () => {
    const name = 'nfc' + RUN;
    const decomposed = 'e\u0301'.repeat(100); // 200 code points, 100 characters after nfkc
    const composed = '\u00e9'.repeat(100);
    const up = await anon.post('/api/signup', { data: { name, password: decomposed } });
    expect(up.status() === 201, `signup got ${up.status()} ${JSON.stringify(await body(up))}`);
    const same = await anon.post('/api/login', { data: { name, password: decomposed } });
    const other = await anon.post('/api/login', { data: { name, password: composed } });
    expect(same.status() === 200 && other.status() === 200, `decomposed ${same.status()}, composed ${other.status()}`);
    await anon.post('/api/logout');
    return 'é × 100, both spellings';
  });

  await step('15 wrong passwords on one name at once: 10 are 401, 5 are 429, and the 16th is 429', async () => {
    const name = 'lock' + RUN;
    // all in flight together: the counter must be bumped before the check, or they would all read zero.
    // guesses must be 8+ chars: a password no account can have is refused before it is counted
    const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => anon.post('/api/login', { data: { name, password: 'wrong guess ' + i } })));
    const codes = burst.map((r) => r.status());
    const wrong = codes.filter((c) => c === 401).length;
    const limited = codes.filter((c) => c === 429).length;
    expect(wrong === 10 && limited === 5, `burst got ${codes.sort().join(' ')}`);
    const again = await anon.post('/api/login', { data: { name, password: 'guess again' } });
    expect(again.status() === 429, `16th try got ${again.status()}`);
    return `"${(await body(again)).error}"`;
  });

  // the pages: log in through the form, chat as the account, and an anonymous person cannot wear the name
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ARGS });
  const fresh = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  const ROOM = 'authroom' + RUN;

  await step('the login page: the user panel shows me, go live has my name locked in', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/login?next=/live`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', NAME);
    await p.fill('#auth-password', 'a brand new password');
    await p.click('#auth-submit');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, NAME, { timeout: 10000 });
    expect(p.url().endsWith('/live'), `landed on ${p.url()}`);
    await p.waitForFunction((n) => document.querySelector('#name')?.value === n && document.querySelector('#name').disabled, NAME, { timeout: 10000 });
    await p.close();
    return 'then /live';
  });

  await step('?next=/\\evil.com (a browser reads it as //evil.com) is not a place to land: home instead', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/login?next=${encodeURIComponent('/\\evil.com')}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', NAME);
    await p.fill('#auth-password', 'a brand new password');
    await p.click('#auth-submit');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, NAME, { timeout: 10000 });
    const url = new URL(p.url());
    expect(url.origin === new URL(BASE).origin && url.pathname === '/', `landed on ${p.url()}`);
    await p.close();
    return `landed on ${url.pathname}`;
  });

  await step('chat as a login: no nick box, the line is marked verified', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/login?next=/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', NAME);
    await p.fill('#auth-password', 'a brand new password');
    await p.click('#auth-submit');
    await p.waitForSelector('#chat-text', { timeout: 15000 });
    expect((await p.$('#chat-nick')) === null, 'a nick box showed for a login');
    await p.waitForFunction(() => /live/.test(document.querySelector('#chat-count').textContent), null, { timeout: 10000 });
    await p.fill('#chat-text', 'hi from the account');
    await p.click('#chat-send');
    await p.waitForFunction((n) => [...document.querySelectorAll('#chat-lines p')].some((l) => l.dataset.verified === 'true' && l.textContent.includes(n) && l.textContent.includes('hi from the account')), NAME, { timeout: 10000 });
    await p.close();
    return `line from ${NAME} ✓`;
  });

  await step('anonymous with a claimed nick is refused and gets the nick box back', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#chat-nick', { timeout: 10000 });
    await p.fill('#chat-nick', NAME);
    await p.click('#chat-join');
    await p.waitForFunction(() => /account/.test(document.querySelector('#chat-notice')?.textContent || ''), null, { timeout: 10000 });
    await p.waitForSelector('#chat-nick', { timeout: 5000 });
    const notice = await p.textContent('#chat-notice');
    // a free nick still works
    await p.fill('#chat-nick', 'someone' + RUN);
    await p.click('#chat-join');
    await p.waitForSelector('#chat-text', { timeout: 10000 });
    await p.close();
    return `"${notice}"`;
  });

  await step('anonymous with the claimed nick in capitals is refused too', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/watch/${ROOM}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#chat-nick', { timeout: 10000 });
    await p.fill('#chat-nick', NAME.toUpperCase());
    await p.click('#chat-join');
    await p.waitForFunction(() => /account/.test(document.querySelector('#chat-notice')?.textContent || ''), null, { timeout: 10000 });
    await p.waitForSelector('#chat-nick', { timeout: 5000 });
    await p.close();
    return `${NAME.toUpperCase()} refused`;
  });

  await step('log out from the user panel: the name box is free again', async () => {
    const p = await fresh();
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', NAME);
    await p.fill('#auth-password', 'a brand new password');
    await p.click('#auth-submit');
    await p.waitForSelector('#logout', { timeout: 10000 });
    await p.click('#logout');
    await p.waitForSelector('#username', { timeout: 10000 });
    const me = await body(await anon.get('/api/me'));
    expect(me.name === null, 'anon context should still be nobody');
    await p.close();
    return 'the panel shows the name box';
  });

  if (LOCAL) {
    await step('api passwd <name> prints a new password that works, and ends the logins', async () => {
      const before = await owner.post('/api/login', { data: { name: NAME, password: 'a brand new password' } });
      expect(before.status() === 200, `login before passwd got ${before.status()}`);
      const out = execSync(`docker compose exec -T api api passwd ${NAME}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const pw = (out.match(/new password is\s+(\S+)/) || [])[1];
      expect(pw, `no password in: ${out}`);
      const dead = await body(await owner.get('/api/me'));
      expect(dead.name === null, `a login survived passwd: ${JSON.stringify(dead)}`);
      const old = await anon.post('/api/login', { data: { name: NAME, password: 'a brand new password' } });
      const fresh = await anon.post('/api/login', { data: { name: NAME, password: pw } });
      expect(old.status() === 401 && fresh.status() === 200, `old ${old.status()}, printed one ${fresh.status()}`);
      return `"${pw}"`;
    });

    // this run's wrong passwords and signups count against this machine's ip for a while.
    // forget those two, so running the suite in a loop never locks the developer out.
    // only those: rl:errors:* belongs to the error-report limiter and is not ours to clear.
    execSync(`docker compose exec -T redis sh -c "for p in 'rl:login:*' 'rl:signup:*'; do redis-cli --scan --pattern \\"\\$p\\" | xargs -r redis-cli del; done"`, { cwd: REPO, stdio: 'ignore' });
  }

  await browser.close();
  await owner.dispose();
  await anon.dispose();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
