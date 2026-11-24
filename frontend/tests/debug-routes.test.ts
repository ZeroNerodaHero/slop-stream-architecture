import assert from 'node:assert/strict';
import { test } from 'node:test';

import { METRIC_SIZE, ROUTE_MAX, RouteTimings } from '../src/infra/debug/rings.ts';
import { apiKey, normalizeRoute } from '../src/infra/debug/routes.ts';

test('routes lose their query, hash and ids', () => {
  assert.equal(normalizeRoute('/api/me'), '/api/me');
  assert.equal(normalizeRoute('/api/streams?x=1'), '/api/streams');
  assert.equal(normalizeRoute('/api/search?q=cats#top'), '/api/search');
  assert.equal(normalizeRoute('/api/stats/streams/42'), '/api/stats/streams/:id');
  assert.equal(normalizeRoute('/api/notifications/17'), '/api/notifications/:id');
  assert.equal(normalizeRoute('/api/things/0f8fad5b-d9cb-469f-a165-70867728950e'), '/api/things/:id');
  assert.equal(normalizeRoute('/api/things/deadbeef01'), '/api/things/:id');
  assert.equal(normalizeRoute('/api/things/aZ3_k9-QpL0xYw12Rt'), '/api/things/:id');
  assert.equal(normalizeRoute('/api/logout-all'), '/api/logout-all');
  assert.equal(normalizeRoute('/api/config/turnstile'), '/api/config/turnstile');
});

test('names after the app collections become :name, ids become :id', () => {
  assert.equal(normalizeRoute('/api/groups/cats'), '/api/groups/:name');
  assert.equal(normalizeRoute('/api/groups/cats/join'), '/api/groups/:name/join');
  assert.equal(normalizeRoute('/api/groups/cats/channels/general/pins/abc'), '/api/groups/:name/channels/:name/pins/:id');
  assert.equal(normalizeRoute('/api/groups/cats/channels/general/messages/9'), '/api/groups/:name/channels/:name/messages/:id');
  assert.equal(normalizeRoute('/api/groups/cats/members/bob/messages?before=3'), '/api/groups/:name/members/:name/messages');
  assert.equal(normalizeRoute('/api/groups/cats/voice/lounge/join'), '/api/groups/:name/voice/:name/join');
  assert.equal(normalizeRoute('/api/groups/cats/roles/r1/members/bob'), '/api/groups/:name/roles/:id/members/:name');
  assert.equal(normalizeRoute('/api/streams/dummy/watch'), '/api/streams/:name/watch');
  assert.equal(normalizeRoute('/api/streams/dummy/chat/x1'), '/api/streams/:name/chat/:id');
  assert.equal(normalizeRoute('/api/streamers/bob/thumbs/3'), '/api/streamers/:name/thumbs/:id');
  assert.equal(normalizeRoute('/api/streamers/messages/avatar'), '/api/streamers/:name/avatar');
  assert.equal(normalizeRoute('/api/dm/alice/read'), '/api/dm/:name/read');
  assert.equal(normalizeRoute('/api/jannies/alice'), '/api/jannies/:name');
  assert.equal(normalizeRoute('/api/oauth/github/start?link=1'), '/api/oauth/:name/start');
  assert.equal(normalizeRoute('/api/oauth/providers'), '/api/oauth/providers');
  assert.equal(normalizeRoute('/api/emotes/mine'), '/api/emotes/mine');
  assert.equal(normalizeRoute('/api/emotes/kekw'), '/api/emotes/:id');
  assert.equal(normalizeRoute('/api/notifications/read'), '/api/notifications/read');
  assert.equal(normalizeRoute('/api/notifications/settings'), '/api/notifications/settings');
  assert.equal(normalizeRoute('/api/chat-images/pic'), '/api/chat-images/:id');
  assert.equal(normalizeRoute('/api/groups'), '/api/groups');
});

test('only same-origin /api/ requests get a key, with the method', () => {
  const origin = 'https://app.test';
  assert.equal(apiKey('/api/streams/dummy/watch', { method: 'post' }, origin), 'POST /api/streams/:name/watch');
  assert.equal(apiKey('/api/me', undefined, origin), 'GET /api/me');
  assert.equal(apiKey(new URL('https://app.test/api/groups/cats'), { method: 'DELETE' }, origin), 'DELETE /api/groups/:name');
  assert.equal(apiKey(new Request('https://app.test/api/dm/bob', { method: 'PUT' }), undefined, origin), 'PUT /api/dm/:name');
  assert.equal(apiKey('https://other.test/api/me', undefined, origin), null);
  assert.equal(apiKey('/assets/app.js', undefined, origin), null);
  assert.equal(apiKey('/apiary', undefined, origin), null);
});

test('each route keeps its last 100 samples and counts errors among them', () => {
  const api = new RouteTimings();
  for (let i = 0; i < 150; i++) api.add('GET /api/me', i < 140 ? 200 : 500, i);
  api.add('GET /api/streams', 0, 7);
  assert.equal(api.values('GET /api/me').length, METRIC_SIZE);
  assert.equal(api.values('GET /api/me')[0], 50);
  assert.equal(api.errors('GET /api/me'), 10);
  assert.equal(api.errors('GET /api/streams'), 1);
  assert.equal(api.size(), METRIC_SIZE + 1);
  api.clear();
  assert.equal(api.size(), 0);
  assert.equal(api.routes.size, 0);
});

test('at most 60 routes, the least recently used goes first', () => {
  const api = new RouteTimings();
  assert.equal(ROUTE_MAX, 60);
  for (let i = 0; i < ROUTE_MAX; i++) api.add(`GET /r${i}`, 200, i);
  api.add('GET /r0', 200, 1);
  api.add('GET /new', 200, 1);
  assert.equal(api.routes.size, ROUTE_MAX);
  assert.ok(api.routes.has('GET /r0'));
  assert.ok(!api.routes.has('GET /r1'));
  assert.ok(api.routes.has('GET /new'));
  for (let i = 0; i < 500; i++) api.add(`GET /x${i}`, 200, i);
  assert.equal(api.routes.size, ROUTE_MAX);
});
