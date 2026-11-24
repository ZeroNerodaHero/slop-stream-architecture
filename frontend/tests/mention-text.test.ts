import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitMentions } from '../src/infra/mention-text.ts';

test('only names the server resolved become mentions', () => {
  assert.deepEqual(splitMentions('hi @bob and @carol', ['bob']), ['hi ', { mention: 'bob', text: '@bob' }, ' and @carol']);
});

test('no mentions keeps the text whole', () => {
  assert.deepEqual(splitMentions('hi @bob', undefined), ['hi @bob']);
  assert.deepEqual(splitMentions('hi @bob', []), ['hi @bob']);
  assert.deepEqual(splitMentions('hi bob', ['bob']), ['hi bob']);
});

test('case does not matter and the typed case is kept', () => {
  assert.deepEqual(splitMentions('@Bob!', ['bob']), [{ mention: 'bob', text: '@Bob' }, '!']);
});

test('an @ inside a word or an email is not a mention', () => {
  assert.deepEqual(splitMentions('mail a@bob.com', ['bob']), ['mail a@bob.com']);
  assert.deepEqual(splitMentions('x_@bob', ['bob']), ['x_@bob']);
});

test('punctuation and the start of the text are boundaries', () => {
  assert.deepEqual(splitMentions('(@bob), @bob', ['bob']), ['(', { mention: 'bob', text: '@bob' }, '), ', { mention: 'bob', text: '@bob' }]);
  assert.deepEqual(splitMentions('@@bob', ['bob']), ['@', { mention: 'bob', text: '@bob' }]);
});

test('a longer name is not cut down to a resolved one', () => {
  assert.deepEqual(splitMentions('@bobby', ['bob']), ['@bobby']);
  assert.deepEqual(splitMentions(`@${'a'.repeat(33)}`, ['a'.repeat(32)]), [`@${'a'.repeat(33)}`]);
});

test('text between links is split on its own', () => {
  assert.deepEqual(splitMentions(' and ', ['bob']), [' and ']);
  assert.deepEqual(splitMentions('see @bob ', ['bob']), ['see ', { mention: 'bob', text: '@bob' }, ' ']);
});
