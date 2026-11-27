import { RiAddLine, RiArrowUpLine, RiDeleteBinLine, RiErrorWarningFill, RiImageLine, RiLoader4Line, RiMicLine, RiRefreshLine, RiStopFill } from '@remixicon/react';
import { type ReactNode } from 'react';

import type { PendingVoice } from '@/infra/chat-attach';
import { clockOf, MAX_AUDIO_MS } from '@/infra/chat-audio';
import { Button } from '@/shared-components/Button';
import { AUDIO_BUTTON, AudioPlayer, StripFill } from '@/shared-components/ChatAudioPlayer';
import { MenuButton } from '@/shared-components/MenuButton';
import { Tooltip } from '@/shared-components/Tooltip';
import { LIVE_BARS, type RecordedClip, type VoiceRecorder } from '@/shared-components/useVoiceRecorder';
import { cn } from '@/utils/cn';

export function AttachMenu({ id, className, iconSize = 20, onImage, onVoice }: { id: string; className: string; iconSize?: number; onImage: () => void; onVoice: () => void }) {
  return (
    <MenuButton
      id={id}
      menuId={`${id}-menu`}
      label="attach"
      className={className}
      boxed
      hideOnPress
      items={[
        { key: 'image', id: `${id}-image`, label: 'image', icon: <RiImageLine aria-hidden size={16} />, onPick: onImage },
        { key: 'voice', id: `${id}-voice`, label: 'voice message', icon: <RiMicLine aria-hidden size={16} />, onPick: onVoice }
      ]}
    >
      <RiAddLine size={iconSize} aria-hidden />
    </MenuButton>
  );
}

function IconAction({ label, onClick, danger, className, children }: { label: string; onClick: () => void; danger?: boolean; className?: string; children: ReactNode }) {
  return (
    <Tooltip content={label} hideOnPress>
      <button type="button" aria-label={label} onClick={onClick} className={cn(AUDIO_BUTTON, danger && 'text-decrease hover:border-decrease', className)}>
        {children}
      </button>
    </Tooltip>
  );
}

function LiveBars({ levels }: { levels: readonly number[] }) {
  const empty = Math.max(0, LIVE_BARS - levels.length);
  return (
    <span aria-hidden className="relative flex h-[18px] min-w-0 flex-1 items-center justify-between gap-px overflow-hidden">
      {Array.from({ length: LIVE_BARS }, (_, i) => {
        const v = i < empty ? undefined : levels[i - empty];
        return (
          <span
            key={i}
            className={cn('block w-0.5 shrink-0', v === undefined ? 'bg-secondaryStroke' : 'bg-textPrimary')}
            style={{ height: v === undefined ? 3 : Math.round(3 + Math.min(1, Math.max(0, v)) * 15) }}
          />
        );
      })}
    </span>
  );
}

export function VoiceBar({
  recorder,
  idPrefix,
  sendClassName,
  onSend
}: {
  recorder: VoiceRecorder;
  idPrefix: string;
  sendClassName: string;
  onSend: (clip: RecordedClip) => void;
}) {
  const { phase, elapsedMs, clip } = recorder;
  if (phase === 'idle') return null;
  const live = phase === 'recording';
  return (
    <div id={`${idPrefix}-voice`} data-phase={phase} className="flex min-w-0 flex-1 items-center gap-2">
      <IconAction label={phase === 'stopped' ? 'discard' : 'cancel'} danger onClick={phase === 'stopped' ? recorder.discard : recorder.cancel}>
        <RiDeleteBinLine aria-hidden size={16} />
      </IconAction>
      {phase === 'asking' && <span className="min-w-0 flex-1 truncate text-sm text-textSecondary">allow the microphone</span>}
      {live && (
        <span className="relative flex h-7 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-card border border-primaryStroke bg-backgroundSecondary pl-2 pr-2 text-xs max-md:h-11">
          <StripFill part={elapsedMs / MAX_AUDIO_MS} tone="red" />
          <span aria-hidden className="relative h-2 w-2 shrink-0 rounded-avatar bg-decrease motion-safe:animate-pulse" />
          <span className="relative shrink-0 tabular-nums" role="timer" aria-live="off">
            <span className="sr-only">recording </span>
            <span id={`${idPrefix}-voice-clock`} className="text-textPrimary">
              {clockOf(elapsedMs)}
            </span>
            <span className="text-textTertiary"> / {clockOf(MAX_AUDIO_MS)}</span>
          </span>
          <LiveBars levels={recorder.levels} />
        </span>
      )}
      {phase === 'stopped' && clip && <AudioPlayer src={clip.url} durationMs={clip.durationMs} peaks={clip.peaks} label="recording" size="bar" className="mt-0 min-w-0 flex-1" />}
      {live && (
        <IconAction label="stop" onClick={recorder.stop} className="border-decrease text-decrease hover:border-decrease">
          <RiStopFill aria-hidden size={16} />
        </IconAction>
      )}
      <Tooltip content="send" hideOnPress>
        <Button
          id={`${idPrefix}-voice-send`}
          variant="primary"
          aria-label="send voice message"
          disabled={phase === 'asking'}
          className={sendClassName}
          onClick={() => {
            if (phase === 'recording') recorder.stopThen(onSend);
            else if (clip) {
              onSend(clip);
              recorder.discard();
            }
          }}
        >
          <RiArrowUpLine aria-hidden size={18} />
        </Button>
      </Tooltip>
    </div>
  );
}

export function PendingVoiceChip({ voice, sending, idPrefix, onRemove, onRetry }: { voice: PendingVoice; sending: boolean; idPrefix: string; onRemove: () => void; onRetry: () => void }) {
  const failed = voice.status === 'error';
  const uploading = voice.status === 'uploading';
  const busy = !failed && (uploading || sending);
  const percent = Math.round(voice.progress * 100);
  return (
    <span
      id={`${idPrefix}-voice-preview`}
      data-status={voice.status}
      data-audio={voice.audio?.id}
      className={cn('relative flex min-h-9 items-center gap-2 rounded-control border bg-backgroundSecondary pl-2 pr-1 text-sm', failed ? 'border-decrease' : 'border-primaryStroke')}
    >
      {busy ? (
        <RiLoader4Line aria-hidden size={16} className="shrink-0 text-textSecondary motion-safe:animate-spin" />
      ) : failed ? (
        <RiErrorWarningFill aria-hidden size={16} className="shrink-0 text-decrease" />
      ) : (
        <RiMicLine aria-hidden size={16} className="shrink-0 text-textSecondary" />
      )}
      <span className="tabular-nums text-textPrimary">voice message · {clockOf(voice.durationMs)}</span>
      {busy && <span className="sr-only">uploading</span>}
      {failed && (
        <span role="alert" className="max-w-48 truncate text-xs text-decrease">
          {voice.error ?? 'that voice message did not go up'}
        </span>
      )}
      {failed && (
        <IconAction label="retry" onClick={onRetry}>
          <RiRefreshLine aria-hidden size={14} />
        </IconAction>
      )}
      <IconAction label="remove voice message" onClick={onRemove}>
        <RiDeleteBinLine aria-hidden size={14} />
      </IconAction>
      {uploading && (
        <span
          id={`${idPrefix}-voice-progress`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="voice message sent"
          className="absolute inset-x-0 bottom-0 h-0.5"
        >
          <span className="absolute inset-y-0 left-0 bg-primaryBlue transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}
