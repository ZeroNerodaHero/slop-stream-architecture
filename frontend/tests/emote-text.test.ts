import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMOTE_NAME,
  type Emote,
  emoteIds,
  emoteQueryAt,
  encodeEmotesBy,
  isEmoteId,
  matchEmotes,
  MAX_ONLY_EMOTES,
  onlyEmotesBy,
  plainEmotesBy,
  splitEmotes,
  tokensAsTyped
} from '../src/infra/emote-text.ts';

const POG = '0b7c6c1e-4f0a-4c1e-9d55-6a1f5d3e2b10';
const KEK = '5f0e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const LUL = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const mine: Emote[] = [
  { id: POG, name: 'pog', group: 'lobby' },
  { id: KEK, name: 'kek', group: 'lobby' },
  { id: LUL, name: 'pog', group: 'other' }
];

const none = new Map<string, string>();
const gone = () => false;

test('a token splits out of the words around it', () => {
  assert.deepEqual(splitEmotes(`gg <:pog:${POG}> wp`), ['gg ', { name: 'pog', id: POG }, ' wp']);
  assert.deepEqual(splitEmotes(`<:pog:${POG}><:kek:${KEK}>`), [
    { name: 'pog', id: POG },
    { name: 'kek', id: KEK }
  ]);
  assert.deepEqual(splitEmotes('no emotes here'), ['no emotes here']);
  assert.deepEqual(splitEmotes(''), []);
});

test('an id in capitals is read in small letters', () => {
  assert.deepEqual(splitEmotes(`<:pog:${POG.toUpperCase()}>`), [{ name: 'pog', id: POG }]);
  assert.deepEqual(emoteIds(`a <:pog:${POG.toUpperCase()}> b <:kek:${KEK}>`), [POG, KEK]);
});

test('a broken token stays words', () => {
  for (const text of [
    `<:p:${POG}>`,
    `<:Pog:${POG}>`,
    `<:bad-name:${POG}>`,
    `<:pog:${POG.slice(0, 35)}>`,
    `<:pog:${POG}`,
    `<pog:${POG}>`,
    ':pog:',
    `<:${'a'.repeat(33)}:${POG}>`
  ]) {
    assert.deepEqual(splitEmotes(text), [text], text);
  }
});

test('a token shows as :name: in plain text, by the name it has now', () => {
  const text = `gg <:old:${POG}> and <:kek:${KEK}>`;
  assert.equal(
    plainEmotesBy(text, () => undefined),
    'gg :old: and :kek:'
  );
  assert.equal(
    plainEmotesBy(text, (id) => (id === POG ? 'pog' : undefined)),
    'gg :pog: and :kek:'
  );
  assert.equal(
    plainEmotesBy('nothing to do', () => 'x'),
    'nothing to do'
  );
});

test('tokens go back to what was typed', () => {
  assert.equal(tokensAsTyped(`hi <:pog:${POG}>!`), 'hi :pog:!');
  assert.equal(tokensAsTyped('hi :pog:'), 'hi :pog:');
});

test(':name: becomes a token for an emote of mine', () => {
  assert.equal(encodeEmotesBy('gg :pog: :kek:', mine, none), `gg <:pog:${POG}> <:kek:${KEK}>`);
  assert.equal(encodeEmotesBy('gg :nope:', mine, none), 'gg :nope:');
  assert.equal(encodeEmotesBy('gg :pog:', [], none), 'gg :pog:');
  assert.equal(encodeEmotesBy('no colons', mine, none), 'no colons');
});

test('a token already there is left alone', () => {
  const sent = `<:pog:${POG}>`;
  assert.equal(encodeEmotesBy(sent, mine, none), sent);
  assert.equal(encodeEmotesBy(`${sent} :kek:`, mine, none), `${sent} <:kek:${KEK}>`);
});

test('the first group wins a shared name unless one was picked', () => {
  assert.equal(encodeEmotesBy(':pog:', mine, none), `<:pog:${POG}>`);
  assert.equal(encodeEmotesBy(':pog:', mine, new Map([['pog', LUL]])), `<:pog:${LUL}>`);
  assert.equal(encodeEmotesBy(':pog:', mine, new Map([['pog', 'gone-id']])), `<:pog:${POG}>`);
});

test('a line of emotes alone is big, one with words is not', () => {
  assert.equal(onlyEmotesBy(splitEmotes(`<:pog:${POG}> <:kek:${KEK}>`), gone), true);
  assert.equal(onlyEmotesBy(splitEmotes(`gg <:pog:${POG}>`), gone), false);
  assert.equal(onlyEmotesBy(splitEmotes('   '), gone), false);
  assert.equal(
    onlyEmotesBy(splitEmotes(`<:pog:${POG}>`), (id) => id === POG),
    false
  );
  const many = `<:pog:${POG}>`.repeat(MAX_ONLY_EMOTES);
  assert.equal(onlyEmotesBy(splitEmotes(many), gone), true);
  assert.equal(onlyEmotesBy(splitEmotes(many + `<:pog:${POG}>`), gone), false);
});

test('the name rule and the id shape', () => {
  assert.ok(EMOTE_NAME.test('pog_2'));
  assert.ok(!EMOTE_NAME.test('p'));
  assert.ok(!EMOTE_NAME.test('Pog'));
  assert.ok(!EMOTE_NAME.test('a'.repeat(33)));
  assert.ok(isEmoteId(POG));
  assert.ok(isEmoteId(POG.toUpperCase()));
  assert.ok(!isEmoteId('👍'));
  assert.ok(!isEmoteId(`${POG}x`));
});

test('the composer asks for emotes after a colon', () => {
  assert.deepEqual(emoteQueryAt('gg :po', 6), { start: 3, query: 'po' });
  assert.deepEqual(emoteQueryAt(':PO', 3), { start: 0, query: 'po' });
  assert.equal(emoteQueryAt('gg :p', 5), null);
  assert.equal(emoteQueryAt('12:30', 5), null);
  assert.equal(emoteQueryAt('<:po', 4), null);
  assert.equal(emoteQueryAt('gg :pog: x', 10), null);
});

test('a name that starts with the query comes first', () => {
  const list: Emote[] = [
    { id: '1', name: 'kekw', group: 'g' },
    { id: '2', name: 'pogkek', group: 'g' },
    { id: '3', name: 'kek', group: 'g' }
  ];
  assert.deepEqual(
    matchEmotes(list, 'kek').map((e) => e.name),
    ['kekw', 'kek', 'pogkek']
  );
  assert.equal(matchEmotes(list, 'kek', 1).length, 1);
  assert.deepEqual(matchEmotes(list, 'zzz'), []);
});
