import {
  RiCameraLine,
  RiCameraOffLine,
  RiComputerLine,
  RiHeadphoneLine,
  RiLogoutBoxRLine,
  RiMicLine,
  RiMicOffFill,
  RiMicOffLine,
  RiSettings3Line,
  RiVolumeMuteLine,
  RiVolumeUpLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { type GroupRoom, isVoice, type VoiceMember } from '@/infra/api';
import { meAtom, openAuthDialog } from '@/infra/atoms/auth-atoms';
import { presenceOfAtom } from '@/infra/atoms/presence-atoms';
import { openUserModal } from '@/infra/atoms/user-modal-atoms';
import {
  joinVoice,
  leaveVoice,
  setVoiceDeaf,
  setVoiceMuted,
  voiceCallAtom,
  voiceDeafAtom,
  voiceMutedAtom,
  voiceSeatsAtom,
  voiceSpeakingAtom
} from '@/infra/atoms/voice-atoms';
import { SCREEN_SUPPORTED, setVoiceVideo, voiceLocalVideoAtom, voicePicturesAtom, voiceVideoErrorAtom } from '@/infra/atoms/voice-video';
import { useIsMobile } from '@/infra/mobile';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Tooltip } from '@/shared-components/Tooltip';
import { useHeardLevel } from '@/shared-components/VoiceLevel';
import { cn } from '@/utils/cn';

/** A member in voice, with the moderator's mute when the room says it (the group mod tools). */
type Member = VoiceMember & { muted?: boolean };

/**
 * The voice channel on screen in place of the chat, from the page's `?voice=<channel>`: a click
 * on a voice channel puts it there, a click on a text channel (a link without it) takes it off,
 * and the back button does what it should. Null for none, or a name that is no voice channel of
 * the room. `open` puts one there and keeps the page's path.
 */
export function useVoiceView(room: GroupRoom | null | undefined): { view: string | null; open: (channel: string) => void } {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const name = params.get('voice');
  const view = name && (room?.channels ?? []).some((c) => isVoice(c) && c.name === name) ? name : null;
  const open = (channel: string) => navigate({ pathname, search: `?voice=${encodeURIComponent(channel)}` });
  return { view, open };
}

/**
 * A voice channel as a call, where the chat is (ServerRoom). Not in it: a card with the
 * channel, who is in it, and `join voice`. In it (joining or joined): everyone as a tile, their
 * camera or their face, a ring while they talk, their mute and deafen; a screen shared is a tile
 * of its own. A click on a tile puts it big with the rest in a strip under it, a click on it
 * again puts it back. Under them the call's bar: mic, deafen, camera, screen, the voice tab,
 * leave. The call is voice-atoms.ts's and voice-video.ts's; this only draws it.
 */
export function VoiceRoom({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const call = useAtomValue(voiceCallAtom);
  const here = call.phase !== 'idle' && call.server === room.name && call.channel === channel;
  return here ? <Call room={room} channel={channel} className={className} /> : <JoinCard room={room} channel={channel} className={className} />;
}

const FRAME = 'flex flex-col border border-primaryStroke bg-backgroundSecondary max-md:border-0 max-md:bg-background';

function JoinCard({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const me = useAtomValue(meAtom) ?? null;
  const call = useAtomValue(voiceCallAtom);
  const item = room.channels?.find((c) => c.name === channel);
  const people: Member[] = room.voice?.[channel] ?? [];
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const elsewhere = call.phase !== 'idle' && !(call.server === room.name && call.channel === channel);

  const join = () => {
    if (!me) return openAuthDialog('login');
    void joinVoice(room.name, channel, me);
  };

  return (
    <section id="voice-room" aria-label={`voice: ${channel}`} className={cn(FRAME, 'items-center justify-center p-4', className)}>
      <div id="voice-room-card" className="flex w-full max-w-sm flex-col items-center gap-4 border border-primaryStroke bg-background p-6 text-center">
        <span aria-hidden className="flex h-12 w-12 items-center justify-center border border-primaryStroke text-textSecondary">
          <RiVolumeUpLine size={24} />
        </span>
        <div className="flex min-w-0 max-w-full flex-col gap-1">
          <h2 className="truncate text-lg font-semibold text-textPrimary">{channel}</h2>
          {item?.about && <p className="text-sm text-textSecondary">{item.about}</p>}
        </div>
        {people.length > 0 ? (
          <ul id="voice-room-people" aria-label={`in ${channel}`} className="flex max-w-full flex-wrap justify-center gap-3">
            {people.map((p) => (
              <li key={p.uid} className="flex w-14 flex-col items-center gap-1">
                <FaceWithPresence name={p.name} version={avatarOf(p.name)} className="h-10 w-10 text-sm" ring="border-background" />
                <span className="w-full truncate text-xs text-textSecondary">{p.name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-textTertiary">nobody is in here yet.</p>
        )}
        {elsewhere && <p className="text-xs text-textTertiary">you are in {call.server === room.name ? call.channel : 'another server'}: joining moves you here.</p>}
        <Button id="voice-room-join" variant="primary" className="max-md:min-h-11" onClick={join}>
          {me ? 'join voice' : 'log in to join voice'}
        </Button>
        {call.error && call.phase === 'idle' && (
          <p id="voice-room-error" role="status" className="text-xs text-textTertiary">
            {call.error}
          </p>
        )}
      </div>
    </section>
  );
}

function FaceWithPresence({ name, version, className, ring }: { name: string; version: number | null; className?: string; ring: string }) {
  const presence = useAtomValue(presenceOfAtom(name));
  return (
    <span className="relative flex shrink-0">
      <Face name={name} version={version} className={className} />
      <PresenceSquare status={presence} className={ring} />
    </span>
  );
}

/** One tile: a person (their camera or their face) or a screen they share. */
interface TileOf {
  key: string;
  name: string;
  kind: 'person' | 'screen';
  stream: MediaStream | null;
  self: boolean;
  mute: boolean;
  deaf: boolean;
  /** A moderator muted their mic. */
  serverMuted: boolean;
  /** Their user id, for a person tile of somebody else: you may have muted them for yourself (VoiceLevel.tsx). */
  uid?: string;
}

/** Columns for `n` tiles: a phone one or two, a wide screen up to four. */
function columns(n: number): string {
  if (n <= 1) return 'grid-cols-1';
  if (n <= 4) return 'grid-cols-2';
  if (n <= 9) return 'grid-cols-2 md:grid-cols-3';
  return 'grid-cols-2 md:grid-cols-4';
}

function Call({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const me = useAtomValue(meAtom) ?? '';
  const call = useAtomValue(voiceCallAtom);
  const seats = useAtomValue(voiceSeatsAtom);
  const pictures = useAtomValue(voicePicturesAtom);
  const local = useAtomValue(voiceLocalVideoAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const videoError = useAtomValue(voiceVideoErrorAtom);
  const mobile = useIsMobile();
  const [focus, setFocus] = useState<string | null>(null);
  const people: Member[] = room.voice?.[channel] ?? [];
  const serverMuted = (name: string) => people.some((p) => p.name === name && p.muted);
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;

  const tiles: TileOf[] = [
    { key: 'me', name: me, kind: 'person', stream: local.camera, self: true, mute: muted || deaf, deaf, serverMuted: serverMuted(me) },
    ...(local.screen ? [{ key: 'me:screen', name: me, kind: 'screen' as const, stream: local.screen, self: true, mute: false, deaf: false, serverMuted: false }] : [])
  ];
  for (const s of seats.toSorted((a, b) => a.seat - b.seat)) {
    const camera = pictures.find((p) => p.seat === s.seat && p.kind === 'camera');
    const screen = pictures.find((p) => p.seat === s.seat && p.kind === 'screen');
    const mute = !!s.mute || !!s.deaf;
    tiles.push({
      key: `${s.seat}`,
      name: s.user,
      kind: 'person',
      stream: camera?.stream ?? null,
      self: false,
      mute,
      deaf: !!s.deaf,
      serverMuted: serverMuted(s.user),
      uid: people.find((p) => p.name === s.user)?.uid
    });
    if (screen) tiles.push({ key: `${s.seat}:screen`, name: s.user, kind: 'screen', stream: screen.stream, self: false, mute: false, deaf: false, serverMuted: false });
  }
  // a focused tile that went (its screen stopped, its person left) is the grid again
  const focused = tiles.find((t) => t.key === focus) ?? null;

  const tile = (t: TileOf, size: 'grid' | 'big' | 'strip') => (
    <Tile
      key={t.key}
      tile={t}
      size={size}
      version={avatarOf(t.name)}
      talking={t.kind === 'person' && speaking.has(t.name)}
      focused={t.key === focus}
      onClick={() => setFocus(t.key === focus ? null : t.key)}
    />
  );

  return (
    <section id="voice-room" aria-label={`voice: ${channel}`} className={cn(FRAME, 'relative min-h-0', className)}>
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-primaryStroke px-3 max-md:hidden">
        <RiVolumeUpLine aria-hidden size={16} className="shrink-0 text-textTertiary" />
        <h2 className="min-w-0 truncate text-sm font-semibold text-textPrimary">{channel}</h2>
        <span id="voice-room-status" className="text-xs text-textTertiary">
          {call.phase === 'joining' || !call.linked
            ? 'connecting…'
            : tiles.filter((t) => t.kind === 'person').length === 1
              ? 'just you'
              : `${tiles.filter((t) => t.kind === 'person').length} in the call`}
        </span>
      </header>
      <div id="voice-room-tiles" className={cn('min-h-0 flex-1 overflow-y-auto p-3 max-md:p-2 max-md:pb-24', focused && 'flex flex-col gap-2 overflow-hidden')}>
        {focused ? (
          <>
            <div className="relative min-h-0 flex-1">{tile(focused, 'big')}</div>
            {tiles.length > 1 && (
              <div id="voice-room-strip" className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                {tiles.filter((t) => t !== focused).map((t) => tile(t, 'strip'))}
              </div>
            )}
          </>
        ) : (
          <div className={cn('mx-auto grid min-h-full w-full max-w-5xl content-center gap-2', columns(tiles.length))}>{tiles.map((t) => tile(t, 'grid'))}</div>
        )}
      </div>
      {videoError && (
        <p
          id="voice-room-video-error"
          role="status"
          className="shrink-0 px-3 pb-1 text-center text-xs text-textTertiary max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom))]"
        >
          {videoError}
        </p>
      )}
      <ControlBar mobile={mobile} />
    </section>
  );
}

function Tile({
  tile,
  size,
  version,
  talking,
  focused,
  onClick
}: {
  tile: TileOf;
  size: 'grid' | 'big' | 'strip';
  version: number | null;
  talking: boolean;
  focused: boolean;
  onClick: () => void;
}) {
  const what = tile.kind === 'screen' ? `${tile.name}'s screen` : tile.self ? `${tile.name} (you)` : tile.name;
  return (
    <div
      data-tile={tile.key}
      data-kind={tile.kind}
      data-speaking={talking || undefined}
      data-video={tile.stream ? 'on' : undefined}
      className={cn(
        'group/tile relative overflow-hidden border bg-backgroundTertiary',
        size === 'big' ? 'h-full w-full' : 'aspect-video',
        size === 'strip' && 'w-36 shrink-0 max-md:w-28',
        // the ring while they talk: an outline, never a shadow
        talking ? 'border-increase outline outline-2 -outline-offset-2 outline-increase' : 'border-primaryStroke hover:border-secondaryStroke'
      )}
    >
      <button
        type="button"
        aria-label={focused ? `back to everyone` : `focus ${what}`}
        aria-pressed={focused}
        onClick={onClick}
        className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue"
      />
      {tile.stream ? (
        <Picture stream={tile.stream} mirror={tile.self && tile.kind === 'person'} contain={tile.kind === 'screen' || size === 'big'} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <FaceWithPresence
            name={tile.name}
            version={version}
            ring="border-backgroundTertiary"
            className={cn(size === 'strip' ? 'h-9 w-9 text-sm' : size === 'big' ? 'h-24 w-24 text-3xl' : 'h-16 w-16 text-xl max-md:h-12 max-md:w-12 max-md:text-base')}
          />
        </div>
      )}
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-20 flex max-w-[calc(100%-12px)] items-center gap-1 bg-black/70 px-1.5 py-0.5 text-xs text-white">
        {tile.kind === 'screen' && <RiComputerLine aria-hidden size={12} className="shrink-0" />}
        {tile.serverMuted && <Mark label="server muted" className="text-decrease" icon={<RiMicOffFill aria-hidden size={12} />} />}
        {!tile.serverMuted && tile.mute && <Mark label="muted" icon={<RiMicOffLine aria-hidden size={12} />} />}
        {tile.deaf && <Mark label="deafened" icon={<RiVolumeMuteLine aria-hidden size={12} />} />}
        {tile.uid && <HeardMutedOnTile uid={tile.uid} />}
        <span className="min-w-0 truncate">{tile.kind === 'screen' ? `${tile.name}'s screen` : tile.name}</span>
      </span>
    </div>
  );
}

/** A state on a tile's name chip, named on hover. */
function Mark({ label, icon, className }: { label: string; icon: ReactNode; className?: string }) {
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} className={cn('pointer-events-auto flex shrink-0', className)}>
        {icon}
      </span>
    </Tooltip>
  );
}

/** On a tile, someone you muted for yourself: nobody else hears a difference. */
function HeardMutedOnTile({ uid }: { uid: string }) {
  if (!useHeardLevel(uid).muted) return null;
  return <Mark label="muted for you" icon={<RiVolumeMuteLine aria-hidden data-heard-muted size={12} />} />;
}

/** A camera or a screen, playing. No sound: a call's sound is voice-atoms.ts's players. */
function Picture({ stream, mirror, contain }: { stream: MediaStream; mirror: boolean; contain: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={video}
      autoPlay
      muted
      playsInline
      className={cn('absolute inset-0 h-full w-full bg-black', contain ? 'object-contain' : 'object-cover', mirror && '[transform:scaleX(-1)]')}
    />
  );
}

const CONTROL =
  'flex h-10 w-10 shrink-0 items-center justify-center border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue disabled:opacity-50 max-md:h-11 max-md:w-11';

/** The call's bar: mic, deafen, camera, screen (where the browser can), the voice tab, leave. A phone's is pinned to the foot over the safe area. */
function ControlBar({ mobile }: { mobile: boolean }) {
  const call = useAtomValue(voiceCallAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const local = useAtomValue(voiceLocalVideoAtom);
  // a camera or a screen goes on the peer once the call is answered
  const ready = call.phase === 'connected';
  return (
    <div
      id="voice-room-controls"
      role="toolbar"
      aria-label="call"
      className={cn(
        'flex shrink-0 items-center justify-center gap-2 border-t border-primaryStroke bg-backgroundSecondary px-3 py-2',
        mobile && 'fixed inset-x-0 bottom-0 z-30 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
      )}
    >
      <Control id="voice-room-mic" label={muted ? 'unmute' : 'mute'} pressed={muted} onClick={() => setVoiceMuted(!muted)}>
        {muted ? <RiMicOffLine aria-hidden size={18} /> : <RiMicLine aria-hidden size={18} />}
      </Control>
      <Control id="voice-room-deafen" label={deaf ? 'undeafen' : 'deafen'} pressed={deaf} onClick={() => setVoiceDeaf(!deaf)}>
        <RiHeadphoneLine aria-hidden size={18} />
      </Control>
      <Control
        id="voice-room-camera"
        label={local.camera ? 'turn camera off' : 'turn camera on'}
        pressed={!!local.camera}
        disabled={!ready}
        onClick={() => void setVoiceVideo('camera', !local.camera)}
      >
        {local.camera ? <RiCameraLine aria-hidden size={18} /> : <RiCameraOffLine aria-hidden size={18} />}
      </Control>
      {SCREEN_SUPPORTED && (
        <Control
          id="voice-room-screen"
          label={local.screen ? 'stop sharing' : 'share your screen'}
          pressed={!!local.screen}
          disabled={!ready}
          onClick={() => void setVoiceVideo('screen', !local.screen)}
        >
          <RiComputerLine aria-hidden size={18} />
        </Control>
      )}
      <Control id="voice-room-settings" label="voice settings" onClick={() => openUserModal('voice')}>
        <RiSettings3Line aria-hidden size={18} />
      </Control>
      <Control id="voice-room-leave" label="leave voice" danger onClick={leaveVoice}>
        <RiLogoutBoxRLine aria-hidden size={18} />
      </Control>
    </div>
  );
}

function Control({
  id,
  label,
  pressed,
  danger,
  disabled,
  onClick,
  children
}: {
  id: string;
  label: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        id={id}
        type="button"
        aria-label={label}
        aria-pressed={danger ? undefined : !!pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          CONTROL,
          danger
            ? 'border-decrease bg-decrease text-white hover:bg-decrease/85'
            : pressed
              ? 'border-primaryBlue bg-background text-primaryBlue'
              : 'border-primaryStroke bg-background text-textSecondary hover:border-secondaryStroke hover:bg-backgroundTertiary hover:text-textPrimary'
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
