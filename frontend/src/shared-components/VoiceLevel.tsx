import { RiVolumeMuteLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { roomAtom } from '@/infra/atoms/room-atoms';
import { HEARD_MAX, heardLevelOf, setHeardLevel, voiceCallAtom, voiceHeardAtom } from '@/infra/atoms/voice-atoms';
import { Button } from '@/shared-components/Button';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export function useHeardUid(name: string): string | null {
  const room = useAtomValue(roomAtom);
  const call = useAtomValue(voiceCallAtom);
  const me = useAtomValue(meAtom);
  if (!room || call.phase === 'idle' || call.server !== room.name || !me || name === me) return null;
  return room.voice?.[call.channel]?.find((p) => p.name === name)?.uid ?? null;
}

export function useHeardLevel(uid: string) {
  return heardLevelOf(useAtomValue(voiceHeardAtom), uid);
}

export function HeardMutedMark({ uid }: { uid: string }) {
  if (!useHeardLevel(uid).muted) return null;
  return (
    <Tooltip content="muted for you">
      <span role="img" aria-label="muted for you" data-heard-muted className="flex shrink-0 pr-0.5 text-textTertiary">
        <RiVolumeMuteLine aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}

export function VoiceLevel({ id, name, uid, pin, className }: { id: string; name: string; uid: string; pin?: (on: boolean) => void; className?: string }) {
  const { volume, muted } = useHeardLevel(uid);
  const grab = () => {
    if (!pin) return;
    pin(true);
    const up = () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      pin(false);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  };
  return (
    <section id={id} aria-label={`voice: ${name}`} data-heard-muted={muted || undefined} className={cn('flex flex-col gap-2 border-t border-primaryStroke pt-2.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-textTertiary">voice</h4>
        <Button
          id={`${id}-mute`}
          size="sm"
          aria-pressed={muted}
          onClick={() => setHeardLevel(uid, { muted: !muted })}
          className={cn('flex items-center gap-1.5 px-2 py-1 text-xs', muted && 'border-primaryBlue text-primaryBlue')}
        >
          {muted ? <RiVolumeMuteLine aria-hidden size={14} /> : <RiVolumeUpLine aria-hidden size={14} />}
          mute for me
        </Button>
      </div>
      <div className="flex items-center gap-2.5">
        <label htmlFor={`${id}-volume`} className="shrink-0 text-xs text-textSecondary">
          volume
        </label>
        <input
          id={`${id}-volume`}
          type="range"
          min={0}
          max={HEARD_MAX}
          step={5}
          value={volume}
          aria-valuetext={`${volume}%`}
          onPointerDown={grab}
          onChange={(e) => setHeardLevel(uid, { volume: e.target.valueAsNumber })}
          className="h-1 min-w-0 flex-1 accent-primaryBlue max-md:h-11"
        />
        <output htmlFor={`${id}-volume`} className="w-10 shrink-0 text-right text-xs tabular-nums text-textPrimary">
          {volume}%
        </output>
      </div>
    </section>
  );
}
