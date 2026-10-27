import { RiVolumeMuteLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';

import {
  livePanelsAtom,
  MASTER,
  masterRowAtom,
  mixClipping,
  mixerOpenAtom,
  mixerRunningAtom,
  type MixRow,
  mixRowsAtom,
  readMixLevel,
  resumeMixer,
  setLivePanel,
  setMixLevel,
  setMixMuted
} from '@/infra/atoms/publish-atoms';
import { Button } from '@/shared-components/Button';
import { Collapsible, ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The fader's place as decibels, for the tooltip: the gain is the cube of the slider (mixer.ts), so 0.5 is -18 dB. */
function decibels(level: number): string {
  if (level <= 0) return 'silent';
  const db = 60 * Math.log10(level);
  return db > -0.05 ? '0 dB' : `${db.toFixed(0)} dB`;
}

/**
 * A row's bar: a thin track the green fill grows along, painted from a frame loop (mic-level.ts
 * reads, this paints) and never through react; `aria-valuenow` moves only when the rounded
 * percent does. The master's also lights the clip mark while the mix is too hot.
 */
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

function Row({ row, master = false }: { row: MixRow; master?: boolean }) {
  return (
    <li id={`mix-${row.id}`} className={cn('grid grid-cols-[minmax(0,1fr)_auto_6rem] items-center gap-3 px-3 py-2', master && 'border-t-2 border-primaryStroke')}>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className={cn('truncate text-sm leading-none', master ? 'text-textPrimary' : 'text-textSecondary')}>{row.label}</span>
        <Meter id={row.id} clip={master} />
      </span>
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
      <input
        id={`gain-${row.id}`}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={row.level}
        aria-label={`${row.label} level`}
        title={decibels(row.level)}
        onChange={(e) => setMixLevel(row.id, e.target.valueAsNumber)}
        className="h-1 w-full accent-primaryBlue"
      />
    </li>
  );
}

/**
 * The sound, under the preview while the stream is up (docs/audio.md): a row for the mic (and
 * for any sound added later), each with its bar, its mute and its fader, and under them
 * `everyone hears`, the mix that leaves, with the same. The faders are what the watchers get;
 * nothing here plays on this machine.
 */
export function Mixer() {
  const rows = useAtomValue(mixRowsAtom);
  const master = useAtomValue(masterRowAtom);
  const open = useAtomValue(livePanelsAtom).sound;
  const mixerOpen = useAtomValue(mixerOpenAtom);
  const running = useAtomValue(mixerRunningAtom);
  return (
    <Collapsible id="mixer" title="sound" open={open} onToggle={() => setLivePanel('sound', !open)} className="mt-3">
      {!mixerOpen ? (
        <p className="px-3 py-3 text-sm text-textTertiary">this browser has no web audio: the mic goes out as it is</p>
      ) : (
        <>
          {!running && (
            <div className="flex items-center gap-3 border-b border-primaryStroke px-3 py-2 text-sm text-decrease">
              the browser paused the sound: the stream is silent
              <Button id="mixer-resume" flat variant="primary" className="px-3 py-1.5 text-sm" onClick={() => void resumeMixer()}>
                sound on
              </Button>
            </div>
          )}
          <ul className="m-0 list-none divide-y divide-primaryStroke p-0">
            {rows.length === 0 && <li className="px-3 py-2 text-sm text-textTertiary">no mic: the stream is silent</li>}
            {rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
            <Row row={{ ...master, id: MASTER }} master />
          </ul>
        </>
      )}
    </Collapsible>
  );
}
