import { RiCloseLine, RiFilter3Line, RiMicLine, RiVoiceprintLine, RiVolumeMuteLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef } from 'react';

import {
  addDesktopAudio,
  DESKTOP_AUDIO,
  desktopAudioBusyAtom,
  desktopAudioStatusAtom,
  hasMicAtom,
  isPublishingAtom,
  MASTER,
  masterRowAtom,
  mixClipping,
  mixerOpenAtom,
  mixerRunningAtom,
  type MixRow,
  micDeviceAtom,
  micDevicesAtom,
  micProcessingAtom,
  mixRowsAtom,
  nativeMicOnAtom,
  readMixLevel,
  refreshMicDevices,
  removeDesktopAudio,
  resumeMixer,
  setMicDevice,
  setMicProcessing,
  setMixLevel,
  setMixMuted
} from '@/infra/atoms/publish-atoms';
import type { Place } from '@/infra/live-dock';
import { inTauri } from '@/infra/update-check';
import { Button } from '@/shared-components/Button';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { DevicePick } from '@/shared-components/live/DevicePick';
import { DockPanel } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { HERE } from '@/infra/here';

const DESKTOP = inTauri();

function decibels(level: number): string {
  if (level <= 0) return 'silent';
  const db = 60 * Math.log10(level);
  return db > -0.05 ? '0 dB' : `${db.toFixed(0)} dB`;
}

function Meter({ id, clip }: { id: string; clip?: boolean }) {
  const root = useRef<HTMLSpanElement | null>(null);
  const fill = useRef<HTMLSpanElement | null>(null);
  const light = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView ?? window;
    let frame = 0;
    let shown = -1;
    const paint = (now: number) => {
      const level = readMixLevel(id, now);
      if (fill.current) fill.current.style.width = `${Math.round(level * 1000) / 10}%`;
      const pct = Math.round(level * 100);
      if (pct !== shown) {
        shown = pct;
        el.setAttribute('aria-valuenow', String(pct));
      }
      if (clip && light.current) light.current.dataset.clipping = mixClipping(now) ? 'true' : 'false';
      frame = win.requestAnimationFrame(paint);
    };
    frame = win.requestAnimationFrame(paint);
    return () => win.cancelAnimationFrame(frame);
  }, [id, clip]);
  return (
    <span className="flex items-center gap-1.5">
      <span
        ref={root}
        id={`level-${id}`}
        role="meter"
        aria-label={`${id} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
        className="block h-1 w-full min-w-16 flex-1 bg-backgroundTertiary"
      >
        <span ref={fill} className="block h-full w-0 bg-increase" />
      </span>
      {clip && (
        <Tooltip content="too loud: it clips, and the limiter is holding it down">
          <span ref={light} id="clip" data-clipping="false" aria-hidden className="block h-2 w-2 bg-backgroundTertiary data-[clipping=true]:bg-decrease" />
        </Tooltip>
      )}
    </span>
  );
}

function Row({ row, master = false, extra }: { row: MixRow; master?: boolean; extra?: ReactNode }) {
  const mute = (
    <Tooltip content={row.muted ? 'muted. click to unmute' : 'mute'}>
      <button
        id={`mute-${row.id}`}
        type="button"
        aria-pressed={row.muted}
        aria-label={row.muted ? `unmute ${row.label}` : `mute ${row.label}`}
        onClick={() => setMixMuted(row.id, !row.muted)}
        className={cn(ICON_BUTTON, row.muted && 'border-decrease text-decrease hover:border-decrease hover:text-decrease')}
      >
        {row.muted ? <RiVolumeMuteLine aria-hidden size={16} /> : <RiVolumeUpLine aria-hidden size={16} />}
      </button>
    </Tooltip>
  );
  return (
    <li id={`mix-${row.id}`} className={cn('grid grid-cols-[minmax(0,1fr)_auto_6rem] items-center gap-3 px-3 py-2', master && 'border-t-2 border-primaryStroke')}>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className={cn('truncate text-sm leading-none', master ? 'text-textPrimary' : 'text-textSecondary')}>{row.label}</span>
        <Meter id={row.id} clip={master} />
      </span>
      {extra ? (
        <span className="flex items-center gap-1">
          {extra}
          {mute}
        </span>
      ) : (
        mute
      )}
      <Tooltip content={decibels(row.level)}>
        <input
          id={`gain-${row.id}`}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={row.level}
          aria-label={`${row.label} level`}
          onChange={(e) => setMixLevel(row.id, e.target.valueAsNumber)}
          className="h-1 w-full accent-primaryBlue"
        />
      </Tooltip>
    </li>
  );
}

function MicTools() {
  const native = useAtomValue(nativeMicOnAtom);
  const { suppress, gate } = useAtomValue(micProcessingAtom);
  if (!native) return null;
  return (
    <>
      <Tooltip content={suppress ? 'noise suppression on' : 'noise suppression off'}>
        <button
          id="mic-suppress"
          type="button"
          aria-pressed={suppress}
          aria-label="noise suppression"
          onClick={() => void setMicProcessing({ suppress: !suppress })}
          className={cn(ICON_BUTTON, suppress && 'border-primaryBlue text-primaryBlue')}
        >
          <RiVoiceprintLine aria-hidden size={16} />
        </button>
      </Tooltip>
      <Tooltip content={gate ? 'noise gate on' : 'noise gate off'}>
        <button
          id="mic-gate"
          type="button"
          aria-pressed={gate}
          aria-label="noise gate"
          onClick={() => void setMicProcessing({ gate: !gate })}
          className={cn(ICON_BUTTON, gate && 'border-primaryBlue text-primaryBlue')}
        >
          <RiFilter3Line aria-hidden size={16} />
        </button>
      </Tooltip>
    </>
  );
}

function DesktopAudioRemove() {
  return (
    <Tooltip content="remove desktop audio">
      <button id="remove-desktop-audio" type="button" aria-label="remove desktop audio" onClick={removeDesktopAudio} className={ICON_BUTTON}>
        <RiCloseLine aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

function DesktopAudioAdd({ shown }: { shown: boolean }) {
  const busy = useAtomValue(desktopAudioBusyAtom);
  const status = useAtomValue(desktopAudioStatusAtom);
  if (shown) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-primaryStroke px-3 py-2">
      <Button id="add-desktop-audio" variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void addDesktopAudio()}>
        add desktop audio
      </Button>
      {status && (
        <p id="desktop-audio-status" className="text-sm text-decrease">
          {status}
        </p>
      )}
    </div>
  );
}

const extraOf = (id: string): ReactNode => (id === 'mic' ? <MicTools /> : id === DESKTOP_AUDIO ? <DesktopAudioRemove /> : undefined);

export function MixerBody() {
  const rows = useAtomValue(mixRowsAtom);
  const master = useAtomValue(masterRowAtom);
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const running = useAtomValue(mixerRunningAtom);
  if (!mixerOpen) return <p className="px-3 py-3 text-sm text-textTertiary">{HERE} has no web audio: the mic goes out as it is</p>;
  return (
    <>
      {!running && (
        <div className="flex flex-wrap items-center gap-3 border-b border-primaryStroke px-3 py-2 text-sm text-decrease">
          the browser paused the sound: the stream is silent
          <Button id="mixer-resume" variant="primary" size="sm" onClick={() => void resumeMixer()}>
            sound on
          </Button>
        </div>
      )}
      <ul className="m-0 list-none divide-y divide-primaryStroke p-0">
        {rows.length === 0 && <li className="px-3 py-2 text-sm text-textTertiary">no mic: the stream is silent</li>}
        {rows.map((row) => (
          <Row key={row.id} row={row} extra={DESKTOP ? extraOf(row.id) : undefined} />
        ))}
        <Row row={{ ...master, id: MASTER }} master />
      </ul>
      {DESKTOP && <DesktopAudioAdd shown={rows.some((r) => r.id === DESKTOP_AUDIO)} />}
    </>
  );
}

const refreshMics = () => void refreshMicDevices();

function MicPick() {
  const hasMic = useAtomValue(hasMicAtom);
  const devices = useAtomValue(micDevicesAtom);
  const current = useAtomValue(micDeviceAtom);
  if (!hasMic) return <p className="px-3 py-2 text-sm text-textTertiary">no mic: the stream is silent</p>;
  return (
    <div className="px-3 py-2">
      <DevicePick
        id="mic-device"
        label="the mic that goes out"
        icon={RiMicLine}
        value={current}
        devices={devices}
        fallback="default mic"
        on={hasMic}
        refresh={refreshMics}
        onPick={(id) => void setMicDevice(id)}
      />
    </div>
  );
}

function SoundBody() {
  const publishing = useAtomValue(isPublishingAtom);
  return (
    <div className="flex flex-col">
      {publishing ? <MixerBody /> : <p className="px-3 pt-2.5 text-sm text-textTertiary">a fader for the mic and the mix is here once you are live.</p>}
      <MicPick />
    </div>
  );
}

export function SoundModule({ place }: { place: Place }) {
  return (
    <DockPanel tab="sound" place={place}>
      <SoundBody />
    </DockPanel>
  );
}
