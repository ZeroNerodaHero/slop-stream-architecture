import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ITEMS_MAX,
  blankBlock,
  blockWord,
  cleanLink,
  compactCount,
  httpUrl,
  isBlank,
  joinedWord,
  markdownToHtml,
  moved,
  newId,
  spanOptions,
  weekdaysOf,
  wireBlock
} from '../src/infra/about-blocks.ts';

test('markdown becomes the same tags the server allows', () => {
  assert.equal(markdownToHtml("### hi i'm wolf\nvtuber rigger, late night\n**just chatting**"), "<h3>hi i'm wolf</h3><p>vtuber rigger, late night<br><strong>just chatting</strong></p>");
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
  const b = blankBlock('panel', { html: '<p>x</p>', href: 'javascript:alert(1)', link: 'discord.gg/wolf', items: Array.from({ length: 20 }, () => ({ file: 0, label: 'x', href: 'nope nope' })) });
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
});
