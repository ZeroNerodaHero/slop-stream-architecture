import { RiArrowDownSLine, RiArrowUpSLine, RiLinkM, RiMicLine, RiMicOffLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useRef } from 'react';

import { api } from '@/infra/api';
import {
  addStreamThumb,
  cameraAtom,
  copyWatchUrl,
  isPublishingAtom,
  mixRowsAtom,
  modelAtom,
  removeStreamThumb,
  setMixMuted,
  streamNameAtom,
  streamThumbsAtom,
  thumbStatusAtom,
  watchUrlAtom
} from '@/infra/atoms/publish-atoms';
import { DOCK_WORDS, type DockTab } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { ModelControls } from '@/shared-components/live/ModelControls';
import { StartStop } from '@/shared-components/live/Sources';
import { panelClassName } from '@/shared-components/Panel';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { roveTabs } from '@/utils/tabs';

export const DOCK_IDS: Record<DockTab, string> = {
  sources: 'sources-panel',
  face: 'face-panel',
  rig: 'rig',
  thumbnail: 'thumbs-panel',
  sound: 'mixer',
  chat: 'live-chat-panel'
};

export const FOLD = 'grid motion-safe:transition-[grid-template-rows] motion-safe:duration-150 motion-safe:ease-out motion-reduce:transition-none';
export const FOLD_OPEN = 'grid-rows-[1fr]';
export const FOLD_SHUT = 'grid-rows-[0fr]';

export const HEAD = 'flex h-9 shrink-0 items-center gap-2 border-b border-primaryStroke pl-3 pr-1 text-xs font-semibold uppercase tracking-wider text-textSecondary';

export const FOLD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:border-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none';

const BODY_H = 'h-52';

interface FoldButtonProps {
  id: string;
  open: boolean;
  controls: string;
  what: string;
  onToggle: () => void;
}

export function FoldButton({ id, open, controls, what, onToggle }: FoldButtonProps) {
  const words = open ? `fold the ${what}` : `open the ${what}`;
  const Icon = open ? RiArrowDownSLine : RiArrowUpSLine;
  return (
    <Tooltip content={words}>
      <button id={id} type="button" aria-label={words} aria-expanded={open} aria-controls={controls} onClick={onToggle} className={FOLD_BUTTON}>
        <Icon aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

interface DockPanelProps {
  tab: DockTab;
  tabbed: boolean;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function DockPanel({ tab, tabbed, active, open, onToggle, children }: DockPanelProps) {
  const id = DOCK_IDS[tab];
  const shown = tabbed || open;
  return (
    <section
      id={id}
      data-tab={tab}
      data-open={shown}
      role={tabbed ? 'tabpanel' : undefined}
      aria-labelledby={tabbed ? `live-dock-tab-${tab}` : `${id}-title`}
      hidden={tabbed && !active}
      className={cn('min-w-0', !tabbed && panelClassName('flex flex-col self-start overflow-hidden'))}
    >
      {!tabbed && (
        <h2 className={cn(HEAD, !open && 'border-transparent')}>
          <span id={`${id}-title`} className="min-w-0 flex-1 truncate">
            {DOCK_WORDS[tab]}
          </span>
          <FoldButton id={`${id}-toggle`} open={open} controls={`${id}-body`} what={DOCK_WORDS[tab]} onToggle={onToggle} />
        </h2>
      )}
      <div id={`${id}-body`} inert={!shown ? true : undefined} className={cn(FOLD, shown ? FOLD_OPEN : FOLD_SHUT)}>
        <div className="min-h-0 overflow-hidden">
          <div className={cn(BODY_H, 'overflow-y-auto overscroll-contain', tab === 'chat' && 'flex flex-col overflow-hidden')}>{children}</div>
        </div>
      </div>
    </section>
  );
}

interface DockTabsProps {
  tabs: readonly DockTab[];
  tab: DockTab;
  open: boolean;
  unread: ReactNode;
  onTab: (tab: DockTab) => void;
  onToggle: () => void;
}

export function DockTabs({ tabs, tab, open, unread, onTab, onToggle }: DockTabsProps) {
  return (
    <div className={cn('flex h-9 shrink-0 items-stretch gap-1 pr-1', open ? 'border-b border-primaryStroke' : 'border-b border-transparent')}>
      <div role="tablist" aria-label="go live" onKeyDown={roveTabs} className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const on = t === tab;
          return (
            <button
              key={t}
              id={`live-dock-tab-${t}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={DOCK_IDS[t]}
              tabIndex={on ? 0 : -1}
              onClick={() => onTab(t)}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm transition-colors duration-150 focus-visible:text-primaryBlue focus-visible:outline-none',
                on && open ? 'border-primaryBlue font-semibold text-textPrimary' : 'border-transparent text-textTertiary hover:text-textPrimary'
              )}
            >
              {DOCK_WORDS[t]}
              {t === 'chat' && unread}
            </button>
          );
        })}
      </div>
      <span className="flex items-center">
        <FoldButton id="live-dock-toggle" open={open} controls="live-dock-panels" what="dock" onToggle={onToggle} />
      </span>
    </div>
  );
}

export function FaceBody({ onModel }: { onModel: () => void }) {
  const model = useAtomValue(modelAtom);
  if (model) return <ModelControls onChange={onModel} />;
  return (
    <div id="face-none" className="flex flex-col items-start gap-2 px-3 py-2.5 text-sm text-textTertiary">
      <p>no model on: the camera goes out as it is.</p>
      <Button id="face-pick-model" size="sm" variant="outline" onClick={onModel}>
        pick a model
      </Button>
    </div>
  );
}

export function RigNone() {
  return <p className="px-3 py-2.5 text-sm text-textTertiary">the rigging, your face read live, is here once a model is on.</p>;
}

export function SoundNone() {
  return <p className="px-3 py-2.5 text-sm text-textTertiary">the sound, a fader for the mic and for the mix that goes out, is here once you are live.</p>;
}

export function ThumbnailsBody() {
  const name = useAtomValue(streamNameAtom);
  const thumbs = useAtomValue(streamThumbsAtom);
  const thumbStatus = useAtomValue(thumbStatusAtom);
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div id="thumbs" className="flex flex-col gap-2.5 px-3 py-2.5">
      <p className="text-xs text-textSecondary">one picture on your card on home, until that page is refreshed. with none, home shows one frame of the camera.</p>
      {thumbs.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {thumbs.map((id) => (
            <li key={id} className="flex w-28 flex-col items-start gap-1.5">
              <img src={api.streamThumbUrl(name, id)} alt="" draggable={false} className="aspect-video w-full border border-primaryStroke object-cover" />
              <Button id={`thumb-remove-${id}`} size="sm" variant="outline-danger" onClick={() => void removeStreamThumb(id)}>
                remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          id="thumb-file"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void addStreamThumb(file);
          }}
        />
        <Button id="thumb-add" size="sm" variant="outline" disabled={thumbs.length >= 6 || thumbStatus === 'saving'} onClick={() => fileRef.current?.click()}>
          add a thumbnail
        </Button>
        <span id="thumbstatus" className="text-sm text-textSecondary" aria-live="polite">
          {thumbStatus}
        </span>
      </div>
    </div>
  );
}

function MicLine({ compact = false }: { compact?: boolean }) {
  const camera = useAtomValue(cameraAtom);
  const rows = useAtomValue(mixRowsAtom);
  const track = camera?.getAudioTracks()[0];
  const row = rows.find((r) => r.id === 'mic');
  const muted = row?.muted ?? false;
  const label = track ? track.label || 'default' : 'no mic';
  return (
    <div id="live-mic-line" className={cn('flex min-w-0 items-center gap-2 text-sm text-textSecondary', compact && 'shrink-0')}>
      {row ? (
        <Tooltip content={muted ? 'muted. click to unmute' : 'mute the mic'}>
          <button
            id="live-mic-mute"
            type="button"
            aria-label={muted ? 'unmute the mic' : 'mute the mic'}
            aria-pressed={muted}
            onClick={() => setMixMuted('mic', !muted)}
            className={cn(FOLD_BUTTON, muted && 'border-decrease text-decrease hover:border-decrease hover:text-decrease')}
          >
            {muted ? <RiMicOffLine aria-hidden size={16} /> : <RiMicLine aria-hidden size={16} />}
          </button>
        </Tooltip>
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-textTertiary">
          {track ? <RiMicLine aria-hidden size={16} /> : <RiMicOffLine aria-hidden size={16} />}
        </span>
      )}
      <span className={compact ? 'sr-only' : 'min-w-0 truncate'}>
        <span className="sr-only">mic: </span>
        {label}
      </span>
    </div>
  );
}

export function LiveControls({ compact = false }: { compact?: boolean }) {
  const watchUrl = useAtomValue(watchUrlAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const linkWords = publishing ? 'the watch link is on its way' : 'the watch link is here once you are live';
  if (compact)
    return (
      <section id="live-controls" aria-label="controls" className={panelClassName('flex h-9 min-w-0 items-center gap-1.5 self-start box-content py-px pl-3 pr-1')}>
        <StartStop
          status
          className="flex min-w-0 flex-row-reverse items-center gap-3 [&>#pick-name]:hidden [&>#share-screen]:hidden [&>#status]:max-w-48 [&>#status]:truncate [&>#status]:pt-0 [&>button:first-child]:h-8 [&>button:first-child]:w-auto [&>button:first-child]:px-8 [&>button:first-child]:py-0 [&>button:first-child]:text-base"
        />
        <MicLine compact />
        <Tooltip content={watchUrl ? 'copy watch link' : linkWords}>
          <button id="copy" type="button" aria-label="copy watch link" disabled={!watchUrl} onClick={copyWatchUrl} className={cn(FOLD_BUTTON, 'disabled:opacity-40')}>
            <RiLinkM aria-hidden size={16} />
          </button>
        </Tooltip>
      </section>
    );
  return (
    <section id="live-controls" aria-labelledby="live-controls-title" className={panelClassName('flex min-w-0 flex-col overflow-hidden')}>
      <h2 className={HEAD}>
        <span id="live-controls-title" className="min-w-0 flex-1 truncate">
          controls
        </span>
      </h2>
      <div className="flex flex-col gap-2.5 p-3">
        <StartStop status className="flex flex-col gap-2 [&>#status]:pt-0 [&>#status]:text-left [&>button:first-child]:h-11 [&>button:first-child]:py-0" />
        <MicLine />
        <Tooltip content={watchUrl ? null : linkWords}>
          <Button id="copy" size="sm" className="w-full gap-1.5" disabled={!watchUrl} onClick={copyWatchUrl}>
            <RiLinkM aria-hidden size={16} />
            copy watch link
          </Button>
        </Tooltip>
        {watchUrl && (
          <p id="link" className="truncate text-xs">
            <ExternalLink id="watchurl" href={watchUrl}>
              {watchUrl}
            </ExternalLink>
          </p>
        )}
      </div>
    </section>
  );
}
