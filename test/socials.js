// Socials (docs/socials.md): where else to find them, the links under the player. A name keeps
// one document of them (how they sit, how big, the links) through the bio's gate; the api
// refuses what is not a link (a javascript: url, a kind it does not know, more than the cap)
// and anyone the name is not; the watch page's socials tab draws them as anchors that leave
// this origin safely, wearing the layout and the size; the profile tab edits them and the
// page agrees, the owner's own page at once. Also the corner panel as it is now: the picture is
// your page, the gear is at the end of your line, and the `following` button is gone.
// Run through ./scripts/test.sh, or: BASE_URL=https://<ip> node socials.js
const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
/** a signup is for good, so a fresh name per run (like follows.js and preview.js) */
const ME = 'soc' + RUN;
/** somebody else with an account: the one the name is not */
const NOSY = 'nos' + RUN;
const PW = 'correct horse battery';
const ARGS = ['--ignore-certificate-errors'];
/** the api's cap on how many links one document holds. keep this with the api's */
const MAX_LINKS = 20;
/** what this suite puts and then goes looking for on the page */
const DOC = {
  layout: 'row',
  size: 'medium',
  links: [
    { kind: 'youtube', url: 'https://youtube.com/@x' },
    { kind: 'web', url: 'https://example.com/', label: 'my site' }
  ]
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
    console.log(`FAIL  ${name.padEnd(70)} ${ms()} ms\n      ${String(e.message).split('\n').join('\n      ')}`);
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
/** the links on the page, in order, as the dom has them. `text` is the word on the link (its first span); a grid square says the host under it too */
const shown = (page, box = '#socials') =>
  page.$$eval(`${box} a`, (as) =>
    as.map((a) => ({
      href: a.getAttribute('href'),
      rel: a.getAttribute('rel'),
      target: a.getAttribute('target'),
      kind: a.dataset.kind,
      text: (a.querySelector('span')?.textContent || '').trim()
    }))
  );

(async () => {
  // three http clients: the name, somebody else with an account, and nobody
  const me = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const nosy = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const anon = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const putSocials = (ctx, name, doc) => ctx.put(`/api/streamers/${name}/socials`, { data: doc });
  const socialsOf = async (name) => (await body(await anon.get(`/api/streamers/${name}`)))?.socials;

  await step('a name with no links: the empty document on the profile read, not a missing field', async () => {
    for (const [who, ctx] of [
      [ME, me],
      [NOSY, nosy]
    ]) {
      const up = await ctx.post('/api/signup', { data: { name: who, password: PW } });
      expect(up.status() === 201, `signup of ${who} got ${up.status()}`);
    }
    const doc = await socialsOf(ME);
    expect(doc && doc.layout === 'row' && doc.size === 'medium' && Array.isArray(doc.links) && doc.links.length === 0, `the empty document reads ${JSON.stringify(doc)}`);
    return `${ME} and ${NOSY}, no links yet`;
  });

  await step('the login puts a document: 200, the document as kept, and the profile read and the watch grant both carry it', async () => {
    const res = await putSocials(me, ME, DOC);
    const saved = await body(res);
    expect(res.status() === 200, `the put got ${res.status()}: ${JSON.stringify(saved)}`);
    expect(saved?.name === ME && saved.socials?.layout === 'row' && saved.socials?.size === 'medium', `the put came back ${JSON.stringify(saved)}`);
    expect(saved.socials.links.length === 2 && saved.socials.links[0].kind === 'youtube' && saved.socials.links[0].url === DOC.links[0].url, `the first link: ${JSON.stringify(saved.socials.links[0])}`);
    // an empty label is left off the wire; a given one is kept
    expect(!('label' in saved.socials.links[0]) && saved.socials.links[1].label === 'my site', `the labels: ${JSON.stringify(saved.socials.links)}`);
    const back = await socialsOf(ME);
    expect(JSON.stringify(back) === JSON.stringify(saved.socials), `the profile read says ${JSON.stringify(back)}`);
    const grant = await body(await anon.post(`/api/streams/${ME}/watch`));
    expect(JSON.stringify(grant?.socials) === JSON.stringify(saved.socials), `the watch grant says ${JSON.stringify(grant?.socials)}`);
    return `${back.links.length} links, ${back.layout}/${back.size}, on the read and the grant`;
  });

  await step('bad input: a url that is not http(s), a kind, a layout, a size off the list, too many links, a body that is not the shape: 400 each, and the kept document untouched', async () => {
    const link = (over) => ({ ...DOC, links: [{ kind: 'web', url: 'https://example.com', ...over }] });
    const cases = [
      ['a javascript: url', link({ url: 'javascript:alert(1)' }), 'bad url'],
      ['a data: url', link({ url: 'data:text/html,<script>1</script>' }), 'bad url'],
      ['no scheme at all', link({ url: 'example.com' }), 'bad url'],
      ['a path', link({ url: '/watch/' + ME }), 'bad url'],
      ['credentials in the url', link({ url: 'https://twitch.tv@evil.example/' }), 'bad url'],
      ['a kind it does not know', link({ kind: 'myspace' }), 'bad kind'],
      ['a layout it does not know', { ...DOC, layout: 'spiral' }, 'bad layout'],
      ['a size it does not know', { ...DOC, size: 'enormous' }, 'bad size'],
      [`${MAX_LINKS + 1} links`, { ...DOC, links: Array.from({ length: MAX_LINKS + 1 }, () => ({ kind: 'web', url: 'https://example.com' })) }, 'too many links'],
      ['links that are not a list', { ...DOC, links: 'https://example.com' }, 'bad json body'],
      ['a link with no url', { ...DOC, links: [{ kind: 'web' }] }, 'bad json body']
    ];
    for (const [what, doc, word] of cases) {
      const res = await putSocials(me, ME, doc);
      const said = (await body(res))?.error || '';
      expect(res.status() === 400, `${what} got ${res.status()}: ${said}`);
      expect(said.startsWith(word), `${what} said "${said}", want "${word}…"`);
    }
    // nothing refused may have landed: the document is the one from the step before
    const back = await socialsOf(ME);
    expect(back.links.length === 2 && back.links[0].url === DOC.links[0].url, `a refused put changed the document: ${JSON.stringify(back)}`);
    return `${cases.length} refused, the document untouched`;
  });

  await step('the name is not yours: nobody 403, another login 403, and neither changed it', async () => {
    const no = await putSocials(anon, ME, DOC);
    const theirs = await putSocials(nosy, ME, DOC);
    expect(no.status() === 403, `nobody got ${no.status()}`);
    expect(theirs.status() === 403, `another login got ${theirs.status()}`);
    expect(/has an account/.test((await body(theirs))?.error || ''), `the refusal says ${JSON.stringify(await body(theirs))}`);
    return 'nobody and a stranger both refused';
  });

  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !process.env.HEADED, args: ARGS });
  const watcher = await browser.newContext({ ignoreHTTPSErrors: true });
  const owner = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = async (p, name) => {
    await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('#auth-name', name);
    await p.fill('#auth-password', PW);
    await p.click('#auth-submit');
    await p.waitForFunction((n) => document.querySelector('#me')?.textContent === n, name, { timeout: 10000 });
    // the login page moves to home, and a page change closes the panel: nothing hovers it before the move
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
  };
  let w;
  let o;

  await step(`a watcher on /watch/${ME}: the socials tab, after about and calendar, draws the links as anchors that leave safely, wearing the layout and the size`, async () => {
    w = await watcher.newPage();
    // nothing on this page may reach another host: an icon from elsewhere hands the viewer's address over
    const elsewhere = [];
    w.on('request', (r) => {
      if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) elsewhere.push(r.url());
    });
    await w.goto(`${BASE}/watch/${ME}`, { waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 15000 });
    const tabs = await w.$$eval('#watch-tabs [role="tab"]', (els) => els.map((el) => el.id));
    expect(tabs.join(' ') === 'tab-about tab-calendar tab-socials', `the tabs are ${tabs.join(' ')}`);
    expect((await w.$$('#socials')).length === 0, 'the links are in the page before their tab is opened');
    await w.click('#tab-socials');
    await w.waitForSelector('#socials', { timeout: 10000 });
    expect((await w.getAttribute('#socials', 'data-layout')) === DOC.layout, `the box says data-layout ${await w.getAttribute('#socials', 'data-layout')}`);
    expect((await w.getAttribute('#socials', 'data-size')) === DOC.size, `the box says data-size ${await w.getAttribute('#socials', 'data-size')}`);
    const links = await shown(w);
    expect(links.length === 2, `${links.length} anchors, want 2`);
    expect(links.map((l) => l.href).join(' ') === DOC.links.map((l) => l.url).join(' '), `the hrefs are ${JSON.stringify(links.map((l) => l.href))}`);
    expect(links.map((l) => l.kind).join(' ') === 'youtube web', `the kinds are ${JSON.stringify(links.map((l) => l.kind))}`);
    for (const l of links) {
      expect(l.target === '_blank', `${l.href} opens in ${l.target}`);
      expect(/noopener/.test(l.rel || '') && /noreferrer/.test(l.rel || '') && /nofollow/.test(l.rel || ''), `${l.href} has rel "${l.rel}"`);
    }
    // a link with a label wears it; one without wears the kind's word
    expect(links[0].text === 'youtube', `the unlabelled link reads "${links[0].text}"`);
    expect(links[1].text === 'my site', `the labelled link reads "${links[1].text}"`);
    // not my page: no way into the editor here
    expect((await w.$$('#socials-edit')).length === 0, 'a watcher is offered the editor');
    expect(elsewhere.length === 0, `the page fetched ${JSON.stringify(elsewhere)}`);
    return `${links.length} links, ${DOC.layout}/${DOC.size}, nothing fetched elsewhere`;
  });

  await step('the about tab and back: the links are out of the page under the other tab, and come back as they were', async () => {
    await w.click('#tab-about');
    await w.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 10000 });
    expect((await w.$$('#socials')).length === 0, 'the links are still in the page under the about tab');
    await w.click('#tab-socials');
    await w.waitForSelector('#socials', { timeout: 10000 });
    expect((await shown(w)).length === 2, 'the links did not come back');
    return 'out and back';
  });

  await step('the corner panel: the gear is at the end of your line and not in the title row, there is no following button, and the picture is a link to your page', async () => {
    o = await owner.newPage();
    await login(o, ME);
    expect((await o.$$('header #settings')).length === 0, 'the gear is still in the title row');
    expect((await o.$$('#friends-open')).length === 0, 'the following button is still in the panel');
    await o.hover('#user-panel');
    await o.waitForSelector('#user-panel[data-open="true"]', { timeout: 10000 });
    await o.waitForSelector('#user-panel #settings', { state: 'visible', timeout: 10000 });
    const href = await o.getAttribute('#you', 'href');
    expect(href === `/watch/${ME}`, `the picture links to ${href}`);
    const nameHref = await o.$eval('#me', (el) => el.closest('a')?.getAttribute('href') || '');
    expect(nameHref === `/watch/${ME}`, `the name links to ${nameHref}`);
    await o.click('#you');
    await o.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 15000 });
    expect(new URL(o.url()).pathname === `/watch/${ME}`, `the picture went to ${o.url()}`);
    expect(((await o.textContent('#who')) || '').includes(ME), 'my page does not say my name');
    return `/watch/${ME}, from the picture`;
  });

  await step('my own page: the socials tab says the links are mine and the way to the editor opens the profile tab at the links', async () => {
    await o.click('#tab-socials');
    await o.waitForSelector('#socials-edit', { timeout: 10000 });
    await o.click('#socials-edit');
    await o.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await o.waitForSelector('#tab-profile[aria-selected="true"]', { timeout: 5000 });
    await o.waitForSelector('#profile-socials', { timeout: 10000 });
    // the rows are the document as kept
    await o.waitForFunction((v) => document.querySelector('#profile-social-url-1')?.value === v, DOC.links[1].url, { timeout: 10000 });
    expect((await o.inputValue('#profile-social-label-1')) === 'my site', `the second row's words: "${await o.inputValue('#profile-social-label-1')}"`);
    expect(await o.isChecked('#profile-socials-layout-row'), 'the row card is not the one on');
    expect(await o.isChecked('#profile-socials-size-medium'), 'the medium card is not the one on');
    return 'the editor, with the two rows';
  });

  await step('the editor: the grid and large cards, a github row from its square with a bare host, save; the api has it and the page behind follows with no reload', async () => {
    // a radio as a card: the input is sr-only, so the label is what takes the click (presence.js's way)
    await o.click('label[for="profile-socials-layout-grid"]');
    expect(await o.isChecked('#profile-socials-layout-grid'), '#profile-socials-layout-grid is not checked');
    await o.click('label[for="profile-socials-size-large"]');
    expect(await o.isChecked('#profile-socials-size-large'), '#profile-socials-size-large is not checked');
    // the preview under the cards is the same component: it wears the picks before any save
    await o.waitForSelector('#profile-socials-preview-links[data-layout="grid"][data-size="large"]', { timeout: 5000 });
    await o.click('#profile-social-add-github');
    await o.waitForSelector('#profile-social-2[data-kind="github"]', { timeout: 5000 });
    // the new row's url box took focus; a bare host is fine: https goes in front on the way up
    const focused = await o.evaluate(() => document.activeElement?.id || '');
    expect(focused === 'profile-social-url-2', `focus is on "${focused}"`);
    await o.fill('#profile-social-url-2', 'github.com/you');
    await o.fill('#profile-social-label-2', 'the code');
    const status = ((await o.textContent('#profile-socials-status')) || '').trim();
    expect(/changed/.test(status), `the status before the save reads "${status}"`);
    await o.click('#profile-save-socials');
    await o.waitForFunction(() => document.querySelector('#profile-socials-status')?.textContent === 'saved', null, { timeout: 10000 });
    // the box shows the url as the api kept it
    expect((await o.inputValue('#profile-social-url-2')) === 'https://github.com/you', `the url box reads "${await o.inputValue('#profile-social-url-2')}"`);
    const back = await socialsOf(ME);
    expect(back.layout === 'grid' && back.size === 'large', `the api says ${back.layout}/${back.size}`);
    expect(back.links.length === 3 && back.links[2].kind === 'github' && back.links[2].url === 'https://github.com/you' && back.links[2].label === 'the code', `the api's links: ${JSON.stringify(back.links)}`);
    // my own page, under the modal, has the new document already
    await o.keyboard.press('Escape');
    await o.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    await o.waitForSelector('#socials[data-layout="grid"][data-size="large"]', { timeout: 5000 });
    const links = await shown(o);
    expect(links.length === 3 && links[2].href === 'https://github.com/you' && links[2].text === 'the code', `my page's links: ${JSON.stringify(links)}`);
    return `grid/large, ${back.links.length} links, the page followed`;
  });

  await step('the editor: a web row takes the kind its link lands on, the arrows move a row, × takes one out; none of it saved until the button', async () => {
    await o.hover('#user-panel');
    await o.click('#settings');
    await o.waitForSelector('#user-modal[open]', { timeout: 5000 });
    await o.click('#tab-profile');
    await o.waitForSelector('#profile-social-2', { timeout: 10000 });
    await o.click('#profile-social-add-web');
    await o.waitForSelector('#profile-social-3[data-kind="web"]', { timeout: 5000 });
    await o.fill('#profile-social-url-3', 'https://www.twitch.tv/you');
    await o.waitForSelector('#profile-social-3[data-kind="twitch"]', { timeout: 5000 });
    // up: the twitch row trades places with github
    await o.click('#profile-social-up-3');
    await o.waitForSelector('#profile-social-2[data-kind="twitch"]', { timeout: 5000 });
    expect((await o.getAttribute('#profile-social-3', 'data-kind')) === 'github', 'github did not move down');
    // the first row's up arrow and the last row's down arrow do nothing: they are disabled
    expect(await o.isDisabled('#profile-social-up-0'), 'the first row can move up');
    expect(await o.isDisabled('#profile-social-down-3'), 'the last row can move down');
    await o.click('#profile-social-remove-2');
    await o.waitForSelector('#profile-social-3', { state: 'detached', timeout: 5000 });
    expect((await o.getAttribute('#profile-social-2', 'data-kind')) === 'github', 'github is not back in the third row');
    // nothing went up: the api still has three
    const back = await socialsOf(ME);
    expect(back.links.length === 3, `the api has ${back.links.length} links after edits that were not saved`);
    await o.keyboard.press('Escape');
    await o.waitForSelector('#user-modal', { state: 'detached', timeout: 5000 });
    return 'twitch from its host, moved, removed; nothing saved';
  });

  await step('the watcher reloads: the third link is there and the box wears the new layout and size', async () => {
    await w.reload({ waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#tab-socials', { timeout: 15000 });
    await w.click('#tab-socials');
    await w.waitForSelector('#socials[data-layout="grid"][data-size="large"]', { timeout: 10000 });
    const links = await shown(w);
    expect(links.length === 3 && links[2].href === 'https://github.com/you', `the page's links: ${JSON.stringify(links.map((l) => l.href))}`);
    return `${links.length} links, grid/large`;
  });

  await step('the owner empties it: 200, and the tab stays on the page, saying there is nothing here', async () => {
    const res = await putSocials(me, ME, { links: [] });
    const saved = await body(res);
    expect(res.status() === 200 && saved?.socials?.links?.length === 0, `emptying got ${res.status()}: ${JSON.stringify(saved)}`);
    // layout and size left out: the defaults
    expect(saved.socials.layout === 'row' && saved.socials.size === 'medium', `the defaults came back as ${saved.socials.layout}/${saved.socials.size}`);
    await w.reload({ waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#tab-socials', { timeout: 15000 });
    await w.click('#tab-socials');
    await w.waitForSelector('#socials[data-empty]', { timeout: 10000 });
    expect((await shown(w)).length === 0, 'links on an emptied page');
    return 'no links, the tab says so';
  });

  await browser.close();
  await me.dispose();
  await nosy.dispose();
  await anon.dispose();

  if (LOCAL) {
    // this run's signups count against this machine's ip for a while: forget them, like auth.js does
    execSync(`docker compose exec -T redis sh -c "redis-cli --scan --pattern 'rl:signup:*' | xargs -r redis-cli del"`, { cwd: REPO, stdio: 'ignore' });
  }

  const failed = results.filter((r) => r === 'fail').length;
  const skipped = results.filter((r) => r === 'skip').length;
  console.log(`\n${failed ? 'FAIL' : 'PASS'}  ${results.length - failed - skipped}/${results.length}${skipped ? `  (${skipped} skipped)` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
