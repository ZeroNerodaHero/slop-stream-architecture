import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrangedAfterAdd, arrivedFrom, keptOf, layerOf, sceneOf, type Source, textPatched, textSource } from '../src/infra/scene.ts';
import { nameKey } from '../src/infra/source-settings.ts';
import {
  cleanText,
  kindOfStyle,
  paintText,
  readChat,
  readText,
  readTextStyle,
  readTimer,
  TEXT_MAX,
  TEXT_PRESETS,
  textLabel,
  textRadius,
  textShape,
  wrapText
} from '../src/infra/text-paint.ts';

const cam: Source = { id: 'cam', kind: 'camera', label: 'camera', slot: 0, box: { x: 0, y: 0, w: 1, h: 1 }, shown: true };

test('words are capped by letters, lose control characters and keep line breaks', () => {
  assert.equal([...cleanText('é'.repeat(TEXT_MAX + 5))].length, TEXT_MAX);
  assert.equal(cleanText('a\u0007b\r\nc\td'), 'ab\nc d');
  assert.equal(readText('   '), null);
  assert.equal(readText(42), null);
  assert.equal(readText('brb'), 'brb');
});

test('a text style is clamped and junk is dropped, so the video server never refuses it', () => {
  assert.deepEqual(readTextStyle({ size: 9, color: 'red', bg: '#ABCDEF', align: 'justify', shape: 'star' }), { size: 0.5, color: '#ffffff', bg: '#abcdef' });
  assert.deepEqual(readTextStyle({ size: 0, color: '#112233', align: 'left', shape: 'bubble' }), { size: 0.01, color: '#112233', align: 'left', shape: 'bubble' });
  assert.equal(readTextStyle({ color: '#ffffff' }), null);
  assert.equal(readTextStyle('big'), null);
});

test('timer and chat settings read like the video server checks them', () => {
  assert.deepEqual(readTimer({ mode: 'clock', start: 5 }), { mode: 'clock' });
  assert.deepEqual(readTimer({ mode: 'countdown', end: 1800000000000 }), { mode: 'countdown', end: 1800000000000 });
  assert.equal(readTimer({ mode: 'countdown' }), null);
  assert.deepEqual(readTimer({ mode: 'uptime', start: 1700000000000 }), { mode: 'uptime', start: 1700000000000 });
  assert.equal(readTimer({ mode: 'uptime', start: -1 }), null);
  assert.equal(readTimer({ mode: 'lap' }), null);
  assert.deepEqual(readChat({ lines: 8 }), { lines: 8 });
  assert.equal(readChat({ lines: 0 }), null);
  assert.equal(readChat({ lines: 21 }), null);
});

test('a text source goes out as a text layer with its words and style, and empty words stay off the stream', () => {
  const t = textSource('lower third', [cam]);
  assert.equal(t.id, 't1');
  assert.equal(t.kind, 'text');
  assert.deepEqual(t.box, TEXT_PRESETS['lower third'].box);
  const named = textPatched(t, { text: 'billy is live' });
  assert.equal(named.label, 'billy is live');
  assert.deepEqual(layerOf(named), { id: 't1', kind: 'text', text: 'billy is live', style: TEXT_PRESETS['lower third'].style, ...TEXT_PRESETS['lower third'].box });
  assert.deepEqual(
    sceneOf([cam, named]).layers.map((l) => l.kind),
    ['camera', 'text']
  );
  const empty = textPatched(named, { text: '  ' });
  assert.equal(empty.label, 'text');
  assert.deepEqual(
    sceneOf([cam, empty]).layers.map((l) => l.kind),
    ['camera']
  );
  assert.equal(textSource('label', [cam, t]).id, 't2');
  assert.equal(nameKey(t, false), 't1');
});

test('adding text keeps its own box and does not shuffle the videos', () => {
  const t = textSource('title', [cam]);
  const out = arrangedAfterAdd([cam, t], t, null);
  assert.deepEqual(out[0], cam);
  assert.deepEqual(out[1]!.box, TEXT_PRESETS.title.box);
  assert.equal(out[1]!.shown, true);
});

test('title, lower third and label are presets: each sets the style and the box, and colors and the background can be changed', () => {
  const t = textSource('lower third', []);
  assert.equal(kindOfStyle(t.style!), 'lower third');
  const title = textPatched(t, { kind: 'title' });
  assert.equal(kindOfStyle(title.style!), 'title');
  assert.equal(title.style!.bg, undefined);
  assert.deepEqual(title.box, TEXT_PRESETS.title.box);
  const label = textPatched(title, { kind: 'label' });
  assert.equal(kindOfStyle(label.style!), 'label');
  assert.equal(label.style!.bg, '#000000');
  const red = textPatched(label, { style: { color: '#ff0000', bg: undefined, shape: 'bubble' } });
  assert.equal(red.style!.color, '#ff0000');
  assert.equal('bg' in red.style!, false);
  assert.equal(red.style!.shape, 'bubble');
  assert.equal(kindOfStyle({ ...red.style!, size: 0.3 }), null);
});

test('a text label is the first line of the words, short', () => {
  assert.equal(textLabel('\n  hello   there \nsecond'), 'hello there');
  assert.equal(textLabel('x'.repeat(50)).length, 32);
  assert.equal(textLabel(''), 'text');
});

test('words wrap at spaces, a word too long for the box breaks, and line breaks are kept', () => {
  const measure = (s: string) => s.length;
  assert.deepEqual(wrapText(measure, 'one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrapText(measure, 'abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText(measure, 'a\nb c', 10), ['a', 'b c']);
  assert.deepEqual(wrapText(measure, 'hi abcdefgh', 4), ['hi', 'abcd', 'efgh']);
});

test('the background corner follows block, soft and bubble, and default follows the site shape', () => {
  assert.equal(textRadius('block', 100, 40), 0);
  assert.equal(textRadius('soft', 100, 40), 10);
  assert.equal(textRadius('bubble', 100, 40), 50);
  assert.equal(textShape({ size: 0.05, color: '#ffffff' }, 'soft'), 'soft');
  assert.equal(textShape({ size: 0.05, color: '#ffffff', shape: 'default' }, 'bubble'), 'bubble');
  assert.equal(textShape({ size: 0.05, color: '#ffffff', shape: 'block' }, 'bubble'), 'block');
});

type Call = [string, ...number[]] | [string, string, ...number[]];

function fakeCtx(calls: Call[]) {
  const state = { font: '', fillStyle: '', textAlign: '', textBaseline: '' };
  const px = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 0);
  return Object.assign(state, {
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => undefined,
    rect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h]),
    clip: () => undefined,
    roundRect: (x: number, y: number, w: number, h: number, r: number) => calls.push(['roundRect', x, y, w, h, r]),
    fill: () => calls.push(['fill', state.fillStyle]),
    measureText: (s: string) => ({ width: s.length * px() * 0.5 }),
    fillText: (s: string, x: number, y: number) => calls.push(['fillText', s, x, y])
  }) as unknown as CanvasRenderingContext2D;
}

const near = (a: Call[], b: Call[]) =>
  a.length === b.length && a.every((c, i) => c.length === b[i]!.length && c.every((v, j) => (typeof v === 'number' ? Math.abs(v - (b[i]![j] as number)) < 1e-6 : v === b[i]![j])));

test('the stream canvas and the studio canvas paint the same text: one painter, only the scale differs', () => {
  const layer = { x: 0.04, y: 0.78, w: 0.5, h: 0.12 };
  const paint = { text: 'billy is live with a long lower third that wraps', style: { size: 0.05, color: '#ffffff', bg: '#000000', align: 'left' as const }, shape: 'soft' as const };
  const stream: Call[] = [];
  const W = 1920;
  const H = 1080;
  paintText(fakeCtx(stream), { x: layer.x * W, y: layer.y * H, w: layer.w * W, h: layer.h * H }, paint, H);
  const studio: Call[] = [];
  const bw = 480;
  const bh = (bw / layer.w) * (9 / 16) * layer.h;
  paintText(fakeCtx(studio), { x: 0, y: 0, w: bw, h: bh }, paint, bh / layer.h);
  const k = bw / (layer.w * W);
  const scaled = stream.map((c): Call => {
    if (c[0] === 'fillText') return ['fillText', c[1] as string, ((c[2] as number) - layer.x * W) * k, ((c[3] as number) - layer.y * H) * k];
    if (c[0] === 'rect' || c[0] === 'roundRect') {
      const [, x, y, w, h, ...r] = c as [string, number, number, number, number, ...number[]];
      return [c[0], (x - layer.x * W) * k, (y - layer.y * H) * k, w * k, h * k, ...r.map((v) => v * k)];
    }
    return c;
  });
  assert.ok(near(scaled, studio), JSON.stringify({ scaled, studio }));
  assert.ok(stream.filter((c) => c[0] === 'fillText').length > 1, 'it wrapped');
  assert.ok(stream.some((c) => c[0] === 'fill' && c[1] === '#000000'), 'the background is painted');
});

test('without a background only the words are painted', () => {
  const calls: Call[] = [];
  paintText(fakeCtx(calls), { x: 0, y: 0, w: 800, h: 200 }, { text: 'brb', style: { size: 0.1, color: '#ffffff' }, shape: 'bubble' }, 1000);
  assert.equal(calls.some((c) => c[0] === 'roundRect'), false);
  assert.deepEqual(calls.find((c) => c[0] === 'fillText'), ['fillText', 'brb', 400, 100]);
});

test('a new text that reuses a saved id does not jump into the saved box', () => {
  const saved = keptOf([{ ...textSource('lower third', []), box: { x: 0.5, y: 0.5, w: 0.3, h: 0.1 } }]);
  const fresh = textSource('title', [cam]);
  assert.equal(arrivedFrom(saved, [cam], [cam, fresh])[1], fresh);
});
