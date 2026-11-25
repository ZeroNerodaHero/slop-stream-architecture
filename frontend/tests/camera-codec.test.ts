import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type CodecProbe, type EncodeVerdict, isVp9Profile0, MIN_SOFTWARE_CORES, pickCodec, VP9_PROBE, vp8Only, vp9First } from '../src/infra/camera-codec.ts';

const CHROME = [
  { mimeType: 'video/VP8' },
  { mimeType: 'video/rtx' },
  { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
  { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=2' },
  { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1' },
  { mimeType: 'video/AV1' },
  { mimeType: 'video/red' }
];

const probe = (verdict: Partial<EncodeVerdict> | Error, extra: Partial<CodecProbe> = {}): CodecProbe => ({
  codecs: CHROME,
  cores: 8,
  encodingInfo: async (config) => {
    assert.deepEqual(config, VP9_PROBE);
    if (verdict instanceof Error) throw verdict;
    return { supported: true, smooth: false, powerEfficient: false, ...verdict };
  },
  ...extra
});

test('a hardware VP9 encoder is picked', async () => {
  assert.equal(await pickCodec(probe({ powerEfficient: true })), 'vp9');
  assert.equal(await pickCodec(probe({ powerEfficient: true }, { cores: 2 })), 'vp9');
});

test('a software VP9 encoder is picked only when it keeps up and the machine has the cores', async () => {
  assert.equal(await pickCodec(probe({ smooth: true })), 'vp9');
  assert.equal(await pickCodec(probe({ smooth: true }, { cores: MIN_SOFTWARE_CORES - 1 })), 'vp8');
  assert.equal(await pickCodec(probe({ smooth: false })), 'vp8');
});

test('VP8 when the browser cannot say, cannot encode VP9, or the question throws', async () => {
  assert.equal(await pickCodec(probe({ supported: false, powerEfficient: true })), 'vp8');
  assert.equal(await pickCodec(probe(new TypeError('webrtc type unknown'))), 'vp8');
  assert.equal(await pickCodec(probe({ powerEfficient: true }, { encodingInfo: undefined })), 'vp8');
  assert.equal(await pickCodec(probe({ powerEfficient: true }, { codecs: CHROME.filter((c) => c.mimeType !== 'video/VP9') })), 'vp8');
  assert.equal(await pickCodec(probe({ powerEfficient: true }, { codecs: CHROME.filter((c) => c.sdpFmtpLine !== 'profile-id=0') })), 'vp8');
  assert.equal(await pickCodec(probe({ powerEfficient: true }, { codecs: [] })), 'vp8');
});

test('the camera offers VP9 profile 0 first and keeps VP8 so an older server can still answer', () => {
  const order = vp9First(CHROME).map((c) => `${c.mimeType} ${c.sdpFmtpLine ?? ''}`.trim());
  assert.deepEqual(order, ['video/VP9 profile-id=0', 'video/VP8', 'video/rtx', 'video/H264 packetization-mode=1', 'video/AV1', 'video/red']);
});

test('the copy offers VP8 and its retransmissions only', () => {
  assert.deepEqual(
    vp8Only(CHROME).map((c) => c.mimeType),
    ['video/VP8', 'video/rtx']
  );
});

test('VP9 profile 0 is told apart from the other profiles', () => {
  assert.ok(isVp9Profile0({ mimeType: 'video/VP9' }));
  assert.ok(isVp9Profile0({ mimeType: 'video/vp9', sdpFmtpLine: 'profile-id=0' }));
  assert.ok(!isVp9Profile0({ mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=2' }));
  assert.ok(!isVp9Profile0({ mimeType: 'video/VP8' }));
});
