import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
// oxlint-disable-next-line import/default
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import { Channel, invoke } from '@tauri-apps/api/core';

import pcmWorkletUrl from '@/infra/native-pcm-worklet.js?url';
import gateWorkletUrl from '@/infra/voice-gate-worklet.js?url';

export interface NativeAudio {
  track: MediaStreamTrack;
  stop(): void;
}

export interface NativeMic extends NativeAudio {
  setSuppress(on: boolean): Promise<boolean>;
  setGate(on: boolean): void;
}

export interface NativeInput {
  id: string;
  name: string;
  default: boolean;
}

export interface MicProcessing {
  suppress: boolean;
  gate: boolean;
}

type Denoiser = AudioWorkletNode & { destroy(): void };

const GATE_DB = -50;

export function errorText(err: unknown): string {
  if (typeof err === 'string' && err) return err;
  if (err instanceof Error && err.message) return err.message;
  return 'it did not start';
}

export function bytesOf(raw: unknown): ArrayBuffer | null {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]).buffer;
  return null;
}

export function listNativeMics(): Promise<NativeInput[]> {
  return invoke<NativeInput[]>('list_input_devices');
}

async function feed(ctx: AudioContext, channels: 1 | 2, start: (channel: Channel<unknown>) => Promise<unknown>): Promise<AudioWorkletNode> {
  await ctx.audioWorklet.addModule(pcmWorkletUrl);
  const node = new AudioWorkletNode(ctx, 'native-pcm', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: { channels }
  });
  const channel = new Channel<unknown>((raw) => {
    const buf = bytesOf(raw);
    if (buf && buf.byteLength) node.port.postMessage(buf, [buf]);
  });
  await start(channel);
  return node;
}

function trackOf(ctx: AudioContext, last: AudioNode, release: () => void): NativeAudio {
  const out = ctx.createMediaStreamDestination();
  last.connect(out);
  const track = out.stream.getAudioTracks()[0]!;
  const stopTrack = track.stop.bind(track);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopTrack();
    release();
    void ctx.close().catch(() => undefined);
  };
  track.stop = stop;
  return { track, stop };
}

let rnnoiseWasm: Promise<ArrayBuffer> | null = null;

async function denoiser(ctx: AudioContext): Promise<Denoiser> {
  const { loadRnnoise, RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');
  rnnoiseWasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((err: unknown) => {
    rnnoiseWasm = null;
    throw err;
  });
  const [wasmBinary] = await Promise.all([rnnoiseWasm, ctx.audioWorklet.addModule(rnnoiseWorkletUrl)]);
  const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  node.channelCount = 1;
  node.channelCountMode = 'explicit';
  return node;
}

let micToken: object | null = null;

export async function openNativeMic(ctx: AudioContext, id: string, processing: MicProcessing): Promise<NativeMic> {
  const token = {};
  const was = micToken;
  micToken = token;
  let denoise: Denoiser | null = null;
  try {
    await ctx.audioWorklet.addModule(gateWorkletUrl);
    if (processing.suppress) denoise = await denoiser(ctx).catch(() => null);
    const gate = new AudioWorkletNode(ctx, 'voice-gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    gate.connect(limiter);
    const source = await feed(ctx, 1, (channel) => invoke('start_mic', { id, channel }));
    const wire = (suppress: boolean) => {
      source.disconnect();
      denoise?.disconnect();
      if (suppress && denoise) source.connect(denoise).connect(gate);
      else source.connect(gate);
    };
    const setGate = (on: boolean) => gate.parameters.get('threshold')?.setValueAtTime(on ? 10 ** (GATE_DB / 20) : 0, ctx.currentTime);
    wire(processing.suppress);
    setGate(processing.gate);
    const base = trackOf(ctx, limiter, () => {
      denoise?.destroy();
      if (micToken !== token) return;
      micToken = null;
      void invoke('stop_mic').catch(() => undefined);
    });
    return {
      ...base,
      async setSuppress(on) {
        if (on && !denoise) denoise = await denoiser(ctx).catch(() => null);
        wire(on);
        return !on || denoise !== null;
      },
      setGate
    };
  } catch (err) {
    denoise?.destroy();
    if (micToken === token) micToken = was;
    void ctx.close().catch(() => undefined);
    throw err;
  }
}
