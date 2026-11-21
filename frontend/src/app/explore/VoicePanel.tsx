import { RiAddLine, RiHeadphoneLine, RiLogoutBoxRLine, RiMicLine, RiMicOffLine, RiPencilLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode } from 'react';

import { canEditChannel, type Channel, type GroupRoom, isVoice } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { joinVoice, leaveVoice, setVoiceDeaf, setVoiceMuted, voiceCallAtom, voiceDeafAtom, voiceMutedAtom, voiceSpeakingAtom } from '@/infra/atoms/voice-atoms';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The pencil on a voice channel's row: up with the pointer on the row (`group/voice`), the focus on it, or no hover to wait for. */
const PENCIL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/voice:opacity-100 [@media(hover:none)]:opacity-100';

const BAR_BUTTON =
  'flex h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

/**
 * The group's voice channels and who is in each (docs/voice.md), over the roster. A click on a
 * channel joins it; while in one, a bar under the list has mute, deafen and leave. Who is in
 * where is the room's `voice`, kept by the `voice` and `voice_left` facts; a ring on a face is
 * that person speaking, for the channel you are in. Always there: every group has a voice
 * channel (made with it, migration 0005 for the older ones). `onAdd`, given to the channels
 * power under the cap, puts `add voice channel` in the header; ServerRoom has the dialog. With
 * `onEdit`, a channel this login may change (`can_edit`: who made it, or the channels power)
 * has a pencil at the right of its row, up with the pointer on the row, that opens its edit
 * (the name and the line about it; ServerRoom's dialog again). The call is the page's, not this panel's: a phone's drawer shutting keeps it, and leaving the
 * page (ServerRoom's room effect) ends it.
 */
export function VoicePanel({
  room,
  flat = false,
  onAdd,
  onEdit,
  className
}: {
  room: GroupRoom;
  flat?: boolean;
  onAdd?: () => void;
  onEdit?: (channel: Channel) => void;
  className?: string;
}) {
  const me = useAtomValue(meAtom) ?? null;
  const call = useAtomValue(voiceCallAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const channels = (room.channels ?? []).filter(isVoice);
  const here = call.phase !== 'idle' && call.server === room.name;
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;

  const join = (channel: string) => {
    if (!me) return openAuthDialog('login');
    void joinVoice(room.name, channel, me);
  };

  return (
    <section
      id="group-voice"
      aria-label="voice"
      className={cn('flex shrink-0 flex-col gap-1 border border-primaryStroke bg-backgroundSecondary text-sm', flat ? 'mx-3 p-4' : 'p-2', className)}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="pl-0.5 text-xs font-semibold uppercase tracking-wider text-textTertiary">voice</h3>
        {onAdd && (
          <Button id="group-voice-add" size="sm" aria-haspopup="dialog" className="gap-1 px-2 py-0.5 text-xs" onClick={onAdd}>
            <RiAddLine aria-hidden size={14} />
            add voice channel
          </Button>
        )}
      </div>
      {channels.length === 0 && <p className="px-1 text-xs text-textTertiary">no voice channel yet.</p>}
      <ul id="group-voice-channels" className="flex flex-col gap-0.5">
        {channels.map((item) => {
          const people = room.voice?.[item.name] ?? [];
          const mine = here && call.channel === item.name;
          return (
            <li key={item.name}>
              {/* the row is the box: the join fills it and the pencil sits in it at the right, up with the pointer anywhere on the row */}
              <div className={cn('group/voice flex items-center', mine ? 'bg-primaryStroke/40' : 'hover:bg-primaryStroke/20')}>
                <button
                  id={`group-voice-${item.name}`}
                  type="button"
                  aria-current={mine || undefined}
                  onClick={() => join(item.name)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left max-md:min-h-11',
                    mine ? 'font-semibold text-textPrimary' : 'text-textSecondary group-hover/voice:text-textPrimary'
                  )}
                >
                  <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {mine && call.phase === 'joining' && <span className="text-xs font-normal text-textTertiary">joining…</span>}
                </button>
                {onEdit && canEditChannel(item) && (
                  <Tooltip content="edit">
                    <button
                      id={`group-voice-edit-${item.name}`}
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`edit ${item.name}`}
                      onClick={() => onEdit(item)}
                      className={cn(BAR_BUTTON, PENCIL_HIDDEN, 'text-textTertiary hover:text-textPrimary')}
                    >
                      <RiPencilLine aria-hidden size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
              {people.length > 0 && (
                <ul aria-label={`in ${item.name}`} className="flex flex-col gap-0.5 py-0.5 pl-6">
                  {people.map((p) => {
                    const talking = mine && speaking.has(p.name);
                    return (
                      <li key={p.uid} data-speaking={talking || undefined} className="flex items-center gap-2 text-textSecondary">
                        <span className={cn('flex shrink-0 outline outline-2 outline-offset-1', talking ? 'outline-increase' : 'outline-transparent')}>
                          <Face name={p.name} version={avatarOf(p.name)} className="h-5 w-5 text-[10px]" />
                        </span>
                        <span className="min-w-0 truncate">{p.name}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {call.error && !here && (
        <p id="group-voice-error" role="status" className="px-1 text-xs text-textTertiary">
          {call.error}
        </p>
      )}
      {here && call.phase === 'connected' && (
        <div id="group-voice-bar" className="mt-1 flex items-center gap-1 border-t border-primaryStroke pt-2">
          <span className={cn('min-w-0 flex-1 truncate px-1 text-xs', call.linked ? 'text-increase' : 'text-textTertiary')}>
            {call.linked ? `in ${call.channel}` : `connecting to ${call.channel}…`}
          </span>
          <BarButton label={muted ? 'unmute' : 'mute'} pressed={muted} onClick={() => setVoiceMuted(!muted)}>
            {muted ? <RiMicOffLine aria-hidden size={16} /> : <RiMicLine aria-hidden size={16} />}
          </BarButton>
          <BarButton label={deaf ? 'undeafen' : 'deafen'} pressed={deaf} onClick={() => setVoiceDeaf(!deaf)}>
            <RiHeadphoneLine aria-hidden size={16} />
          </BarButton>
          <BarButton label="leave voice" danger onClick={leaveVoice}>
            <RiLogoutBoxRLine aria-hidden size={16} />
          </BarButton>
        </div>
      )}
    </section>
  );
}

function BarButton({ label, pressed, danger, onClick, children }: { label: string; pressed?: boolean; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(BAR_BUTTON, danger ? 'text-decrease' : pressed ? 'border-primaryBlue text-primaryBlue' : 'text-textSecondary hover:text-textPrimary')}
      >
        {children}
      </button>
    </Tooltip>
  );
}
