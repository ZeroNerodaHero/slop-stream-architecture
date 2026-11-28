import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ITEMS_MAX,
  placed,
  slotAt,
  slotIn,
  blankBlock,
  blockWord,
  cleanHex,
  hexToHsv,
  hsvToHex,
  inkOn,
  cleanLink,
  compactCount,
  httpUrl,
  isBlank,
  joinedWord,
  kindWord,
  markdownToHtml,
  moved,
  newId,
  spanOptions,
  weekdaysOf,
  wireBlock
} from '../src/infra/about-blocks.ts';

test('markdown becomes the same tags the server allows', () => {
  assert.equal(
    markdownToHtml("### hi i'm wolf\nvtuber rigger, late night\n**just chatting**"),
    "<h3>hi i'm wolf</h3><p>vtuber rigger, late night<br><strong>just chatting</strong></p>"
  );
  assert.equal(markdownToHtml('# big'), '<h2>big</h2>');
  assert.equal(markdownToHtml('1. be nice\n2. no spoilers'), '<ol><li>be nice</li><li>no spoilers</li></ol>');
  assert.equal(markdownToHtml('- **cam** iphone\n- mic'), '<ul><li><strong>cam</strong> iphone</li><li>mic</li></ul>');
  assert.equal(markdownToHtml('> quoted\n> more'), '<blockquote>quoted<br>more</blockquote>');
  assert.equal(markdownToHtml('one\n\ntwo'), '<p>one</p><p>two</p>');
  assert.equal(markdownToHtml('*i* _e_ __u__ ~~s~~'), '<p><em>i</em> <em>e</em> <u>u</u> <s>s</s></p>');
  assert.equal(markdownToHtml('snake_case_word and 2 * 3 * 4'), '<p>snake_case_word and 2 * 3 * 4</p>');
  assert.equal(markdownToHtml('  \n '), '');
});

test('markdown links are http or plain words', () => {
  assert.equal(markdownToHtml('[kit](https://kit.co/wolf)'), '<p><a href="https://kit.co/wolf">kit</a></p>');
  assert.equal(markdownToHtml('[bad](javascript:alert(1))'), '<p>bad)</p>');
  assert.equal(markdownToHtml('see https://wolfhours.art.'), '<p>see <a href="https://wolfhours.art/">https://wolfhours.art</a>.</p>');
  assert.equal(
    markdownToHtml('[a [b](https://x.example)](https://y.example)'),
    '<p><a href="https://x.example/">a [b</a>](<a href="https://y.example/">https://y.example</a>)</p>'
  );
});

test('markdown cannot smuggle html', () => {
  assert.equal(markdownToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(markdownToHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(markdownToHtml('[x](https://a.example/"onclick="y)'), '<p><a href="https://a.example/%22onclick=%22y">x</a></p>');
  assert.equal(markdownToHtml('\\*not em\\*'), '<p>*not em*</p>');
});

test('links are http or https only', () => {
  assert.equal(httpUrl('https://kit.co/wolf'), 'https://kit.co/wolf');
  assert.equal(httpUrl('javascript:alert(1)'), null);
  assert.equal(httpUrl('https://user:pw@x.example'), null);
  assert.equal(httpUrl('ftp://x.example'), null);
  assert.equal(cleanLink(''), '');
  assert.equal(cleanLink('kit.co/wolf'), 'https://kit.co/wolf');
  assert.equal(cleanLink('data:text/html,hi'), null);
});

test('wire blocks drop html and bad links', () => {
  const b = blankBlock('panel', {
    html: '<p>x</p>',
    href: 'javascript:alert(1)',
    link: 'discord.gg/wolf',
    items: Array.from({ length: 20 }, () => ({ file: 0, label: 'x', href: 'nope nope' }))
  });
  const w = wireBlock(b);
  assert.equal('html' in w, false);
  assert.equal(w.href, '');
  assert.equal(w.link, 'https://discord.gg/wolf');
  assert.equal(w.items.length, ITEMS_MAX);
  assert.equal(w.items[0]?.href, '');
});

test('ids fit the server rule', () => {
  for (let i = 0; i < 50; i++) assert.match(newId(), /^b[a-z0-9]{10}$/);
});

test('numbers and dates read short', () => {
  assert.equal(compactCount(214), '214');
  assert.equal(compactCount(1234), '1.2K');
  assert.equal(compactCount(48_200), '48K');
  assert.equal(compactCount(2_350_000), '2.3M');
  assert.equal(joinedWord('2026-10-04T12:00:00Z'), "OCT '26");
  assert.equal(joinedWord(null), '');
});

test('weekdays come from session starts, monday first', () => {
  const on = weekdaysOf(['2026-11-23T20:00:00', '2026-11-29T20:00:00', 'nope']);
  assert.deepEqual(on, [true, false, false, false, false, false, true]);
});

test('spans offer the current width', () => {
  assert.deepEqual(spanOptions(6), [3, 4, 6, 8, 12]);
  assert.deepEqual(spanOptions(7), [3, 4, 6, 7, 8, 12]);
});

test('moving keeps every block', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moved(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moved(['a', 'b'], 5, 0), ['a', 'b']);
});

test('blank blocks stay off the viewer page', () => {
  assert.equal(isBlank(blankBlock('text'), 0), true);
  assert.equal(isBlank(blankBlock('text', { md: 'hi' }), 0), false);
  assert.equal(isBlank(blankBlock('socials'), 0), true);
  assert.equal(isBlank(blankBlock('socials'), 2), false);
  assert.equal(isBlank(blankBlock('image'), 0), true);
  assert.equal(isBlank(blankBlock('stats'), 0), false);
  assert.equal(blockWord(blankBlock('text', { md: '### hi there' })), 'text · hi there');
  assert.equal(kindWord('buttons'), 'links');
  assert.equal(kindWord('gallery'), 'gallery');
  assert.equal(blockWord(blankBlock('buttons', { items: [{ file: 0, label: 'discord', href: '' }] })), 'links · discord');
});

test('colors are #rrggbb in lowercase or nothing', () => {
  assert.equal(cleanHex('#FF00AA'), '#ff00aa');
  assert.equal(cleanHex(' 1fa58c '), '#1fa58c');
  for (const bad of ['', '#fff', 'red', '#12345g', '#1234567', 'url(x)']) assert.equal(cleanHex(bad), null);
  for (const hex of ['#000000', '#ffffff', '#5b3ea6', '#1fa58c', '#c4772b', '#ff0000', '#00ff00', '#0000ff', '#808080']) assert.equal(hsvToHex(hexToHsv(hex)), hex);
  assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
  assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), '#00ff00');
  assert.equal(inkOn('#ffffff'), '#000000');
  assert.equal(inkOn('#0d1530'), '#ffffff');
});

test('a block on the wire carries only good colors', () => {
  const b = wireBlock(blankBlock('heading', { accent: '#ABCDEF', paint: 'nope', ink: '#ffffff', from: '#0D1530', to: '#fff' }));
  assert.deepEqual([b.accent, b.paint, b.ink, b.edge, b.tint, b.from, b.to], ['#abcdef', '', '#ffffff', '', '', '#0d1530', '']);
});

const ids = (list: { id: string }[]) => list.map((b) => b.id).join('');

test('placed moves a block to a slot counted without it', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(ids(placed(list, 'a', 2)), 'bcad');
  assert.equal(ids(placed(list, 'd', 0)), 'dabc');
  assert.equal(ids(placed(list, 'b', 1)), 'abcd');
  assert.equal(ids(placed(list, 'b', 99)), 'acdb');
  assert.equal(ids(placed(list, 'c', -4)), 'cabd');
  assert.equal(ids(placed(list, 'zz', 1)), 'abcd');
  assert.equal(list.length, 4);
});

test('placed inserts a new block when one is given', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.equal(ids(placed(list, 'n', 1, { id: 'n' })), 'anb');
  assert.equal(ids(placed(list, 'n', 5, { id: 'n' })), 'abn');
});

test('slotAt reads the grid in rows: left half is before, right half is after', () => {
  const row = [
    { left: 0, top: 0, right: 100, bottom: 50 },
    { left: 110, top: 0, right: 210, bottom: 50 },
    { left: 0, top: 60, right: 210, bottom: 110 }
  ];
  assert.equal(slotAt(row, 20, 25), 0);
  assert.equal(slotAt(row, 80, 25), 1);
  assert.equal(slotAt(row, 130, 25), 1);
  assert.equal(slotAt(row, 200, 25), 2);
  assert.equal(slotAt(row, 50, 80), 2);
  assert.equal(slotAt(row, 180, 80), 3);
  assert.equal(slotAt(row, 300, 25), 2);
  assert.equal(slotAt(row, 50, 400), 3);
  assert.equal(slotAt(row, 50, -40), 0);
  assert.equal(slotAt([], 5, 5), 0);
});

test('slotIn maps a slot among shown blocks onto the whole list', () => {
  const rest = ['a', 'b', 'c', 'd'];
  assert.equal(slotIn(rest, ['a', 'c', 'd'], 0), 0);
  assert.equal(slotIn(rest, ['a', 'c', 'd'], 1), 2);
  assert.equal(slotIn(rest, ['a', 'c'], 2), 3);
  assert.equal(slotIn(rest, ['a', 'b', 'c', 'd'], 4), 4);
  assert.equal(slotIn(rest, [], 0), 4);
});
