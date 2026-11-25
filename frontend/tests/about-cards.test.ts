import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOCKS_MAX, TEXT_MAX } from '../src/infra/about.ts';
import {
  CARD_TITLES,
  CARD_X,
  PRESET_KEYS,
  TITLE_MAX,
  blankCard,
  blocksToCards,
  cardsToBlocks,
  cleanCard,
  htmlToText,
  overLimit,
  shownCards,
  withSavedIds,
  type Card,
  type CardKey
} from '../src/infra/about-cards.ts';
import type { PageWire } from '../src/infra/api.ts';

const CANON = /^(?:<h3>[^<]*<\/h3>)?<p>[^<]*<\/p>(?:<blockquote>[^<]*<\/blockquote>)?$/;

function server(blocks: PageWire[], start = 900): PageWire[] {
  let next = start;
  const seen = new Set<number>();
  return blocks.map((b) => {
    const id = b.type === 'text' && b.id === 0 ? next++ : b.id;
    assert.ok(!seen.has(id), 'a block is on the page twice');
    seen.add(id);
    const out: PageWire = {
      type: b.type,
      id,
      x: Math.min(1600, Math.max(0, b.x)),
      y: Math.min(1600, Math.max(0, b.y)),
      z: Math.min(40, Math.max(0, b.z)),
      w: 280,
      h: 120
    };
    if (b.type === 'text') {
      assert.match(b.html ?? '', CANON);
      assert.ok(new TextEncoder().encode(b.html ?? '').length < TEXT_MAX);
      out.html = b.html ?? '';
    } else out.src = `/api/streamers/wolf/about-file/${id}`;
    return out;
  });
}

function card(key: CardKey, part: Partial<Card> = {}): Card {
  return { ...blankCard(key), ...part };
}

function presets(parts: Partial<Record<CardKey, Partial<Card>>> = {}): Card[] {
  return PRESET_KEYS.map((key) => card(key, parts[key]));
}

const noIds = (cards: Card[]) => cards.map((c) => ({ ...cleanCard(c), ids: [] }));

function trip(cards: Card[]): Card[] {
  return blocksToCards(server(cardsToBlocks(cards)));
}

const picture = (id: number) => ({ key: `m${id}`, kind: 'image' as const, id, src: `/api/streamers/wolf/about-file/${id}` });

const FULL = presets({
  stream: { on: true, body: 'wolf cam, vtuber rigging tests and late night just chatting.\nmostly chill, sometimes i cook.' },
  when: { on: true, body: 'tue + thu 8pm ct, saturdays whenever' },
  setup: { on: false, body: 'shure sm7b\n\tgoxlr', title: 'the rig' },
  rules: { on: true, body: '1. be nice\n2. no spoilers\n3. english in chat pls <3 & "quotes" &amp;', media: [picture(41)] },
  links: { on: true, body: 'clips', link: 'https://example.com/a?b=1&c=2#x' },
  faq: { on: true, title: 'questions 🐺', body: 'café ok? yes', media: [{ key: 'm42', kind: 'sound', id: 42, src: '/s' }] }
});

test('an untouched page writes nothing and reads back as six off cards', () => {
  assert.deepEqual(cardsToBlocks(presets()), []);
  const cards = blocksToCards([]);
  assert.deepEqual(
    cards.map((c) => c.key),
    PRESET_KEYS
  );
  for (const c of cards) {
    assert.equal(c.on, false);
    assert.equal(c.title, CARD_TITLES[c.key]);
    assert.equal(c.body, '');
  }
  assert.deepEqual(shownCards(cards), []);
});

test('cards go to blocks and come back the same', () => {
  const back = trip(FULL);
  assert.deepEqual(noIds(back), noIds(FULL).map((c) => ({ ...c, media: c.media.map((m) => ({ ...m, src: `/api/streamers/wolf/about-file/${m.id}` })) })));
  const blocks = cardsToBlocks(FULL);
  assert.ok(blocks.every((b) => b.x === CARD_X));
  assert.deepEqual(
    blocks.map((b) => [b.type, b.y, b.z]),
    [
      ['text', 0, 1],
      ['text', 100, 1],
      ['text', 200, 0],
      ['text', 300, 1],
      ['image', 350, 1],
      ['text', 400, 1],
      ['text', 500, 1],
      ['sound', 550, 1]
    ]
  );
});

test('a second save of what came back is the same save', () => {
  const once = server(cardsToBlocks(FULL));
  const back = blocksToCards(once);
  const again = cardsToBlocks(back);
  assert.deepEqual(
    again,
    once.map(({ w: _w, h: _h, src: _src, ...b }) => b)
  );
});

test('an off card keeps what is in it', () => {
  const cards = presets({ setup: { on: false, title: 'the rig', body: 'sm7b', link: 'example.com/gear', media: [picture(7)] } });
  const back = trip(cards).find((c) => c.key === 'setup');
  assert.ok(back);
  assert.equal(back.on, false);
  assert.equal(back.title, 'the rig');
  assert.equal(back.body, 'sm7b');
  assert.equal(back.link, 'https://example.com/gear');
  assert.deepEqual(
    back.media.map((m) => m.id),
    [7]
  );
  assert.deepEqual(shownCards(trip(cards)), []);
});

test('a card that is on with nothing in it stays on and is not shown', () => {
  const back = trip(presets({ when: { on: true } }));
  assert.equal(back.find((c) => c.key === 'when')?.on, true);
  assert.deepEqual(shownCards(back), []);
});

test('a title falls back to the prompt and is cut at its limit', () => {
  const back = trip(presets({ stream: { on: true, title: '   ', body: 'x' }, when: { on: true, title: '', body: 'y' }, rules: { on: true, title: `${'r'.repeat(60)}\nsecond`, body: 'z' } }));
  assert.equal(back.find((c) => c.key === 'stream')?.title, 'what i stream');
  assert.equal(back.find((c) => c.key === 'when')?.title, "when i'm on");
  assert.equal(back.find((c) => c.key === 'rules')?.title, 'r'.repeat(TITLE_MAX));
});

test('a bad link is dropped and a bare one gets https', () => {
  const back = trip(presets({ links: { on: true, link: 'javascript:alert(1)', body: 'a' }, faq: { on: true, link: 'twitch.tv/wolf', body: 'b' } }));
  assert.equal(back.find((c) => c.key === 'links')?.link, '');
  assert.equal(back.find((c) => c.key === 'faq')?.link, 'https://twitch.tv/wolf');
});

test('control characters go, line breaks and tabs stay', () => {
  const back = trip(presets({ stream: { on: true, body: 'a\r\nb\u0007c\td\u0085e' } }));
  assert.equal(back[0]?.body, 'a\nbc\tde');
});

test('a long body splits across text blocks under the size cap and joins back', () => {
  for (const body of ['a'.repeat(25_000), '&🐺'.repeat(4000), `${'x'.repeat(9990)}🐺${'<'.repeat(3000)}`]) {
    const cards = presets({ faq: { on: true, body, link: 'https://example.com/' } });
    const blocks = cardsToBlocks(cards);
    assert.ok(blocks.length > 1);
    for (const b of blocks) assert.ok(new TextEncoder().encode(b.html ?? '').length < TEXT_MAX);
    const back = trip(cards).find((c) => c.key === 'faq');
    assert.equal(back?.body, body);
    assert.equal(back?.link, 'https://example.com/');
  }
});

test('more blocks than the page holds is caught before saving', () => {
  const media = Array.from({ length: BLOCKS_MAX }, (_, i) => picture(i + 1));
  const blocks = cardsToBlocks([...presets(), card('more', { on: true, media })]);
  assert.equal(blocks.length, BLOCKS_MAX + 1);
  assert.equal(overLimit(blocks), true);
  assert.equal(overLimit(cardsToBlocks(FULL)), false);
});

test('saved ids come back onto the cards and are reused', () => {
  const saved = server(cardsToBlocks(FULL), 500);
  const cards = withSavedIds(FULL, saved);
  assert.deepEqual(cards.find((c) => c.key === 'stream')?.ids, [500]);
  assert.deepEqual(
    cardsToBlocks(cards)
      .filter((b) => b.type === 'text')
      .map((b) => b.id),
    [500, 501, 502, 503, 504, 505]
  );
  const cleared = withSavedIds(
    cards.map((c) => (c.key === 'setup' ? blankCard('setup') : c)),
    server(cardsToBlocks(cards.map((c) => (c.key === 'setup' ? blankCard('setup') : c))))
  );
  assert.deepEqual(cleared.find((c) => c.key === 'setup')?.ids, []);
});

const legacyText = (id: number, x: number, y: number, html: string, z = 0): PageWire => ({ type: 'text', id, x, y, z, w: 400, h: 120, html });
const legacyFile = (type: 'image' | 'video' | 'sound', id: number, x: number, y: number): PageWire => ({ type, id, x, y, z: 0, w: 400, h: 180, src: `/api/streamers/wolf/about-file/${id}` });

test('a legacy text page lands in an on more card in reading order', () => {
  const cards = blocksToCards([
    legacyText(3, 400, 1, '<p>right of row two</p>'),
    legacyText(1, 0, 0, '<p>hello <b>there</b></p><p>second line<br>third</p>'),
    legacyText(2, 0, 1, '<ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>'),
    legacyText(4, 0, 2, '<p>see <a href="https://example.com/x?a=1&amp;b=2">my site</a> and <a href="https://example.com/">https://example.com/</a></p>'),
    legacyText(5, 0, 3, '<p>   </p>')
  ]);
  const more = cards.find((c) => c.key === 'more');
  assert.ok(more);
  assert.equal(more.on, true);
  assert.equal(more.title, 'more');
  assert.equal(
    more.body,
    'hello there\nsecond line\nthird\n\n- one\n- two\n1. a\n2. b\n\nright of row two\n\nsee my site (https://example.com/x?a=1&b=2) and https://example.com/'
  );
  assert.deepEqual(more.media, []);
  assert.deepEqual(
    cards.map((c) => c.key),
    [...PRESET_KEYS, 'more']
  );
  assert.deepEqual(
    shownCards(cards).map((c) => c.key),
    ['more']
  );
});

test('a legacy media page keeps every file in the more card', () => {
  const cards = blocksToCards([legacyFile('video', 12, 0, 1), legacyFile('image', 11, 0, 0), legacyFile('sound', 13, 400, 1)]);
  const more = cards.find((c) => c.key === 'more');
  assert.equal(more?.body, '');
  assert.deepEqual(
    more?.media.map((m) => [m.kind, m.id]),
    [
      ['image', 11],
      ['video', 12],
      ['sound', 13]
    ]
  );
});

test('a mixed legacy page drops only empty shapes', () => {
  const cards = blocksToCards([
    legacyText(1, 0, 0, '<h2>wolf hours</h2><p>hi</p>'),
    legacyFile('image', 2, 400, 0),
    { type: 'line', id: 3, x: 0, y: 1, z: 0, w: 200, h: 4 },
    { type: 'box', id: 4, x: 0, y: 2, z: 0, w: 200, h: 120, bg: '#ff0000' },
    { type: 'border', id: 5, x: 0, y: 3, z: 0 },
    legacyText(6, 0, 4, '<p>bye</p>')
  ]);
  const more = cards.find((c) => c.key === 'more');
  assert.equal(more?.body, 'wolf hours\nhi\n\nbye');
  assert.deepEqual(
    more?.media.map((m) => m.id),
    [2]
  );
});

test('an empty legacy page, or one of only shapes, has no more card', () => {
  for (const blocks of [[], [{ type: 'line', id: 3, x: 0, y: 0, z: 0 } as PageWire], [legacyText(1, 0, 0, '<p></p>')]]) {
    const cards = blocksToCards(blocks);
    assert.equal(
      cards.some((c) => c.key === 'more'),
      false
    );
    assert.deepEqual(shownCards(cards), []);
  }
});

test('a block at the card column but out of any slot is legacy', () => {
  const cards = blocksToCards([legacyText(1, CARD_X, 1500, '<p>far</p>'), legacyText(2, CARD_X, 60, '<p>odd</p>'), legacyFile('image', 3, CARD_X, 10)]);
  const more = cards.find((c) => c.key === 'more');
  assert.equal(more?.body, 'odd\n\nfar');
  assert.deepEqual(
    more?.media.map((m) => m.id),
    [3]
  );
});

test('a migrated page saves, loads and saves again unchanged', () => {
  const legacy = [legacyText(1, 0, 0, '<p>old words &amp; more</p>'), legacyFile('image', 2, 0, 1), legacyFile('video', 3, 400, 1), legacyText(4, 400, 0, '<p>beside</p>')];
  const migrated = blocksToCards(legacy);
  const firstSave = server(cardsToBlocks(migrated));
  assert.deepEqual(
    firstSave.map((b) => [b.type, b.id, b.y]),
    [
      ['text', 900, 600],
      ['image', 2, 650],
      ['video', 3, 651]
    ]
  );
  const loaded = blocksToCards(firstSave);
  assert.deepEqual(noIds(loaded), noIds(migrated));
  const secondSave = server(cardsToBlocks(withSavedIds(loaded, firstSave)));
  assert.deepEqual(secondSave, firstSave);
  assert.deepEqual(blocksToCards(secondSave), loaded);
});

test('legacy html with stray tags reads as plain text', () => {
  assert.equal(htmlToText('a &lt; b &amp; c'), 'a < b & c');
  assert.equal(htmlToText('<blockquote>q</blockquote><h3>t</h3>x<s>y</s>'), 'q\nt\nxy');
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>'), 'a\n\nb');
});
