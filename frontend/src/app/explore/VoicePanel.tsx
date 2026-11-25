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
  RiPictureInPicture2Line,
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
import { useVoiceView } from '@/app/explore/VoiceRoom';
import { canEditChannel, type Channel, type GroupRoom, isVoice, VOICE_CHANNEL_CAP, type VoiceMember } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { presenceOfAtom } from '@/infra/atoms/presence-atoms';
import {
  joinVoice,
  keyName,
  leaveVoice,
  readVoiceMicLevel,
  setVoiceDeaf,
  setVoiceMuted,
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
import { hideVoicePip, pipCallKey, showVoicePip, voicePipHiddenAtom } from '@/infra/atoms/voice-pip-atoms';
import { type VoiceCall, voiceCallAtom } from '@/infra/atoms/voice-state';
import { useIsMobile } from '@/infra/mobile';
import { Face } from '@/shared-components/Face';
import { useCardMod } from '@/shared-components/GroupMod';
import { PersonCard } from '@/shared-components/PersonCard';
import { usePeek } from '@/shared-components/peek';
import { ProfileLink } from '@/shared-components/ProfileLink';
import { Tooltip } from '@/shared-components/Tooltip';
import { HeardMutedMark, useHeardUid, VoiceLevel } from '@/shared-components/VoiceLevel';
import { cn } from '@/utils/cn';

const PENCIL_HIDDEN = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/voice:opacity-100 [@media(hover:none)]:opacity-100';

const BAR_BUTTON =
  'flex h-7 w-7 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center rounded-control border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

const PEEK_MS = 200;

const CALL_BUTTON =
  'flex h-6 w-6 max-md:h-9 max-md:w-9 shrink-0 items-center justify-center rounded-control border border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

export function VoicePanel({
  room,
  flat = false,
  onAdd,
  addFull = false,
  onEdit,
  onOpen,
  className
}: {
  room: GroupRoom;
  flat?: boolean;
  onAdd?: () => void;
  addFull?: boolean;
  onEdit?: (channel: Channel) => void;
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
  const talking = useAtomValue(voicePttHeldAtom) && ptt && !muted && !deaf;
  const channels = (room.channels ?? []).filter(isVoice);
  const here = call.phase !== 'idle' && call.server === room.name;
  const failed = here && call.phase === 'failed';
  const retrying = here && call.phase === 'joining' && call.retry > 0;
  const inCall = here && !failed && !retrying;
  const serverMuted = inCall && !!me && Object.values(room.voice ?? {}).some((people) => people.some((p) => p.name === me && p.muted));
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const micButton = useRef<HTMLButtonElement>(null);
  const metering = inCall && !muted && !deaf && !serverMuted && (!ptt || talking);
  const [closedFail, setClosedFail] = useState<VoiceCall | null>(null);
  const mobile = useIsMobile();
  const middle = useVoiceView(room).view;
  const pipHidden = useAtomValue(voicePipHiddenAtom) === pipCallKey(call);
  const failOpen = failed && closedFail !== call;

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
      className={cn('flex shrink-0 flex-col gap-1 rounded-panel border border-primaryStroke bg-backgroundSecondary text-sm bubble:border-transparent', flat ? 'mx-3 p-4' : 'p-2', className)}
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
          const pending = mine && !!me && (call.phase === 'joining' || failed) && !people.some((p) => p.name === me);
          return (
            <li key={item.name}>
              <div className={cn('group/voice flex items-center rounded-control', mine ? 'bg-primaryStroke/40' : 'hover:bg-primaryStroke/20')}>
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
                {mine && inCall && !mobile && middle !== item.name && (
                  <BarButton id="group-voice-pip" label={pipHidden ? 'show the call window' : 'hide the call window'} pressed={!pipHidden} onClick={pipHidden ? showVoicePip : hideVoicePip}>
                    <RiPictureInPicture2Line aria-hidden size={14} />
                  </BarButton>
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
            <Tooltip content={addFull ? `${VOICE_CHANNEL_CAP} voice channels at most` : null}>
              <button
                id="group-voice-add"
                type="button"
                aria-haspopup={addFull ? undefined : 'dialog'}
                aria-disabled={addFull || undefined}
                onClick={() => {
                  if (!addFull) onAdd();
                }}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-control px-1 py-1 text-left max-md:min-h-11 text-textTertiary',
                  addFull ? 'cursor-not-allowed opacity-50' : 'hover:bg-primaryStroke/20 hover:text-textPrimary'
                )}
              >
                <RiAddLine aria-hidden size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">add voice channel</span>
              </button>
            </Tooltip>
          </li>
        )}
      </ul>
      {failOpen && <VoiceFailDialog error={call.error} onClose={() => setClosedFail(call)} onRetry={() => join(call.channel)} />}
    </section>
  );
}

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
      <span className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-transparent p-px max-md:min-h-11">
        <span className="flex shrink-0 rounded-avatar outline outline-2 outline-offset-1 outline-transparent">
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

function VoicePerson({ person, avatar, talking }: { person: VoiceMember; avatar: number | null; talking: boolean }) {
  const presence = useAtomValue(presenceOfAtom(person.name));
  const peek = usePeek(PEEK_MS);
  const actions = useCardMod(person.name, peek.close);
  const heard = useHeardUid(person.name);
  const column = (el: Element) => el.closest('#group-voice');
  return (
    <li
      data-voice-member={person.name}
      data-speaking={talking || undefined}
      data-muted={person.muted || undefined}
      className="flex text-textSecondary"
      onPointerEnter={(e) => peek.show(e, column(e.currentTarget))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.focus(e, column(e.currentTarget))}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
    >
      <ProfileLink
        person={{ name: person.name, verified: true, avatar }}
        live={presence === 'streaming'}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-transparent p-px outline-none hover:border-primaryStroke hover:text-textPrimary focus-visible:border-primaryBlue max-md:min-h-11"
      >
        <span className={cn('flex shrink-0 rounded-avatar outline outline-2 outline-offset-1', talking ? 'outline-increase' : 'outline-transparent')}>
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
        <HeardMutedMark uid={person.uid} />
      </ProfileLink>
      {peek.at && (
        <PersonCard
          id={`voice-peek-${person.name}`}
          person={{ name: person.name, verified: true, avatar, presence }}
          at={peek.at}
          actions={actions}
          below={heard && <VoiceLevel id={`voice-peek-${person.name}-level`} name={person.name} uid={heard} pin={peek.hold.pin} />}
          hold={peek.hold}
        />
      )}
    </li>
  );
}

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

function signalOf(call: VoiceCall, stats: VoiceStats | null): SignalKind {
  if (call.phase !== 'connected' || !call.linked || !stats) return 'connecting';
  if (stats.dropped) return 'dropped';
  return voiceQuality(stats) ?? 'connecting';
}

function num(n: number | null, unit: string, digits = 0): string {
  return n === null ? '–' : `${n.toFixed(digits)} ${unit}`;
}

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
