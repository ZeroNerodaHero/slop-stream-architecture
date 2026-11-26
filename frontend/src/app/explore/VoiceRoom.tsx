import {
  RiCameraLine,
  RiCameraOffLine,
  RiComputerLine,
  RiHeadphoneLine,
  RiLogoutBoxRLine,
  RiMicLine,
  RiMicOffFill,
  RiMicOffLine,
  RiPhoneFill,
  RiSettings3Line,
  RiVolumeMuteLine,
  RiVolumeUpLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
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
  voiceDeafAtom,
  voiceMutedAtom,
  voiceSeatsAtom,
  voiceSpeakingAtom
} from '@/infra/atoms/voice-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { SCREEN_SUPPORTED, setVoiceVideo, voiceLocalVideoAtom, voicePicturesAtom, voiceVideoErrorAtom } from '@/infra/atoms/voice-video';
import { useIsMobile } from '@/infra/mobile';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Tooltip } from '@/shared-components/Tooltip';
import { useHeardLevel } from '@/shared-components/VoiceLevel';
import { cn } from '@/utils/cn';

type Member = VoiceMember & { muted?: boolean };

export function useVoiceView(room: GroupRoom | null | undefined): { view: string | null; open: (channel: string) => void } {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const name = params.get('voice');
  const view = name && (room?.channels ?? []).some((c) => isVoice(c) && c.name === name) ? name : null;
  const open = (channel: string) => navigate({ pathname, search: `?voice=${encodeURIComponent(channel)}` });
  return { view, open };
}

export function VoiceRoom({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const call = useAtomValue(voiceCallAtom);
  const here = call.phase !== 'idle' && call.server === room.name && call.channel === channel;
  return here ? <Call room={room} channel={channel} className={className} /> : <JoinCard room={room} channel={channel} className={className} />;
}

const FRAME = 'flex flex-col rounded-panel border border-primaryStroke bg-backgroundSecondary bubble:border-transparent max-md:rounded-none max-md:border-0 max-md:bg-background';

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
      <div id="voice-room-card" className="flex w-full max-w-sm flex-col items-center gap-4 rounded-card border border-primaryStroke bg-background p-6 text-center bubble:border-transparent">
        <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-control border border-primaryStroke text-textSecondary">
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

export interface TileOf {
  key: string;
  name: string;
  kind: 'person' | 'screen';
  stream: MediaStream | null;
  self: boolean;
  mute: boolean;
  deaf: boolean;
  serverMuted: boolean;
  uid?: string;
}

function columns(n: number): string {
  if (n <= 1) return 'grid-cols-1';
  if (n <= 4) return 'grid-cols-2';
  if (n <= 9) return 'grid-cols-2 md:grid-cols-3';
  return 'grid-cols-2 md:grid-cols-4';
}

export function useCallTiles(room: GroupRoom, channel: string): TileOf[] {
  const me = useAtomValue(meAtom) ?? '';
  const seats = useAtomValue(voiceSeatsAtom);
  const pictures = useAtomValue(voicePicturesAtom);
  const local = useAtomValue(voiceLocalVideoAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const people: Member[] = room.voice?.[channel] ?? [];
  const serverMuted = (name: string) => people.some((p) => p.name === name && p.muted);
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
  return tiles;
}

function Call({ room, channel, className }: { room: GroupRoom; channel: string; className?: string }) {
  const call = useAtomValue(voiceCallAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const videoError = useAtomValue(voiceVideoErrorAtom);
  const mobile = useIsMobile();
  const [focus, setFocus] = useState<string | null>(null);
  const tiles = useCallTiles(room, channel);
  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
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
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-primaryStroke px-3 bubble:border-transparent max-md:hidden">
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

export type TileSize = 'grid' | 'big' | 'strip' | 'pip' | 'mini';

export function Tile({
  tile,
  size,
  version,
  talking,
  focused,
  label,
  onClick
}: {
  tile: TileOf;
  size: TileSize;
  version: number | null;
  talking: boolean;
  focused: boolean;
  label?: string;
  onClick: () => void;
}) {
  const what = tile.kind === 'screen' ? `${tile.name}'s screen` : tile.self ? `${tile.name} (you)` : tile.name;
  const thin = size === 'pip' || size === 'mini';
  const mini = size === 'mini';
  const button = (
    <button
      type="button"
      aria-label={mini ? what : (label ?? (focused ? `back to everyone` : `focus ${what}`))}
      aria-pressed={mini ? undefined : focused}
      onClick={onClick}
      className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue"
    />
  );
  return (
    <div
      data-tile={tile.key}
      data-kind={tile.kind}
      data-speaking={talking || undefined}
      data-video={tile.stream ? 'on' : undefined}
      className={cn(
        'group/tile relative overflow-hidden rounded-card border bg-backgroundTertiary',
        size === 'big' ? 'h-full w-full' : 'aspect-video',
        size === 'strip' && 'w-36 shrink-0 max-md:w-28',
        talking ? (thin ? 'border-increase' : 'border-increase outline outline-2 -outline-offset-2 outline-increase') : 'border-primaryStroke hover:border-secondaryStroke bubble:border-transparent bubble:hover:border-secondaryStroke'
      )}
    >
      {mini ? <Tooltip content={what}>{button}</Tooltip> : button}
      {tile.stream ? (
        <Picture stream={tile.stream} mirror={tile.self && tile.kind === 'person'} contain={tile.kind === 'screen' || size === 'big'} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <FaceWithPresence
            name={tile.name}
            version={version}
            ring="border-backgroundTertiary"
            className={cn(
              size === 'strip'
                ? 'h-9 w-9 text-sm'
                : mini
                  ? 'h-7 w-7 text-xs'
                  : size === 'pip'
                    ? 'h-12 w-12 text-lg'
                    : size === 'big'
                      ? 'h-24 w-24 text-3xl'
                      : 'h-16 w-16 text-xl max-md:h-12 max-md:w-12 max-md:text-base'
            )}
          />
        </div>
      )}
      {!mini && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-20 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-control bg-black/70 px-1.5 py-0.5 text-xs text-white">
          {tile.kind === 'screen' && <RiComputerLine aria-hidden size={12} className="shrink-0" />}
          {tile.serverMuted && <Mark label="server muted" className="text-decrease" icon={<RiMicOffFill aria-hidden size={12} />} />}
          {!tile.serverMuted && tile.mute && <Mark label="muted" icon={<RiMicOffLine aria-hidden size={12} />} />}
          {tile.deaf && <Mark label="deafened" icon={<RiVolumeMuteLine aria-hidden size={12} />} />}
          {tile.uid && <HeardMutedOnTile uid={tile.uid} />}
          <span className="min-w-0 truncate">{tile.kind === 'screen' ? `${tile.name}'s screen` : tile.name}</span>
        </span>
      )}
    </div>
  );
}

function Mark({ label, icon, className }: { label: string; icon: ReactNode; className?: string }) {
  return (
    <Tooltip content={label}>
      <span role="img" aria-label={label} className={cn('pointer-events-auto flex shrink-0', className)}>
        {icon}
      </span>
    </Tooltip>
  );
}

function HeardMutedOnTile({ uid }: { uid: string }) {
  if (!useHeardLevel(uid).muted) return null;
  return <Mark label="muted for you" icon={<RiVolumeMuteLine aria-hidden data-heard-muted size={12} />} />;
}

const videos = new Map<MediaStream, HTMLVideoElement>();

function videoOf(stream: MediaStream): HTMLVideoElement {
  const kept = videos.get(stream);
  if (kept) return kept;
  const el = document.createElement('video');
  el.autoplay = true;
  el.muted = true;
  el.playsInline = true;
  el.srcObject = stream;
  videos.set(stream, el);
  return el;
}

function dropIfLoose(stream: MediaStream, el: HTMLVideoElement) {
  window.setTimeout(() => {
    if (el.isConnected || videos.get(stream) !== el) return;
    videos.delete(stream);
    el.srcObject = null;
  }, 0);
}

function Picture({ stream, mirror, contain }: { stream: MediaStream; mirror: boolean; contain: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const look = cn('absolute inset-0 h-full w-full bg-black', contain ? 'object-contain' : 'object-cover', mirror && '[transform:scaleX(-1)]');
  useLayoutEffect(() => {
    const box = host.current;
    if (!box) return;
    const el = videoOf(stream);
    box.appendChild(el);
    if (el.paused) void el.play().catch(() => undefined);
    return () => {
      if (el.parentNode === box) box.removeChild(el);
      dropIfLoose(stream, el);
    };
  }, [stream]);
  useLayoutEffect(() => {
    const el = videos.get(stream);
    if (el && el.parentNode === host.current) el.className = look;
  });
  return <div ref={host} className="absolute inset-0" />;
}

const CONTROL =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-control border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue disabled:opacity-50 max-md:h-11 max-md:w-11';

const PIP_CONTROL = 'h-8 w-8';

export function ControlBar({ mobile, pip = false }: { mobile: boolean; pip?: boolean }) {
  const call = useAtomValue(voiceCallAtom);
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  const local = useAtomValue(voiceLocalVideoAtom);
  const ready = call.phase === 'connected';
  const at = pip ? 'voice-pip' : 'voice-room';
  const size = pip ? PIP_CONTROL : undefined;
  const icon = pip ? 16 : 18;
  return (
    <div
      id={`${at}-controls`}
      role="toolbar"
      aria-label="call"
      className={cn(
        pip
          ? 'flex shrink-0 items-center gap-1.5 px-2 pb-2'
          : 'flex shrink-0 items-center justify-center gap-2 rounded-b-panel border-t border-primaryStroke bg-backgroundSecondary px-3 py-2 bubble:border-transparent',
        mobile && 'fixed inset-x-0 bottom-0 z-30 rounded-none rounded-t-panel pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
      )}
    >
      <Control id={`${at}-mic`} className={size} label={muted ? 'unmute' : 'mute'} pressed={muted} onClick={() => setVoiceMuted(!muted)}>
        {muted ? <RiMicOffLine aria-hidden size={icon} /> : <RiMicLine aria-hidden size={icon} />}
      </Control>
      <Control id={`${at}-deafen`} className={size} label={deaf ? 'undeafen' : 'deafen'} pressed={deaf} onClick={() => setVoiceDeaf(!deaf)}>
        <RiHeadphoneLine aria-hidden size={icon} />
      </Control>
      <Control
        id={`${at}-camera`}
        className={size}
        label={local.camera ? 'turn camera off' : 'turn camera on'}
        pressed={!!local.camera}
        disabled={!ready}
        onClick={() => void setVoiceVideo('camera', !local.camera)}
      >
        {local.camera ? <RiCameraLine aria-hidden size={icon} /> : <RiCameraOffLine aria-hidden size={icon} />}
      </Control>
      {SCREEN_SUPPORTED && (
        <Control
          id={`${at}-screen`}
          className={size}
          label={local.screen ? 'stop sharing' : 'share your screen'}
          pressed={!!local.screen}
          disabled={!ready}
          onClick={() => void setVoiceVideo('screen', !local.screen)}
        >
          <RiComputerLine aria-hidden size={icon} />
        </Control>
      )}
      {pip ? (
        <Tooltip content="leave">
          <Button id="voice-pip-leave" size="sm" variant="outline-danger" aria-label="leave" className="ml-auto h-8 w-8 px-0 py-0" onClick={leaveVoice}>
            <RiPhoneFill aria-hidden size={16} className="rotate-[135deg]" />
          </Button>
        </Tooltip>
      ) : (
        <>
          <Control id="voice-room-settings" label="voice settings" onClick={() => openUserModal('voice')}>
            <RiSettings3Line aria-hidden size={18} />
          </Control>
          <Control id="voice-room-leave" label="leave voice" danger onClick={leaveVoice}>
            <RiLogoutBoxRLine aria-hidden size={18} />
          </Control>
        </>
      )}
    </div>
  );
}

export function CallControls({ at }: { at: string }) {
  const muted = useAtomValue(voiceMutedAtom);
  const deaf = useAtomValue(voiceDeafAtom);
  return (
    <div id={`${at}-controls`} role="toolbar" aria-label="call" className="flex shrink-0 items-center gap-1.5">
      <Control id={`${at}-mic`} label={muted ? 'unmute' : 'mute'} pressed={muted} onClick={() => setVoiceMuted(!muted)}>
        {muted ? <RiMicOffLine aria-hidden size={18} /> : <RiMicLine aria-hidden size={18} />}
      </Control>
      <Control id={`${at}-deafen`} label={deaf ? 'undeafen' : 'deafen'} pressed={deaf} onClick={() => setVoiceDeaf(!deaf)}>
        <RiHeadphoneLine aria-hidden size={18} />
      </Control>
      <Control id={`${at}-leave`} label="leave voice" danger onClick={leaveVoice}>
        <RiPhoneFill aria-hidden size={18} className="rotate-[135deg]" />
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
  className,
  onClick,
  children
}: {
  id: string;
  label: string;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
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
              : 'border-primaryStroke bg-background text-textSecondary hover:border-secondaryStroke hover:bg-backgroundTertiary hover:text-textPrimary',
          className
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}
