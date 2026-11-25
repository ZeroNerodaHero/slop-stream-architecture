import { RiCameraOffLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_DEVICE,
  gateFraction,
  holdVoiceMic,
  keyName,
  openVoiceCamera,
  playTestTone,
  PTT_DELAY_MAX,
  readVoiceMicLevel,
  refreshVoiceDevices,
  releaseVoiceMic,
  setVoiceAutoGain,
  setVoiceCamera,
  setVoiceEchoCancellation,
  setVoiceGate,
  setVoiceInput,
  setVoiceIsolation,
  setVoiceMode,
  setVoiceOutput,
  setVoicePttDelay,
  setVoicePttKey,
  SINK_SUPPORTED,
  type VoiceDevice,
  type VoiceMode,
  voiceAutoGainAtom,
  voiceCameraAtom,
  voiceDevicesAtom,
  voiceEchoCancellationAtom,
  voiceGateAtom,
  voiceInputAtom,
  voiceIsolationAtom,
  voiceIsolationFailedAtom,
  voiceModeAtom,
  voiceOutputAtom,
  voicePttDelayAtom,
  voicePttKeyAtom
} from '@/infra/atoms/voice-atoms';
import { FLOOR_DB } from '@/infra/mic-level';
import { Button } from '@/shared-components/Button';
import { Select } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, CHECKBOX, Info, Status } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const optionsOf = (list: readonly VoiceDevice[]) => [{ value: DEFAULT_DEVICE, label: 'default' }, ...list.map((d) => ({ value: d.id, label: d.label }))];

const shownOf = (id: string, list: readonly VoiceDevice[]) => (list.some((d) => d.id === id) ? id : DEFAULT_DEVICE);

function refusal(err: unknown, what: string): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') return `not allowed: the browser blocked the ${what}`;
  if (name === 'NotFoundError') return `not found: no ${what} is plugged in`;
  return `not available: the ${what} could not be opened`;
}

export function VoiceTab() {
  const devices = useAtomValue(voiceDevicesAtom);
  const input = useAtomValue(voiceInputAtom);
  const output = useAtomValue(voiceOutputAtom);
  const camera = useAtomValue(voiceCameraAtom);
  const [note, setNote] = useState('');
  const [asks, setAsks] = useState(0);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    void refreshVoiceDevices();
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => p.state === 'granted' && setAsks((n) => n || 1))
      .catch(() => undefined);
  }, []);

  const ask = asks || (devices.micNamed ? 1 : 0);

  useEffect(() => {
    if (!ask) return;
    let gone = false;
    let got = false;
    holdVoiceMic().then(
      () => {
        if (gone) return releaseVoiceMic();
        got = true;
        setNote('');
        setHeld(true);
        void refreshVoiceDevices();
      },
      (err: unknown) => !gone && setNote(refusal(err, 'mic'))
    );
    return () => {
      gone = true;
      if (got) releaseVoiceMic();
      setHeld(false);
    };
  }, [ask]);

  function allow() {
    setNote('');
    setAsks((n) => n + 1);
  }

  return (
    <div className="divide-y divide-primaryStroke">
      <div className="grid grid-cols-1 divide-y divide-primaryStroke py-4 first:pt-0 last:pb-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="min-w-0 pb-4 sm:pb-0 sm:pr-4">
          <Block title="input" tip="the mic a voice call talks with">
            <div className="flex flex-col gap-3">
              {!devices.micNamed && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Button id="voice-allow-mic" size="sm" variant="outline" onClick={allow}>
                    allow mic
                  </Button>
                  <span className="text-sm text-textTertiary">the browser names the devices once the mic is allowed</span>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span aria-hidden className="text-sm font-semibold text-textSecondary">
                  microphone
                </span>
                <Select
                  id="voice-input"
                  label="microphone"
                  value={shownOf(input, devices.inputs)}
                  options={optionsOf(devices.inputs)}
                  onChange={setVoiceInput}
                  className="w-full min-w-0"
                />
              </div>
              {held && <InputMeter />}
              <Status id="voice-input-note" text={note} quiet />
            </div>
          </Block>
        </div>

        <div className="min-w-0 pt-4 sm:pl-4 sm:pt-0">
          <Block title="output" tip="the speakers a voice call plays through">
            <div className="flex flex-col gap-1">
              <span aria-hidden className="text-sm font-semibold text-textSecondary">
                speakers
              </span>
              <div className="flex items-center gap-2">
                <Tooltip content={SINK_SUPPORTED ? null : 'not supported in this browser'}>
                  <Select
                    id="voice-output"
                    label="speakers"
                    value={SINK_SUPPORTED ? shownOf(output, devices.outputs) : DEFAULT_DEVICE}
                    options={optionsOf(SINK_SUPPORTED ? devices.outputs : [])}
                    onChange={setVoiceOutput}
                    disabled={!SINK_SUPPORTED}
                    className="min-w-0 flex-1"
                  />
                </Tooltip>
                <Button id="voice-test-output" size="sm" onClick={() => void playTestTone().catch(() => undefined)}>
                  test
                </Button>
              </div>
            </div>
          </Block>
        </div>
      </div>

      <InputProcessing />
      <InputMode />

      <Block title="video" tip="the camera a voice call shows when you turn it on">
        <CameraPreview deviceId={camera}>
          <Select
            id="voice-camera"
            label="camera"
            value={shownOf(camera, devices.cameras)}
            options={optionsOf(devices.cameras)}
            onChange={setVoiceCamera}
            className="w-full min-w-0"
          />
        </CameraPreview>
      </Block>
    </div>
  );
}

function InputMeter() {
  const mode = useAtomValue(voiceModeAtom);
  const gateDb = useAtomValue(voiceGateAtom);
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const gate = mode === 'activity' && gateDb > FLOOR_DB ? gateFraction(gateDb) : 0;

  useEffect(() => {
    let frame = 0;
    let shownPct = -1;
    let shownOpen: boolean | null = null;
    const paint = (now: number) => {
      const level = readVoiceMicLevel(now);
      if (fill.current) fill.current.style.transform = `scaleX(${level})`;
      const pct = Math.round(level * 100);
      if (pct !== shownPct) {
        shownPct = pct;
        root.current?.setAttribute('aria-valuenow', String(pct));
      }
      const open = level >= gate;
      if (open !== shownOpen) {
        shownOpen = open;
        fill.current?.toggleAttribute('data-open', open && gate > 0);
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [gate]);

  return (
    <div
      ref={root}
      id="voice-input-level"
      role="meter"
      aria-label="mic level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="relative h-2 w-full overflow-hidden rounded-control border border-primaryStroke bg-background"
    >
      <div ref={fill} className="h-full w-full origin-left scale-x-0 bg-primaryBlue data-[open]:bg-increase" />
      {gate > 0 && <div id="voice-input-gate" aria-hidden className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-textPrimary" style={{ left: `${gate * 100}%` }} />}
    </div>
  );
}

function Toggle({ id, label, tip, checked, onChange }: { id: string; label: string; tip: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2 text-sm font-semibold text-textPrimary">
        <label htmlFor={id}>{label}</label>
        <Info tip={tip} />
      </span>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={CHECKBOX} />
    </div>
  );
}

function InputProcessing() {
  const isolation = useAtomValue(voiceIsolationAtom);
  const failed = useAtomValue(voiceIsolationFailedAtom);
  const echo = useAtomValue(voiceEchoCancellationAtom);
  const autoGain = useAtomValue(voiceAutoGainAtom);
  return (
    <Block id="voice-processing" title="input processing">
      <div className="flex flex-col">
        <Toggle
          id="voice-isolation"
          label="voice isolation"
          tip="strong noise removal (rnnoise): keyboards, fans, the street. your voice only. the browser's own noise suppression is off while it is on"
          checked={isolation}
          onChange={setVoiceIsolation}
        />
        {isolation && failed && (
          <Status id="voice-isolation-note" text="voice isolation could not start in this browser: the browser's noise suppression is used" quiet />
        )}
        <Toggle
          id="voice-echo"
          label="echo cancellation"
          tip="takes out what your speakers play, so the others do not hear themselves"
          checked={echo}
          onChange={setVoiceEchoCancellation}
        />
        <Toggle
          id="voice-auto-gain"
          label="auto gain"
          tip="evens out your volume: louder when you are quiet or far from the mic"
          checked={autoGain}
          onChange={setVoiceAutoGain}
        />
      </div>
    </Block>
  );
}

const MODES: { mode: VoiceMode; label: string }[] = [
  { mode: 'activity', label: 'voice activity' },
  { mode: 'ptt', label: 'push to talk' }
];

function InputMode() {
  const mode = useAtomValue(voiceModeAtom);
  const gateDb = useAtomValue(voiceGateAtom);
  const key = useAtomValue(voicePttKeyAtom);
  const delay = useAtomValue(voicePttDelayAtom);
  return (
    <Block id="voice-mode" title="input mode">
      <div className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="input mode" className="flex flex-wrap gap-2">
          {MODES.map((m) => (
            <Button
              key={m.mode}
              id={`voice-mode-${m.mode}`}
              size="sm"
              role="radio"
              aria-checked={mode === m.mode}
              onClick={() => setVoiceMode(m.mode)}
              className={cn(mode === m.mode && 'border-primaryBlue text-primaryBlue')}
            >
              {m.label}
            </Button>
          ))}
        </div>
        {mode === 'activity' ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="voice-gate" className="text-sm font-semibold text-textSecondary">
                input sensitivity
              </label>
              <span id="voice-gate-value" className="text-sm tabular-nums text-textTertiary">
                {gateDb <= FLOOR_DB ? 'always on' : `${gateDb} dB`}
              </span>
            </div>
            <input
              id="voice-gate"
              type="range"
              min={FLOOR_DB}
              max={0}
              step={1}
              value={gateDb}
              aria-describedby="voice-gate-hint"
              onChange={(e) => setVoiceGate(e.target.valueAsNumber)}
              className="range-box w-full"
              style={{ '--pct': `${((gateDb - FLOOR_DB) / (0 - FLOOR_DB)) * 100}%` } as CSSProperties}
            />
            <p id="voice-gate-hint" className="text-sm text-textTertiary">
              the mic opens when you are louder than the mark on the meter. all the way left: always open
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
              <span className="text-sm font-semibold text-textSecondary">key</span>
              <KeyRecorder code={key} onPick={setVoicePttKey} />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="voice-ptt-delay" className="text-sm font-semibold text-textSecondary">
                  release delay
                </label>
                <span id="voice-ptt-delay-value" className="text-sm tabular-nums text-textTertiary">
                  {delay} ms
                </span>
              </div>
              <input
                id="voice-ptt-delay"
                type="range"
                min={0}
                max={PTT_DELAY_MAX}
                step={50}
                value={delay}
                onChange={(e) => setVoicePttDelay(e.target.valueAsNumber)}
                className="range-box w-full"
                style={{ '--pct': `${(delay / PTT_DELAY_MAX) * 100}%` } as CSSProperties}
              />
            </div>
            <p id="voice-ptt-note" className="text-sm text-textTertiary">
              works only while this tab has the focus: the browser hears no key pressed in another window. typing in a box never talks
            </p>
          </div>
        )}
      </div>
    </Block>
  );
}

function KeyRecorder({ code, onPick }: { code: string; onPick: (code: string) => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === 'Escape' || !e.code) return setListening(false);
      onPick(e.code);
      setListening(false);
    };
    const stop = () => setListening(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', stop);
    };
  }, [listening, onPick]);

  return (
    <Button
      id="voice-ptt-key"
      size="sm"
      aria-label={listening ? 'press a key, esc to cancel' : `push to talk key: ${keyName(code)}, change`}
      aria-pressed={listening}
      onClick={() => setListening((on) => !on)}
      onBlur={() => setListening(false)}
      className={cn('min-w-24 justify-center font-mono text-base', listening && 'border-primaryBlue font-sans text-sm text-primaryBlue')}
    >
      {listening ? 'press a key' : keyName(code)}
    </Button>
  );
}

function CameraPreview({ deviceId, children }: { deviceId: string; children: ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let gone = false;
    openVoiceCamera(deviceId).then(
      (s) => {
        if (gone) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        if (video.current) video.current.srcObject = s;
        void refreshVoiceDevices();
      },
      (err: unknown) => {
        if (gone) return;
        setNote(refusal(err, 'camera'));
        setOn(false);
      }
    );
    return () => {
      gone = true;
      for (const t of stream?.getTracks() ?? []) t.stop();
      if (video.current) video.current.srcObject = null;
    };
  }, [on, deviceId]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="relative aspect-video w-full max-w-xs shrink-0 overflow-hidden rounded-card border border-primaryStroke bg-background sm:w-64 sm:max-w-none">
        {on ? (
          <video
            ref={video}
            id="voice-camera-video"
            autoPlay
            muted
            playsInline
            aria-label="camera preview"
            className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-textTertiary">
            <RiCameraOffLine aria-hidden size={28} />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span aria-hidden className="text-sm font-semibold text-textSecondary">
            camera
          </span>
          {children}
        </div>
        {on ? (
          <Button id="voice-camera-stop" size="sm" onClick={() => setOn(false)} className="self-start">
            stop preview
          </Button>
        ) : (
          <Button
            id="voice-camera-preview"
            size="sm"
            onClick={() => {
              setNote('');
              setOn(true);
            }}
            className="self-start"
          >
            preview
          </Button>
        )}
        <Status id="voice-camera-note" text={note} quiet />
        <p className="text-sm text-textTertiary">for video calls, coming later</p>
      </div>
    </div>
  );
}
