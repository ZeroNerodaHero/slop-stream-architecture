import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newerBuild, progressText } from '../src/infra/update-check.ts';

test('a different build on the server is newer', () => {
  assert.equal(newerBuild('abc1234', { build: 'def5678' }), 'def5678');
});

test('the same build is not newer', () => {
  assert.equal(newerBuild('abc1234', { build: 'abc1234' }), null);
});

test('a dev build never asks to reload', () => {
  assert.equal(newerBuild('dev', { build: 'def5678' }), null);
});

test('a server answering dev or nothing usable is ignored', () => {
  assert.equal(newerBuild('abc1234', { build: 'dev' }), null);
  assert.equal(newerBuild('abc1234', { build: '' }), null);
  assert.equal(newerBuild('abc1234', { build: 7 }), null);
  assert.equal(newerBuild('abc1234', {}), null);
  assert.equal(newerBuild('abc1234', null), null);
  assert.equal(newerBuild('abc1234', '<!doctype html>'), null);
});

test('progress reads a percent when the size is known', () => {
  assert.equal(progressText(0, 200), 'downloading 0%');
  assert.equal(progressText(99, 200), 'downloading 49%');
  assert.equal(progressText(250, 200), 'downloading 100%');
});

test('progress reads megabytes when the size is unknown', () => {
  assert.equal(progressText(0, null), 'downloading');
  assert.equal(progressText(3 * 1024 * 1024, null), 'downloading 3.0 MB');
});
