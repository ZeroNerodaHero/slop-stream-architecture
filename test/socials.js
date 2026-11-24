const { chromium, request } = require('playwright');
const { execSync } = require('child_process');
const BASE = (process.env.BASE_URL || 'https://127.0.0.1').replace(/\/$/, '');
const LOCAL = process.env.LOCAL === '1';
const REPO = require('path').join(__dirname, '..');
const RUN = Date.now().toString(36).slice(-5);
const ME = 'soc' + RUN;
const NOSY = 'nos' + RUN;
const PW = 'correct horse battery 9!';
const ARGS = ['--ignore-certificate-errors'];
const MAX_LINKS = 20;
const DOC = {
  layout: 'row',
  size: 'medium',
  links: [
    { kind: 'youtube', url: 'https://youtube.com/@x' },
    { kind: 'web', url: 'https://example.com/', label: 'my site' }
  ]
};
const results = [];
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
    await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 });
  };
  let w;
  let o;

  await step(`a watcher on /watch/${ME}: the socials tab, after about and calendar, draws the links as anchors that leave safely, wearing the layout and the size`, async () => {
    w = await watcher.newPage();
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
    expect(links[0].text === 'youtube', `the unlabelled link reads "${links[0].text}"`);
    expect(links[1].text === 'my site', `the labelled link reads "${links[1].text}"`);
    const joinedLine = ((await w.textContent('#socials-joined')) || '').trim();
    expect(/^joined [a-z]+ \d{4}$/.test(joinedLine), `the joined line reads "${joinedLine}"`);
    const joinedAt = (await body(await anon.get(`/api/streamers/${ME}`)))?.joined_at;
    expect(joinedAt && (await w.getAttribute('#socials-joined time', 'datetime')) === joinedAt, `the <time> says ${await w.getAttribute('#socials-joined time', 'datetime')}, the profile ${joinedAt}`);
    expect((await w.$$('#socials-edit')).length === 0, 'a watcher is offered the editor');
    expect(elsewhere.length === 0, `the page fetched ${JSON.stringify(elsewhere)}`);
    return `${links.length} links, ${DOC.layout}/${DOC.size}, ${joinedLine}, nothing fetched elsewhere`;
  });

  await step('a link out asks first (the links setting, on by default): a click, a cmd/ctrl click and a middle click each show the leave-site word, and no tab opens', async () => {
    const tabs = [];
    const onTab = (p) => tabs.push(p.url());
    w.context().on('page', onTab);
    const youtube = '#socials a[data-kind="youtube"]';
    for (const [how, opts] of [['a click', {}], ['a cmd/ctrl click', { modifiers: ['ControlOrMeta'] }], ['a middle click', { button: 'middle' }]]) {
      await w.click(youtube, opts);
      await w.waitForSelector('#leave-site[open]', { timeout: 5000 });
      const site = await w.getAttribute('#leave-site', 'data-site');
      expect(site === 'youtube.com', `${how}: the word names ${site}`);
      expect((await w.getAttribute('#leave-site-go', 'href')) === DOC.links[0].url, `${how}: the way on goes to ${await w.getAttribute('#leave-site-go', 'href')}`);
      await w.click('#leave-site-stay');
      await w.waitForSelector('#leave-site', { state: 'detached', timeout: 5000 });
    }
    await w.waitForTimeout(500);
    w.context().off('page', onTab);
    expect(tabs.length === 0, `tabs opened past the word: ${JSON.stringify(tabs)}`);
    return 'three ways, three words, no tab';
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

  await step('a desktop body too narrow for the chat beside the player: the chat is the last tab, the desktop shell stays, and widening puts it back beside without a reconnect', async () => {
    const tabIds = () => w.$$eval('#watch-tabs [role="tab"]', (els) => els.map((el) => el.id).join(' '));
    await w.setViewportSize({ width: 900, height: 900 });
    await w.waitForSelector('[data-chat="tabbed"] #tab-chat', { timeout: 10000 });
    expect((await tabIds()) === 'tab-about tab-calendar tab-socials tab-chat', `the narrow tabs are ${await tabIds()}`);
    expect((await w.getAttribute('#tab-socials', 'aria-selected')) === 'true', 'the open tab was not kept into the narrow body');
    const [row, chatTab] = await Promise.all([w.$eval('#watch-tabs [role="tablist"]', (el) => el.getBoundingClientRect().right), w.$eval('#tab-chat', (el) => el.getBoundingClientRect().right)]);
    expect(Math.abs(row - chatTab) <= 1, `the chat tab ends at ${chatTab}, the row at ${row}`);
    expect(await w.isVisible('#user-panel'), 'the sidebar is gone');
    expect(await w.isVisible('#go-live'), 'the title row has no go live');
    expect((await w.$$('#chat-open')).length === 0, 'the player still has the chat button');
    await w.$eval('#chat', (el) => {
      el.dataset.kept = 'yes';
    });
    expect(((await w.$eval('#chat', (el) => el.getBoundingClientRect().height)) || 0) < 1, 'the chat shows under the socials tab');
    await w.click('#tab-chat');
    await w.waitForSelector('#tab-chat[aria-selected="true"]', { timeout: 10000 });
    expect(await w.isVisible('#panel-chat #chat'), 'the chat tab does not show the chat');
    expect((await w.$$('#panel-socials')).length === 0, 'the socials panel is still up beside the chat');
    await w.setViewportSize({ width: 1280, height: 900 });
    await w.waitForSelector('[data-chat="beside"]', { timeout: 10000 });
    expect((await tabIds()) === 'tab-about tab-calendar tab-socials', `the wide tabs are ${await tabIds()}`);
    expect((await w.getAttribute('#tab-about', 'aria-selected')) === 'true', 'the about tab does not stand in for the chat beside');
    expect((await w.getAttribute('#chat', 'data-kept')) === 'yes', 'the chat was remounted by the resize');
    expect(await w.isVisible('#chat-open'), 'the chat button did not come back');
    const [video, chat] = await Promise.all([w.$eval('#watch-tabs', (el) => el.getBoundingClientRect().right), w.$eval('#chat', (el) => el.getBoundingClientRect().left)]);
    expect(chat >= video, `the chat starts at ${chat}, left of the tabs' right edge ${video}`);
    await w.setViewportSize({ width: 900, height: 900 });
    await w.waitForSelector('#tab-chat[aria-selected="true"]', { timeout: 10000 });
    expect((await w.getAttribute('#chat', 'data-kept')) === 'yes', 'the chat was remounted by the second resize');
    await w.evaluate(() => localStorage.setItem('settings.chatSide', JSON.stringify('modal')));
    await w.reload({ waitUntil: 'domcontentloaded' });
    await w.waitForSelector('#tab-about[aria-selected="true"]', { timeout: 15000 });
    expect((await tabIds()) === 'tab-about tab-calendar tab-socials', `with a window the narrow tabs are ${await tabIds()}`);
    await w.evaluate(() => localStorage.removeItem('settings.chatSide'));
    await w.setViewportSize({ width: 1280, height: 720 });
    await w.reload({ waitUntil: 'domcontentloaded' });
    await w.waitForSelector('[data-chat="beside"] #tab-about', { timeout: 15000 });
    return 'four tabs at 900px, three beside at 1280px, the chat kept, none for a window';
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

  await step('my own page: the socials tab says the links are mine, and `edit the links` opens the editor under the strip, holding the document; no modal', async () => {
    await o.click('#tab-socials');
    await o.waitForSelector('#socials-edit', { timeout: 10000 });
    await o.click('#socials-edit');
    await o.waitForSelector('#socials-editor', { timeout: 10000 });
    expect((await o.$$('#user-modal[open]')).length === 0, 'the editor opened the user modal');
    await o.waitForFunction((v) => document.querySelector('#socials-url-1')?.value === v, DOC.links[1].url, { timeout: 10000 });
    expect((await o.inputValue('#socials-label-1')) === 'my site', `the second row's words: "${await o.inputValue('#socials-label-1')}"`);
    expect(await o.isChecked('#socials-layout-row'), 'the row card is not the one on');
    expect(await o.isChecked('#socials-size-medium'), 'the medium card is not the one on');
    expect((await shown(o)).length === 2, 'the strip left the page when the editor opened');
    expect((await o.$$('#socials-edit')).length === 0, 'the edit link is still there with the editor open');
    return 'the editor under the strip, with the two rows';
  });

  await step('the editor: the grid and large cards, a github row from its square with a bare host; the strip above follows the draft; save, and the api has it', async () => {
    await o.click('label[for="socials-layout-grid"]');
    expect(await o.isChecked('#socials-layout-grid'), '#socials-layout-grid is not checked');
    await o.click('label[for="socials-size-large"]');
    expect(await o.isChecked('#socials-size-large'), '#socials-size-large is not checked');
    await o.waitForSelector('#socials[data-layout="grid"][data-size="large"]', { timeout: 5000 });
    await o.click('#socials-add-github');
    await o.waitForSelector('#socials-row-2[data-kind="github"]', { timeout: 5000 });
    const focused = await o.evaluate(() => document.activeElement?.id || '');
    expect(focused === 'socials-url-2', `focus is on "${focused}"`);
    await o.fill('#socials-url-2', 'github.com/you');
    await o.fill('#socials-label-2', 'the code');
    await o.waitForFunction(() => document.querySelectorAll('#socials a').length === 3, null, { timeout: 5000 });
    const drawn = await shown(o);
    expect(drawn[2].href === 'https://github.com/you' && drawn[2].text === 'the code', `the strip's third link before the save: ${JSON.stringify(drawn[2])}`);
    const status = ((await o.textContent('#socials-status')) || '').trim();
    expect(/changed/.test(status), `the status before the save reads "${status}"`);
    expect((await socialsOf(ME)).links.length === 2, 'the api has the third link before the save');
    await o.click('#socials-save');
    await o.waitForFunction(() => document.querySelector('#socials-status')?.textContent === 'saved', null, { timeout: 10000 });
    expect((await o.inputValue('#socials-url-2')) === 'https://github.com/you', `the url box reads "${await o.inputValue('#socials-url-2')}"`);
    const back = await socialsOf(ME);
    expect(back.layout === 'grid' && back.size === 'large', `the api says ${back.layout}/${back.size}`);
    expect(back.links.length === 3 && back.links[2].kind === 'github' && back.links[2].url === 'https://github.com/you' && back.links[2].label === 'the code', `the api's links: ${JSON.stringify(back.links)}`);
    await o.click('#socials-done');
    await o.waitForSelector('#socials-editor', { state: 'detached', timeout: 5000 });
    await o.waitForSelector('#socials[data-layout="grid"][data-size="large"]', { timeout: 5000 });
    const links = await shown(o);
    expect(links.length === 3 && links[2].href === 'https://github.com/you' && links[2].text === 'the code', `my page's links: ${JSON.stringify(links)}`);
    await o.waitForSelector('#socials-edit', { timeout: 5000 });
    return `grid/large, ${back.links.length} links, the strip followed`;
  });

  await step("the editor again: a web row takes the kind its link lands on, the drag handle's keys move a row, × takes one out; none of it saved until the button, and done shows the saved document", async () => {
    await o.click('#socials-edit');
    await o.waitForSelector('#socials-row-2', { timeout: 10000 });
    await o.click('#socials-add-web');
    await o.waitForSelector('#socials-row-3[data-kind="web"]', { timeout: 5000 });
    await o.fill('#socials-url-3', 'https://www.twitch.tv/you');
    await o.waitForSelector('#socials-row-3[data-kind="twitch"]', { timeout: 5000 });
    await o.waitForFunction(() => document.querySelectorAll('#socials a').length === 4, null, { timeout: 5000 });
    expect(!(await o.$('#socials-up-0')) && !(await o.$('#socials-down-3')), 'a row still has up and down buttons');
    await o.focus('#socials-drag-3');
    await o.keyboard.press('Space');
    await o.keyboard.press('ArrowUp');
    await o.keyboard.press('Space');
    await o.waitForSelector('#socials-row-2[data-kind="twitch"]', { timeout: 5000 });
    expect((await o.getAttribute('#socials-row-3', 'data-kind')) === 'github', 'github did not move down');
    const firstKind = await o.getAttribute('#socials-row-0', 'data-kind');
    await o.focus('#socials-drag-0');
    await o.keyboard.press('Space');
    await o.keyboard.press('ArrowDown');
    await o.keyboard.press('Escape');
    expect((await o.getAttribute('#socials-row-0', 'data-kind')) === firstKind, 'escape did not put the first row back');
    expect(await o.$('#socials-editor'), 'escape on the handle closed the editor');
    await o.click('#socials-remove-2');
    await o.waitForSelector('#socials-row-3', { state: 'detached', timeout: 5000 });
    expect((await o.getAttribute('#socials-row-2', 'data-kind')) === 'github', 'github is not back in the third row');
    const back = await socialsOf(ME);
    expect(back.links.length === 3, `the api has ${back.links.length} links after edits that were not saved`);
    await o.click('#socials-done');
    await o.waitForSelector('#socials-editor', { state: 'detached', timeout: 5000 });
    expect((await shown(o)).length === 3, 'the strip is not the saved document after done');
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
