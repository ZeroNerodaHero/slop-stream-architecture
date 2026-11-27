import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromWire } from '../src/infra/chat-wire.ts';
import { embedImageSrc, firstLink, linkEmbedOf } from '../src/infra/link-embed.ts';

const ID = '6b1e0c3a-7c2d-4e5f-9a10-11b12c13d14e';
const FULL = {
  url: 'https://en.wikipedia.org/wiki/Anime',
  site: 'Wikipedia',
  title: 'Anime',
  description: 'Anime is hand-drawn and computer-generated animation originating from Japan.',
  image: { id: ID, width: 864, height: 486 },
  color: '#3366CC'
};

test('linkEmbedOf reads a whole card', () => {
  assert.deepEqual(linkEmbedOf(FULL), { ...FULL, color: '#3366cc' });
});

test('linkEmbedOf is null without a title and a description, or without a web url', () => {
  for (const raw of [
    undefined,
    null,
    '',
    7,
    [],
    {},
    { url: FULL.url },
    { url: FULL.url, title: '  ', description: '' },
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'not a url', title: 'x' },
    { url: 42, title: 'x' },
    { title: 'x' }
  ]) {
    assert.equal(linkEmbedOf(raw), null, JSON.stringify(raw));
  }
});

test('linkEmbedOf keeps a card with only one of title and description', () => {
  assert.deepEqual(linkEmbedOf({ url: FULL.url, description: 'words' }), { url: FULL.url, description: 'words' });
  assert.deepEqual(linkEmbedOf({ url: FULL.url, title: 'name' }), { url: FULL.url, title: 'name' });
});

test('linkEmbedOf drops a bad picture or colour and keeps the rest', () => {
  for (const image of [{ id: 'nope', width: 10, height: 10 }, { id: ID, width: 0, height: 10 }, { id: ID, width: 10 }, { id: ID, width: 1.5, height: 10 }, 'x']) {
    assert.deepEqual(linkEmbedOf({ url: FULL.url, title: 'a', image }), { url: FULL.url, title: 'a' }, JSON.stringify(image));
  }
  for (const color of ['red', '#abc', 'url(x)', '#12345g', 7]) {
    assert.deepEqual(linkEmbedOf({ url: FULL.url, title: 'a', color }), { url: FULL.url, title: 'a' }, String(color));
  }
});

test('linkEmbedOf keeps text as text and cuts it', () => {
  const card = linkEmbedOf({ url: FULL.url, title: '<b>x</b>'.repeat(100), description: 'y'.repeat(900) });
  assert.equal(card?.title?.length, 200);
  assert.ok(card?.title?.startsWith('<b>x</b>'));
  assert.equal(card?.description?.length, 500);
});

test('the picture is our own chat picture', () => {
  assert.equal(embedImageSrc({ id: ID, width: 1, height: 1 }), `/api/chat-images/${ID}`);
});

test('fromWire reads the embed and drops a bad one', () => {
  const line = { id: '1-0', from: 'ann', text: 'look', streamer: false, verified: true, at: 1 };
  assert.deepEqual(fromWire({ ...line, embed: FULL }).embed, { ...FULL, color: '#3366cc' });
  assert.equal(fromWire({ ...line, embed: { url: FULL.url } }).embed, null);
  assert.equal(fromWire(line).embed, null);
});

test('firstLink finds the first http link the way the chat draws it', () => {
  assert.equal(firstLink('look https://en.wikipedia.org/wiki/Anime.'), 'https://en.wikipedia.org/wiki/Anime');
  assert.equal(firstLink('(see https://example.com/a_(b)) and http://two.example'), 'https://example.com/a_(b)');
  assert.equal(firstLink('xhttps://nope.example https://yes.example'), 'https://yes.example/');
  assert.equal(firstLink('【https://example.jp/】'), 'https://example.jp/');
  assert.equal(firstLink('www.example.com and ftp://x.example'), null);
  assert.equal(firstLink('no links here'), null);
  assert.equal(firstLink(''), null);
});
