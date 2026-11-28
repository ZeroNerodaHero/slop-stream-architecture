import { useCallback, useEffect, useRef, useState } from 'react';

import { AUDIO_BITS_PER_SECOND, MAX_AUDIO_BYTES, MAX_AUDIO_MS, micRefusal, peaksFrom, pickRecorderType, VOICE_CONSTRAINTS } from '@/infra/chat-audio';
import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import { HERE } from '@/infra/here';

export type RecorderPhase = 'idle' | 'asking' | 'recording' | 'stopped';

export interface RecordedClip {
  blob: Blob;
  durationMs: number;
  url: string;
  peaks?: number[];
}

export interface VoiceRecorder {
  phase: RecorderPhase;
  elapsedMs: number;
  levels: number[];
  clip: RecordedClip | null;
  start: () => void;
  stop: () => void;
  stopThen: (done: (clip: RecordedClip) => void) => void;
  cancel: () => void;
  discard: () => void;
}

const TICK_MS = 100;
export const LIVE_BARS = 34;
const SLICE_MS = 1000;
const BYTES_HEADROOM = 64 * 1024;

interface Take {
  stream: MediaStream;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  bytes: number;
  startedAt: number;
  dropped: boolean;
  after: ((clip: RecordedClip) => void) | null;
  meter: MicLevel | null;
  heard: number[];
}

function hush(now: Take) {
  now.meter?.close();
  now.meter = null;
}

function meterOf(stream: MediaStream): MicLevel | null {
  const track = stream.getAudioTracks()[0];
  if (!track) return null;
  try {
    return openMicLevel(track);
  } catch {
    return null;
  }
}

function release(stream: MediaStream | null) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function useVoiceRecorder(onError: (words: string) => void): VoiceRecorder {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const said = useRef(onError);
  useEffect(() => {
    said.current = onError;
  }, [onError]);
  const fail = useCallback((words: string) => said.current(words), []);
  const take = useRef<Take | null>(null);
  const asking = useRef(0);
  const clipRef = useRef<RecordedClip | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const keepClip = useCallback((next: RecordedClip | null) => {
    if (clipRef.current && clipRef.current !== next) URL.revokeObjectURL(clipRef.current.url);
    clipRef.current = next;
    setClip(next);
  }, []);

  const end = useCallback(
    (dropped: boolean) => {
      asking.current += 1;
      stopTimer();
      const now = take.current;
      if (!now) return;
      hush(now);
      now.dropped = now.dropped || dropped;
      if (now.recorder && now.recorder.state !== 'inactive') {
        try {
          now.recorder.stop();
        } catch {
          release(now.stream);
          take.current = null;
        }
      } else {
        release(now.stream);
        take.current = null;
      }
      if (dropped) {
        release(now.stream);
        take.current = null;
        setPhase('idle');
        setElapsedMs(0);
      }
    },
    [stopTimer]
  );

  const start = useCallback(() => {
    if (take.current || phase === 'asking') return;
    keepClip(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      fail(`${HERE} cannot record`);
      return;
    }
    const ask = ++asking.current;
    setPhase('asking');
    setElapsedMs(0);
    setLevels([]);
    navigator.mediaDevices.getUserMedia(VOICE_CONSTRAINTS).then(
      (stream) => {
        if (ask !== asking.current) {
          release(stream);
          return;
        }
        const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
        } catch {
          release(stream);
          setPhase('idle');
          fail(`${HERE} cannot record`);
          return;
        }
        const now: Take = { stream, recorder, chunks: [], bytes: 0, startedAt: Date.now(), dropped: false, after: null, meter: meterOf(stream), heard: [] };
        take.current = now;
        recorder.ondataavailable = (e) => {
          if (e.data.size === 0) return;
          now.chunks.push(e.data);
          now.bytes += e.data.size;
          if (now.bytes >= MAX_AUDIO_BYTES - BYTES_HEADROOM && recorder.state === 'recording') recorder.stop();
        };
        recorder.onerror = () => {
          now.dropped = true;
          hush(now);
          fail('recording stopped');
          if (recorder.state !== 'inactive') recorder.stop();
          else {
            release(stream);
            if (take.current === now) take.current = null;
            setPhase('idle');
          }
        };
        recorder.onstop = () => {
          hush(now);
          release(stream);
          if (take.current === now) take.current = null;
          stopTimer();
          const durationMs = Math.min(MAX_AUDIO_MS, Date.now() - now.startedAt);
          const blob = new Blob(now.chunks, { type: recorder.mimeType || type || now.chunks[0]?.type || 'audio/webm' });
          if (now.dropped || blob.size === 0) {
            if (!now.dropped) fail('nothing was recorded');
            setPhase('idle');
            setElapsedMs(0);
            return;
          }
          const peaks = peaksFrom(now.heard);
          const kept: RecordedClip = peaks ? { blob, durationMs, url: URL.createObjectURL(blob), peaks } : { blob, durationMs, url: URL.createObjectURL(blob) };
          setElapsedMs(durationMs);
          if (now.after) {
            URL.revokeObjectURL(kept.url);
            keepClip(null);
            setPhase('idle');
            setElapsedMs(0);
            now.after(kept);
            return;
          }
          keepClip(kept);
          setPhase('stopped');
        };
        try {
          recorder.start(SLICE_MS);
        } catch {
          release(stream);
          take.current = null;
          setPhase('idle');
          fail(`${HERE} cannot record`);
          return;
        }
        setPhase('recording');
        stopTimer();
        timer.current = setInterval(() => {
          const ms = Date.now() - now.startedAt;
          setElapsedMs(ms);
          if (now.meter) {
            now.heard.push(now.meter.read(performance.now()));
            setLevels(now.heard.slice(-LIVE_BARS));
          }
          if (ms >= MAX_AUDIO_MS && recorder.state === 'recording') recorder.stop();
        }, TICK_MS);
      },
      (err: unknown) => {
        if (ask !== asking.current) return;
        setPhase('idle');
        fail(micRefusal(err));
      }
    );
  }, [phase, keepClip, stopTimer, fail]);

  const stop = useCallback(() => end(false), [end]);

  const stopThen = useCallback(
    (done: (clip: RecordedClip) => void) => {
      if (take.current) take.current.after = done;
      end(false);
    },
    [end]
  );

  const cancel = useCallback(() => {
    end(true);
    keepClip(null);
    setPhase('idle');
    setElapsedMs(0);
  }, [end, keepClip]);

  const discard = useCallback(() => {
    keepClip(null);
    setPhase('idle');
    setElapsedMs(0);
  }, [keepClip]);

  useEffect(
    () => () => {
      asking.current += 1;
      if (timer.current) clearInterval(timer.current);
      const now = take.current;
      take.current = null;
      if (now) {
        now.dropped = true;
        hush(now);
        if (now.recorder && now.recorder.state !== 'inactive') {
          try {
            now.recorder.stop();
          } catch {
            release(now.stream);
          }
        }
        release(now.stream);
      }
      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
      clipRef.current = null;
    },
    []
  );

  return { phase, elapsedMs, levels, clip, start, stop, stopThen, cancel, discard };
}
