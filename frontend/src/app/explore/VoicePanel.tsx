import {
  RiAddLine,
  RiCloseLine,
  RiErrorWarningLine,
  RiHeadphoneLine,
  RiLogoutBoxRLine,
  RiMicFill,
  RiMicLine,
  RiMicOffLine,
  RiPencilLine,
  RiSignalWifi1Fill,
  RiSignalWifi2Fill,
  RiSignalWifiErrorLine,
  RiSignalWifiFill,
  RiSignalWifiLine,
  RiVolumeUpLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';

import { VoiceFailDialog, voiceFailWords } from '@/app/explore/VoiceFailDialog';
import { canEditChannel, type Channel, type GroupRoom, isVoice, type VoiceMember } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { presenceOfAtom } from '@/infra/atoms/presence-atoms';
import {
  joinVoice,
  keyName,
  leaveVoice,
  readVoiceMicLevel,
  setVoiceDeaf,
  setVoiceMuted,
  type VoiceCall,
  voiceCallAtom,
  voiceDeafAtom,
  voiceModeAtom,
  voiceMutedAtom,
  voicePttHeldAtom,
  voicePttKeyAtom,
  voiceQuality,
  voiceSpeakingAtom,
  type VoiceStats,
  voiceStatsAtom
} from '@/infra/atoms/voice-atoms';
import { Face } from '@/shared-components/Face';
import { useCardMod } from '@/shared-components/GroupMod';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { ProfileLink } from '@/shared-components/ProfileLink';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The pencil on a voice channel's row: up with the pointer on the row (`group/voice`), the focus on it, or no hover to wait for. */
const PENCIL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/voice:opacity-100 [@media(hover:none)]:opacity-100';

const BAR_BUTTON =
  'flex h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

/** How long the pointer rests on a person before their card shows: the roster's (ServerRoom.tsx `PEEK_MS`). */
const PEEK_MS = 200;

/** Mute, deafen and leave in the header, and the signal on your channel's row: smaller than the pencil, the row's height. */
const CALL_BUTTON =
  'flex h-6 w-6 max-md:h-9 max-md:w-9 shrink-0 items-center justify-center border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

/**
 * The group's voice channels and who is in each (docs/voice.md), over the roster. A click on a
 * channel joins it; while in one, the header has mute, deafen and leave at the right, and its row
 * has the signal (how the call is getting through, the numbers on hover) at the very right. Who is in
 * where is the room's `voice`, kept by the `voice` and `voice_left` facts; a ring on a face is
 * that person speaking, for the channel you are in. Always there: every group has a voice
 * channel (made with it, migration 0005 for the older ones). `onAdd`, given to the channels
 * power under the cap, puts an `add channel` row after the last channel; ServerRoom has the dialog. With
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
  onOpen,
  className
}: {
  room: GroupRoom;
  flat?: boolean;
  onAdd?: () => void;
  onEdit?: (channel: Channel) => void;
  /** A click on a channel shows its call (VoiceRoom.tsx) instead of joining it. */
  onOpen?: (channel: string) => void;
  className?: string;
}) {
  const me = useAtomValue(meAtom) ?? null;
  const call = useAtomValue(voiceCallAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const stats = useAtomValue(voiceStatsAtom);
  const ptt = useAtomValue(voiceModeAtom) === 'ptt';
  const pttKey = keyName(useAtomValue(voicePttKeyAtom));
  // push to talk with the key down and nothing muted: the mic button goes green while it is
  const talking = useAtomValue(voicePttHeldAtom) && ptt && !muted && !deaf;
  const channels = (room.channels ?? []).filter(isVoice);
  const here = call.phase !== 'idle' && call.server === room.name;
  // the last try failed: the greyed seat stays, and only dismiss in the header
  const failed = here && call.phase === 'failed';
  // a try failed and another is on its way: only cancel in the header
  const retrying = here && call.phase === 'joining' && call.retry > 0;
  // mute, deafen and the mic's fill: joining (the first try) or connected
  const inCall = here && !failed && !retrying;
  // a moderator muted my mic here (voice.rs `server_mute`): the voice server carries nothing of it, and only a moderator lifts it
  const serverMuted = inCall && !!me && Object.values(room.voice ?? {}).some((people) => people.some((p) => p.name === me && p.muted));
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const micButton = useRef<HTMLButtonElement>(null);
  // the fill shows while the mic goes out: in push to talk, only with the key down
  const metering = inCall && !muted && !deaf && !serverMuted && (!ptt || talking);
  // the failure whose dialog was closed: a new failure is a new call object, so its dialog opens on its own
  const [closedFail, setClosedFail] = useState<VoiceCall | null>(null);
  const failOpen = failed && closedFail !== call;

  // Your level in the mute button's mic, many times a second while it is open: a frame loop
  // writes `--lvl` on the button by hand, never through react. The call's shared mic's own
  // reader (voice-atoms.ts `readVoiceMicLevel`), so the mic is not opened again and a new
  // device is followed. No web audio: no reader, no fill.
  useEffect(() => {
    const el = micButton.current;
    if (!metering || !el) return;
    let frame = 0;
    const paint = (now: number) => {
      el.style.setProperty('--lvl', readVoiceMicLevel(now).toFixed(3));
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      el.style.setProperty('--lvl', '0');
    };
  }, [metering]);

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
        {(failed || retrying) && (
          <div id="group-voice-controls" className="flex shrink-0 items-center gap-0.5">
            <BarButton id="group-voice-leave" label={failed ? 'dismiss' : 'cancel'} onClick={leaveVoice}>
              <RiCloseLine aria-hidden size={14} />
            </BarButton>
          </div>
        )}
        {inCall && (
          <div id="group-voice-controls" className="flex shrink-0 items-center gap-0.5">
            {serverMuted ? (
              <BarButton id="group-voice-mute" label="server muted" danger disabled>
                <RiMicOffLine aria-hidden size={14} />
              </BarButton>
            ) : (
              <BarButton
                ref={micButton}
                id="group-voice-mute"
                label={muted ? 'unmute' : ptt ? `mute (push to talk: hold ${pttKey})` : 'mute'}
                pressed={muted}
                talking={ptt ? talking : undefined}
                onClick={() => setVoiceMuted(!muted)}
                className="relative"
              >
                {muted ? (
                  <RiMicOffLine aria-hidden size={14} />
                ) : (
                  <>
                    <RiMicLine aria-hidden size={14} />
                    {/* the capsule fills from its foot with your level (--lvl, 0..1): 62% down is the foot, 8% the top */}
                    {metering && (
                      <RiMicFill
                        aria-hidden
                        size={14}
                        className="absolute inset-0 m-auto text-increase"
                        style={{ clipPath: 'inset(calc(62% - var(--lvl,0) * 54%) 0 38% 0)' }}
                      />
                    )}
                  </>
                )}
              </BarButton>
            )}
            <BarButton label={deaf ? 'undeafen' : 'deafen'} pressed={deaf} onClick={() => setVoiceDeaf(!deaf)}>
              <RiHeadphoneLine aria-hidden size={14} />
            </BarButton>
            <BarButton id="group-voice-leave" label="leave voice" danger onClick={leaveVoice}>
              <RiLogoutBoxRLine aria-hidden size={14} />
            </BarButton>
          </div>
        )}
      </div>
      {channels.length === 0 && !onAdd && <p className="px-1 text-xs text-textTertiary">no voice channel yet.</p>}
      <ul id="group-voice-channels" className="flex flex-col gap-0.5">
        {channels.map((item) => {
          const people = room.voice?.[item.name] ?? [];
          const mine = here && call.channel === item.name;
          // your own seat before the server has you in it: greyed while joining, fainter once failed. the roster's entry takes over when it comes
          const pending = mine && !!me && (call.phase === 'joining' || failed) && !people.some((p) => p.name === me);
          return (
            <li key={item.name}>
              {/* the row is the box: the join fills it, then the pencil (up with the pointer anywhere on the row), then the signal on the row you are in */}
              <div className={cn('group/voice flex items-center', mine ? 'bg-primaryStroke/40' : 'hover:bg-primaryStroke/20')}>
                <button
                  id={`group-voice-${item.name}`}
                  type="button"
                  aria-current={mine || undefined}
                  onClick={() => (onOpen ? onOpen(item.name) : join(item.name))}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left max-md:min-h-11',
                    mine ? 'font-semibold text-textPrimary' : 'text-textSecondary group-hover/voice:text-textPrimary'
                  )}
                >
                  <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
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
                {mine && !failed && <Signal call={call} stats={stats} />}
              </div>
              {(people.length > 0 || pending) && (
                <ul aria-label={`in ${item.name}`} className="flex flex-col gap-0.5 py-0.5 pl-6">
                  {pending && me && (
                    <PendingSeat name={me} avatar={avatarOf(me)} failed={failed} retrying={retrying} error={call.error} onWhy={() => setClosedFail(null)} />
                  )}
                  {people.map((p) => (
                    <VoicePerson key={p.uid} person={p} avatar={avatarOf(p.name)} talking={mine && speaking.has(p.name)} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {onAdd && (
          <li>
            <button
              id="group-voice-add"
              type="button"
              aria-haspopup="dialog"
              onClick={onAdd}
              className="flex w-full items-center gap-1.5 px-1 py-1 text-left max-md:min-h-11 text-textTertiary hover:bg-primaryStroke/20 hover:text-textPrimary"
            >
              <RiAddLine aria-hidden size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">add channel</span>
            </button>
          </li>
        )}
      </ul>
      {failOpen && <VoiceFailDialog error={call.error} onClose={() => setClosedFail(call)} onRetry={() => join(call.channel)} />}
    </section>
  );
}

/**
 * Your own seat in the channel you are joining, before the server's roster has you: your face
 * and name greyed, `retrying…` after the name while a retry is on its way. Once the last try
 * failed, fainter, with a warning at the end that says why and opens the dialog again.
 */
function PendingSeat({
  name,
  avatar,
  failed,
  retrying,
  error,
  onWhy
}: {
  name: string;
  avatar: number | null;
  failed: boolean;
  retrying: boolean;
  error: string;
  onWhy: () => void;
}) {
  const words = voiceFailWords(error);
  return (
    <li id="group-voice-pending" data-voice-member={name} data-pending={failed ? 'failed' : 'joining'} className="flex text-textTertiary">
      <span className="flex min-w-0 flex-1 items-center gap-2 border border-transparent p-px max-md:min-h-11">
        <span className="flex shrink-0 outline outline-2 outline-offset-1 outline-transparent">
          <Face name={name} version={avatar} className={cn('h-5 w-5 text-[10px] grayscale', failed ? 'opacity-35' : 'opacity-60')} />
        </span>
        <span className="min-w-0 truncate">{name}</span>
        {retrying && <span className="shrink-0 text-xs">retrying…</span>}
        {failed && (
          <Tooltip content={words}>
            <button
              id="group-voice-why"
              type="button"
              aria-haspopup="dialog"
              aria-label={`failed to join: ${words}`}
              onClick={onWhy}
              className={cn(CALL_BUTTON, 'ml-auto text-decrease')}
            >
              <RiErrorWarningLine aria-hidden size={12} />
            </button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

/**
 * One person in a voice channel: their face (a ring while they speak, for the channel you are in),
 * their name, and a red mic when a moderator muted them. The roster's row's way (ServerRoom.tsx
 * `Member`): one link to them that opens the profile popup, and the pointer resting on it puts
 * their card (PersonCard.tsx) beside the column, a moderator's buttons at its left.
 */
function VoicePerson({ person, avatar, talking }: { person: VoiceMember; avatar: number | null; talking: boolean }) {
  const presence = useAtomValue(presenceOfAtom(person.name));
  const peek = usePeek(PEEK_MS);
  const actions = useCardMod(person.name, peek.close);
  const column = (el: Element) => el.closest('#group-voice');
  return (
    <li
      data-voice-member={person.name}
      data-speaking={talking || undefined}
      data-muted={person.muted || undefined}
      className="flex text-textSecondary"
      onPointerEnter={(e) => peek.show(e, column(e.currentTarget))}
      onPointerLeave={(e) => peek.leave(e.currentTarget, !!actions)}
      onFocus={(e) => peek.focus(e, column(e.currentTarget))}
      onBlur={peek.blur}
    >
      <ProfileLink
        // only a login takes a seat, so the ✓ is theirs
        person={{ name: person.name, verified: true, avatar }}
        live={presence === 'streaming'}
        className="flex min-w-0 flex-1 items-center gap-2 border border-transparent p-px outline-none hover:border-primaryStroke hover:text-textPrimary focus-visible:border-primaryBlue max-md:min-h-11"
      >
        <span className={cn('flex shrink-0 outline outline-2 outline-offset-1', talking ? 'outline-increase' : 'outline-transparent')}>
          <Face name={person.name} version={avatar} className="h-5 w-5 text-[10px]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{person.name}</span>
        {person.muted && (
          <Tooltip content="server muted">
            <span role="img" aria-label="server muted" className="flex shrink-0 pr-0.5 text-decrease">
              <RiMicOffLine aria-hidden size={14} />
            </span>
          </Tooltip>
        )}
      </ProfileLink>
      {peek.at && (
        <PersonCard id={`voice-peek-${person.name}`} person={{ name: person.name, verified: true, avatar, presence }} at={peek.at} actions={actions} hold={peek.hold} />
      )}
    </li>
  );
}

/** `talking`: in push to talk, the key has the mic open (green), or not (undefined outside push to talk). */
function BarButton({
  ref,
  id,
  label,
  pressed,
  danger,
  disabled,
  talking,
  onClick,
  className,
  children
}: {
  ref?: Ref<HTMLButtonElement>;
  id?: string;
  label: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  talking?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={talking ? 'talking' : label}>
      <button
        ref={ref}
        id={id}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        data-talking={talking || undefined}
        onClick={onClick}
        className={cn(
          CALL_BUTTON,
          danger ? 'text-decrease' : pressed ? 'border-primaryBlue text-primaryBlue' : talking ? 'text-increase' : 'text-textSecondary hover:text-textPrimary',
          className
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

type SignalKind = 'connecting' | 'dropped' | 'good' | 'ok' | 'poor';

const SIGNAL: Record<SignalKind, { Icon: typeof RiSignalWifiFill; className: string }> = {
  connecting: { Icon: RiSignalWifiLine, className: 'text-textTertiary animate-[pulse_3s_ease-in-out_infinite] motion-reduce:animate-none' },
  good: { Icon: RiSignalWifiFill, className: 'text-increase' },
  ok: { Icon: RiSignalWifi2Fill, className: 'text-caution' },
  poor: { Icon: RiSignalWifi1Fill, className: 'text-decrease' },
  dropped: { Icon: RiSignalWifiErrorLine, className: 'text-decrease' }
};

/** Where the call is: connecting until the audio is through and the first numbers are in, then how good the path is, or dropped while ice has lost it. */
function signalOf(call: VoiceCall, stats: VoiceStats | null): SignalKind {
  if (call.phase !== 'connected' || !call.linked || !stats) return 'connecting';
  if (stats.dropped) return 'dropped';
  return voiceQuality(stats) ?? 'connecting';
}

/** A number for the stat block, or a dash when the browser did not say. */
function num(n: number | null, unit: string, digits = 0): string {
  return n === null ? '–' : `${n.toFixed(digits)} ${unit}`;
}

/** The call's signal mark: an icon in the quality's colour, and on hover or focus the word and the numbers under it. */
function Signal({ call, stats }: { call: VoiceCall; stats: VoiceStats | null }) {
  const kind = signalOf(call, stats);
  const { Icon, className } = SIGNAL[kind];
  const word = kind === 'connecting' ? 'connecting…' : kind;
  const rows: [string, string][] = stats
    ? [
        ['ping', num(stats.rtt, 'ms')],
        ['jitter', num(stats.jitter, 'ms')],
        ['packet loss', num(stats.loss, '%', 1)],
        ['up', num(stats.up, 'kbps')],
        ['down', num(stats.down, 'kbps')],
        ['codec', stats.codec || '–'],
        ['route', stats.route || '–']
      ]
    : [];
  const tip =
    kind === 'connecting' ? (
      word
    ) : (
      <span id="group-voice-signal-tip" className="flex flex-col gap-1">
        <span>{word}</span>
        <span className="grid grid-cols-[auto_auto] gap-x-4 font-normal tabular-nums">
          {rows.map(([label, value]) => (
            <span key={label} className="contents">
              <span className="text-textTertiary">{label}</span>
              <span className="text-right text-textPrimary">{value}</span>
            </span>
          ))}
        </span>
      </span>
    );
  return (
    <Tooltip content={tip}>
      <span
        id="group-voice-signal"
        role="img"
        tabIndex={0}
        aria-label={kind === 'connecting' ? word : `signal ${word}`}
        data-signal={kind}
        className={cn(CALL_BUTTON, 'pr-0.5 hover:border-transparent', className)}
      >
        <Icon aria-hidden size={14} />
      </span>
    </Tooltip>
  );
}
