import { RiLinkM, RiMicLine, RiMicOffLine, RiPlayFill, RiStopFill } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import {
  cameraAtom,
  canShareScreenAtom,
  canStartAtom,
  copyWatchUrl,
  goLive,
  isPublishingAtom,
  liveViewersAtom,
  mixRowsAtom,
  publishMessageAtom,
  publishToneAtom,
  screenShareSupported,
  setMixMuted,
  shareScreen,
  stopLive,
  streamNameAtom,
  watchUrlAtom
} from '@/infra/atoms/publish-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import { isValidName } from '@/infra/names';
import { SCREEN_SLOTS } from '@/infra/relay';
import { Button } from '@/shared-components/Button';
import { ExternalLink } from '@/shared-components/ExternalLink';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { ViewerCount } from '@/shared-components/ViewerCount';
import { cn } from '@/utils/cn';

export function StartStop({ className = 'flex flex-col gap-2 p-2', prefix = '' }: { className?: string; prefix?: string }) {
  const idOf = (base: string) => (prefix ? `${prefix}-${base}` : base);
  const publishing = useAtomValue(isPublishingAtom);
  const canStart = useAtomValue(canStartAtom);
  const canShare = useAtomValue(canShareScreenAtom);
  const named = isValidName(useAtomValue(streamNameAtom));
  return (
    <div className={className}>
      {publishing ? (
        <Button id={idOf('stop')} variant="danger" className="w-full gap-2" onClick={() => stopLive()}>
          <RiStopFill aria-hidden size={16} />
          stop
        </Button>
      ) : (
        <Button id={idOf('start')} variant="primary" className="w-full gap-2" disabled={!canStart} onClick={() => void goLive()}>
          <RiPlayFill aria-hidden size={16} />
          start
        </Button>
      )}
      {!publishing && !named && (
        <Button id={idOf('pick-name')} size="sm" onClick={() => openUserModal('profile')}>
          pick a name first
        </Button>
      )}
      {publishing && screenShareSupported && (
        <Tooltip content={canShare ? null : `${SCREEN_SLOTS} screens at most`}>
          <Button id={idOf('share-screen')} size="sm" disabled={!canShare} onClick={() => void shareScreen()}>
            share screen
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

function LiveStatus({ prefix }: { prefix: string }) {
  const message = useAtomValue(publishMessageAtom);
  const tone = useAtomValue(publishToneAtom);
  const viewers = useAtomValue(liveViewersAtom);
  return (
    <p
      id={message ? (prefix ? `${prefix}-status` : 'status') : undefined}
      aria-live="polite"
      className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-xs', tone === 'live' ? 'text-increase' : tone === 'bad' ? 'text-decrease' : 'text-textSecondary')}
    >
      <span aria-hidden className={cn('block h-1.5 w-1.5 shrink-0 rounded-avatar', tone === 'live' ? 'bg-increase' : tone === 'bad' ? 'bg-decrease' : 'bg-textTertiary')} />
      <span className="min-w-0 truncate">
        {message || 'getting ready'}
        {tone === 'live' && viewers !== null && (
          <span className="text-textSecondary">
            {' · '}
            <ViewerCount id="viewers" count={viewers} />
          </span>
        )}
      </span>
    </p>
  );
}

function MicMute() {
  const camera = useAtomValue(cameraAtom);
  const rows = useAtomValue(mixRowsAtom);
  const track = camera?.getAudioTracks()[0];
  const row = rows.find((r) => r.id === 'mic');
  const muted = row?.muted ?? false;
  const label = track ? track.label || 'default mic' : 'no mic';
  if (!row)
    return (
      <Tooltip content={track ? `mic: ${label}` : 'no mic'}>
        <span id="live-mic-line" role="img" aria-label={track ? `mic: ${label}` : 'no mic'} className="flex h-7 w-7 shrink-0 items-center justify-center text-textTertiary">
          {track ? <RiMicLine aria-hidden size={16} /> : <RiMicOffLine aria-hidden size={16} />}
        </span>
      </Tooltip>
    );
  return (
    <Tooltip content={muted ? 'muted. click to unmute' : `mic: ${label}. click to mute`}>
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
  );
}

function CopyLink({ id = 'copy' }: { id?: string }) {
  const watchUrl = useAtomValue(watchUrlAtom);
  const publishing = useAtomValue(isPublishingAtom);
  const words = watchUrl ? 'copy watch link' : publishing ? 'the watch link is on its way' : 'the watch link is here once you are live';
  return (
    <Tooltip content={words}>
      <button id={id} type="button" aria-label="copy watch link" disabled={!watchUrl} onClick={copyWatchUrl} className={cn(FOLD_BUTTON, 'disabled:opacity-40')}>
        <RiLinkM aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

function RoundStart() {
  const publishing = useAtomValue(isPublishingAtom);
  const canStart = useAtomValue(canStartAtom);
  const round =
    'flex h-8 w-8 items-center justify-center rounded-control border transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primaryBlue disabled:opacity-40';
  return publishing ? (
    <Tooltip content="stop">
      <button id="stop" type="button" aria-label="stop" onClick={() => stopLive()} className={cn(round, 'border-decrease bg-decrease text-white hover:opacity-90')}>
        <RiStopFill aria-hidden size={16} />
      </button>
    </Tooltip>
  ) : (
    <Tooltip content={canStart ? 'start' : 'start: not ready yet'}>
      <button
        id="start"
        type="button"
        aria-label="start"
        disabled={!canStart}
        onClick={() => void goLive()}
        className={cn(round, 'border-primaryBlue bg-primaryBlue text-background hover:bg-primaryBlueHover')}
      >
        <RiPlayFill aria-hidden size={16} />
      </button>
    </Tooltip>
  );
}

export function StudioModule({ strip = false, prefix = '' }: { strip?: boolean; prefix?: string }) {
  const watchUrl = useAtomValue(watchUrlAtom);
  if (strip)
    return (
      <div id="live-controls" className="flex flex-col items-center gap-1.5 border-b border-primaryStroke pb-2">
        <RoundStart />
        <CopyLink />
        <MicMute />
      </div>
    );
  return (
    <section id={prefix ? `${prefix}-controls` : 'live-controls'} aria-label="studio" className="flex flex-col gap-2 border-b border-primaryStroke px-3 pb-3 pt-1">
      <StartStop prefix={prefix} className="flex flex-col gap-1.5 [&>button:first-child]:h-10 [&>button:first-child]:rounded-control [&>button:first-child]:py-0" />
      <div className="flex min-w-0 items-center gap-1.5">
        <LiveStatus prefix={prefix} />
        <MicMute />
        <CopyLink id={prefix ? `${prefix}-copy` : 'copy'} />
      </div>
      {watchUrl && (
        <p id={prefix ? undefined : 'link'} className="truncate text-xs">
          <ExternalLink id={prefix ? undefined : 'watchurl'} href={watchUrl}>
            {watchUrl}
          </ExternalLink>
        </p>
      )}
    </section>
  );
}
