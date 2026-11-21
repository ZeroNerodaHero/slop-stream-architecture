import { RiCameraOffLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { type MicLevel, openMicLevel } from '@/infra/mic-level';
import {
  allowMic,
  DEFAULT_DEVICE,
  openVoiceCamera,
  openVoiceMic,
  playTestTone,
  refreshVoiceDevices,
  setVoiceCamera,
  setVoiceInput,
  setVoiceOutput,
  SINK_SUPPORTED,
  type VoiceDevice,
  voiceCameraAtom,
  voiceDevicesAtom,
  voiceInputAtom,
  voiceOutputAtom
} from '@/infra/atoms/voice-atoms';
import { Button } from '@/shared-components/Button';
import { Select } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { Block, Status } from '@/shared-components/user-modal/parts';

/** A picker's options: the default first, then the devices by name. */
const optionsOf = (list: readonly VoiceDevice[]) => [{ value: DEFAULT_DEVICE, label: 'default' }, ...list.map((d) => ({ value: d.id, label: d.label }))];

/** A pick's value as the picker shows it: one of its options, else the default. */
const shownOf = (id: string, list: readonly VoiceDevice[]) => (list.some((d) => d.id === id) ? id : DEFAULT_DEVICE);

/** The words for a getUserMedia that failed. */
function refusal(err: unknown, what: string): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError') return `not allowed: the browser blocked the ${what}`;
  if (name === 'NotFoundError') return `not found: no ${what} is plugged in`;
  return `not available: the ${what} could not be opened`;
}

/**
 * The devices a call uses: the mic it talks with, the speakers it plays through, and a camera
 * kept for video in voice, which is not here yet. Picking applies at once, to a call that is on
 * too, and keeps in this browser (voice-atoms.ts). The mic's level shows live while the tab is
 * open, and the mic is put down when it shuts.
 */
export function VoiceTab() {
  const devices = useAtomValue(voiceDevicesAtom);
  const input = useAtomValue(voiceInputAtom);
  const output = useAtomValue(voiceOutputAtom);
  const camera = useAtomValue(voiceCameraAtom);
  const [note, setNote] = useState('');

  // the lists as they are, and once the mic was allowed on an earlier visit, its names too (safari forgets them per page)
  useEffect(() => {
    void refreshVoiceDevices();
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => (p.state === 'granted' ? allowMic() : undefined))
      .catch(() => undefined);
  }, []);

  async function allow() {
    setNote('');
    try {
      await allowMic();
    } catch (err) {
      setNote(refusal(err, 'mic'));
    }
  }

  return (
    <div className="divide-y divide-primaryStroke">
      {/* input and output side by side from sm up, a rule between; stacked on a phone */}
      <div className="grid grid-cols-1 divide-y divide-primaryStroke py-4 first:pt-0 last:pb-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="min-w-0 pb-4 sm:pb-0 sm:pr-4">
          <Block title="input" tip="the mic a voice call talks with">
            <div className="flex flex-col gap-3">
              {!devices.micNamed && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Button id="voice-allow-mic" size="sm" variant="outline" onClick={() => void allow()}>
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
              {devices.micNamed && <InputMeter deviceId={input} onError={setNote} />}
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

      <Block title="video">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-textTertiary">for video calls, coming later</p>
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
        </div>
      </Block>
    </div>
  );
}

/**
 * How loud the picked mic is, live: a bar that rises with every word and falls more slowly
 * (mic-level.ts). Its own stream of the mic, put down on unmount or a new pick. Painted from a
 * frame loop, never through react.
 */
function InputMeter({ deviceId, onError }: { deviceId: string; onError: (text: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let reader: MicLevel | null = null;
    let frame = 0;
    let gone = false;
    let shownPct = -1;
    const paint = (now: number) => {
      const level = reader?.read(now) ?? 0;
      if (fill.current) fill.current.style.width = `${level * 100}%`;
      const pct = Math.round(level * 100);
      if (pct !== shownPct) {
        shownPct = pct;
        root.current?.setAttribute('aria-valuenow', String(pct));
      }
      frame = requestAnimationFrame(paint);
    };
    openVoiceMic(deviceId).then(
      (s) => {
        if (gone) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        const [track] = s.getAudioTracks();
        reader = track ? openMicLevel(track) : null;
        onError('');
        frame = requestAnimationFrame(paint);
      },
      (err: unknown) => !gone && onError(refusal(err, 'mic'))
    );
    return () => {
      gone = true;
      if (frame) cancelAnimationFrame(frame);
      reader?.close();
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [deviceId, onError]);

  return (
    <div
      ref={root}
      id="voice-input-level"
      role="meter"
      aria-label="mic level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="h-2 w-full border border-primaryStroke bg-background"
    >
      <div ref={fill} className="h-full w-0 bg-primaryBlue" />
    </div>
  );
}

/**
 * The picked camera's picture, on a click: a camera's light coming on is the user's to ask for.
 * The box keeps its size off and on; the picker (children) sits under it. Off when the tab shuts.
 */
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
        // the camera is allowed now, so the browser names them
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
    <div className="flex flex-col gap-3">
      <div className="relative aspect-video w-full overflow-hidden border border-primaryStroke bg-background">
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
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-textTertiary">
            <RiCameraOffLine aria-hidden size={28} />
            <Button
              id="voice-camera-preview"
              size="sm"
              onClick={() => {
                setNote('');
                setOn(true);
              }}
            >
              preview
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span aria-hidden className="text-sm font-semibold text-textSecondary">
            camera
          </span>
          {children}
        </div>
        {on && (
          <Button id="voice-camera-stop" size="sm" onClick={() => setOn(false)}>
            stop preview
          </Button>
        )}
      </div>
      <Status id="voice-camera-note" text={note} quiet />
    </div>
  );
}
