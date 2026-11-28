import { invoke } from '@tauri-apps/api/core';

import pcmWorkletUrl from '@/infra/restream-pcm-worklet.js?url';

export interface DirectTarget {
  id: string;
  platform: string;
  url: string;
  key: string;
}

export interface DirectStatus {
  id: string;
  state: 'connecting' | 'live' | 'error' | 'off';
  message: string | null;
}

export interface DirectShape {
  width: number;
  height: number;
  fps: number;
  videoKbps: number;
  audioKbps: number;
}

const VIDEO_CODECS = ['avc1.42e028', 'avc1.42e01f'];
const AUDIO_RATE = 48000;
const AUDIO_FRAMES = 1024;
const KEY_SECONDS = 2;
const MOST_IN_FLIGHT = 90;
const MOST_QUEUED = 4;
const DRIFT_US = 250_000;
const POLL_MS = 1000;
const FALLBACK_ASC = new Uint8Array([0x11, 0x90]);

const VIDEO_CONFIG = 0;
const VIDEO_FRAME = 1;
const AUDIO_CONFIG = 2;
const AUDIO_FRAME = 3;

function audioConfig(shape: DirectShape): AudioEncoderConfig {
  return { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: shape.audioKbps * 1000 };
}

export async function directVideoConfig(shape: DirectShape): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof VideoFrame === 'undefined' || typeof AudioData === 'undefined') return null;
  try {
    await invoke('restream_direct_ready');
  } catch {
    return null;
  }
  const audio = await AudioEncoder.isConfigSupported(audioConfig(shape)).catch(() => null);
  if (!audio?.supported) return null;
  for (const codec of VIDEO_CODECS) {
    for (const bitrateMode of ['constant', undefined] as const) {
      const config: VideoEncoderConfig = {
        codec,
        width: shape.width,
        height: shape.height,
        bitrate: shape.videoKbps * 1000,
        framerate: shape.fps,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
        ...(bitrateMode ? { bitrateMode } : {})
      };
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (support?.supported) return config;
    }
  }
  return null;
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  return new Uint8Array(source as ArrayBufferLike);
}

function packet(kind: number, key: boolean, us: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + data.byteLength);
  out[0] = kind;
  out[1] = key ? 1 : 0;
  new DataView(out.buffer).setUint32(2, Math.max(0, Math.round(us / 1000)) >>> 0);
  out.set(data, 6);
  return out;
}

export class DirectSender {
  private readonly shape: DirectShape;
  private readonly video: VideoEncoder;
  private audio: AudioEncoder | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly t0 = performance.now();
  private frames = 0;
  private inFlight = 0;
  private needKey = true;
  private closed = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private audioAt: number | null = null;
  private samples = 0;
  private sentAudioConfig = false;

  private constructor(shape: DirectShape, config: VideoEncoderConfig, onError: (why: string) => void) {
    this.shape = shape;
    this.video = new VideoEncoder({
      output: (chunk, meta) => {
        const description = meta?.decoderConfig?.description;
        if (description) this.send(packet(VIDEO_CONFIG, true, 0, bytesOf(description)));
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.send(packet(VIDEO_FRAME, chunk.type === 'key', chunk.timestamp, data));
      },
      error: (e) => {
        if (!this.closed) onError(`the video encoder stopped: ${e.message}`);
      }
    });
    this.video.configure(config);
  }

  static async open(
    targets: DirectTarget[],
    shape: DirectShape,
    config: VideoEncoderConfig,
    sound: MediaStreamTrack | null,
    onStatus: (list: DirectStatus[]) => void,
    onError: (why: string) => void
  ): Promise<DirectSender> {
    await invoke('restream_direct_start', {
      targets,
      shape: { width: shape.width, height: shape.height, fps: shape.fps, video_kbps: shape.videoKbps, audio_kbps: shape.audioKbps }
    });
    const sender = new DirectSender(shape, config, onError);
    try {
      await sender.openAudio(sound, onError);
    } catch (err) {
      sender.stop();
      throw err;
    }
    sender.poll = setInterval(() => {
      void invoke<DirectStatus[]>('restream_direct_status')
        .then((list) => {
          if (!sender.closed) onStatus(list);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return sender;
  }

  private async openAudio(sound: MediaStreamTrack | null, onError: (why: string) => void) {
    this.audio = new AudioEncoder({
      output: (chunk, meta) => {
        const description = meta?.decoderConfig?.description;
        if (description || !this.sentAudioConfig) {
          this.send(packet(AUDIO_CONFIG, false, 0, description ? bytesOf(description) : FALLBACK_ASC));
          this.sentAudioConfig = true;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.send(packet(AUDIO_FRAME, false, chunk.timestamp, data));
      },
      error: (e) => {
        if (!this.closed) onError(`the sound encoder stopped: ${e.message}`);
      }
    });
    this.audio.configure(audioConfig(this.shape));
    const ctx = new AudioContext({ sampleRate: AUDIO_RATE });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(pcmWorkletUrl);
    const node = new AudioWorkletNode(ctx, 'restream-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node = node;
    node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => this.pcm(e.data);
    if (sound) ctx.createMediaStreamSource(new MediaStream([sound])).connect(node);
    else {
      const quiet = ctx.createConstantSource();
      quiet.offset.value = 0;
      quiet.connect(node);
      quiet.start();
    }
    node.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  }

  private pcm(data: Float32Array<ArrayBuffer>) {
    if (this.closed || !this.audio || this.audio.state !== 'configured') return;
    const now = (performance.now() - this.t0) * 1000;
    const span = (AUDIO_FRAMES / AUDIO_RATE) * 1_000_000;
    let at = this.audioAt === null ? now - span : this.audioAt + (this.samples / AUDIO_RATE) * 1_000_000;
    if (this.audioAt === null || Math.abs(at - (now - span)) > DRIFT_US) {
      this.audioAt = now - span;
      this.samples = 0;
      at = this.audioAt;
    }
    this.samples += AUDIO_FRAMES;
    const audio = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: AUDIO_FRAMES, numberOfChannels: 2, timestamp: Math.round(at), data });
    this.audio.encode(audio);
    audio.close();
  }

  frame(canvas: HTMLCanvasElement) {
    if (this.closed || this.video.state !== 'configured') return;
    if (this.video.encodeQueueSize > MOST_QUEUED || this.inFlight > MOST_IN_FLIGHT) {
      this.needKey = true;
      return;
    }
    const key = this.needKey || this.frames % (this.shape.fps * KEY_SECONDS) === 0;
    const frame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - this.t0) * 1000) });
    try {
      this.video.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
    if (key) this.needKey = false;
    this.frames += 1;
  }

  private send(p: Uint8Array) {
    if (this.closed) return;
    this.inFlight += 1;
    void invoke('restream_direct_packet', p)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight -= 1;
      });
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.video.state !== 'closed') this.video.close();
    if (this.audio && this.audio.state !== 'closed') this.audio.close();
    this.node?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    void invoke('restream_direct_stop').catch(() => undefined);
  }
}
