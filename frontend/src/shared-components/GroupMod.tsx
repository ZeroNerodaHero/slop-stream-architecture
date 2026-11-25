import { RiForbidLine, RiInformationLine, RiMicLine, RiMicOffLine, RiLogoutBoxRLine, RiTimerLine, RiUserUnfollowLine } from '@remixicon/react';
import { atom, useAtomValue } from 'jotai';
import { type MouseEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, type GroupMember, type GroupRoom, type MemberLine, messageOf, type RolePerms } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, serverChat } from '@/infra/atoms/chat-atoms';
import { roomAtom } from '@/infra/atoms/room-atoms';
import { plainEmotes } from '@/infra/emotes';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { type LineMenuItem, quoteWords, when } from '@/shared-components/ChatLine';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Face } from '@/shared-components/Face';
import { INPUT } from '@/shared-components/input';
import { SHEET_CLOSE, SHEET_DIALOG, SheetGrab, useSheetBack } from '@/shared-components/MobileSheet';
import type { CardAction } from '@/shared-components/peek';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export type ModKind = 'delete' | 'kick' | 'timeout' | 'ban' | 'mute' | 'disconnect';

export interface ModAsk {
  kind: ModKind;
  name: string;
  line?: { id: string; channel: string };
}

export const modAskAtom = atom<ModAsk | null>(null);
export const memberInfoAtom = atom<string | null>(null);

export function askMod(ask: ModAsk): void {
  store.set(modAskAtom, ask);
}

export function openMemberInfo(name: string): void {
  store.set(memberInfoAtom, name);
}

export const TIMEOUT_PICKS: { seconds: number; label: string }[] = [
  { seconds: 60, label: '1m' },
  { seconds: 300, label: '5m' },
  { seconds: 600, label: '10m' },
  { seconds: 3600, label: '1h' },
  { seconds: 86400, label: '1d' },
  { seconds: 604800, label: '1w' }
];

export interface ModPowers {
  kick: boolean;
  ban: boolean;
  voice: boolean;
  any: boolean;
}

const NONE: ModPowers = { kick: false, ban: false, voice: false, any: false };

export function modPowers(room: GroupRoom | null, me: string | null | undefined, name: string): ModPowers {
  if (!room || !me || name === me) return NONE;
  if (room.roster?.some((m) => m.name === name && m.owner)) return NONE;
  const kick = room.perms.kick;
  const ban = room.perms.ban;
  const voice = kick || (room.perms as RolePerms & { voice?: boolean }).voice === true;
  return { kick, ban, voice, any: kick || ban || voice };
}

export function voiceSeatOf(room: GroupRoom | null, name: string): { channel: string; muted: boolean } | null {
  for (const [channel, people] of Object.entries(room?.voice ?? {})) {
    const p = people.find((person) => person.name === name);
    if (p) return { channel, muted: p.muted === true };
  }
  return null;
}

function reaches(room: GroupRoom, perms: RolePerms): boolean {
  if (room.owner || room.admin === true) return true;
  return (Object.keys(perms) as (keyof RolePerms)[]).every((key) => !perms[key] || room.perms[key] === true);
}

export function useCardMod(name: string, close: () => void): CardAction[] | null {
  const room = useAtomValue(roomAtom);
  const me = useAtomValue(meAtom);
  const can = modPowers(room, me, name);
  if (!can.any) return null;
  const seat = voiceSeatOf(room, name);
  const pick = (kind: ModKind) => () => {
    close();
    askMod({ kind, name });
  };
  const actions: CardAction[] = [];
  if (seat && can.voice) {
    actions.push(
      seat.muted
        ? {
            key: 'unmute',
            label: 'unmute',
            icon: <RiMicLine aria-hidden size={14} />,
            onPick: () => {
              close();
              void setVoiceMute(name, false);
            }
          }
        : { key: 'mute', label: 'mute', icon: <RiMicOffLine aria-hidden size={14} />, onPick: pick('mute') },
      { key: 'disconnect', label: 'disconnect', icon: <RiLogoutBoxRLine aria-hidden size={14} />, onPick: pick('disconnect') }
    );
  }
  if (can.kick) {
    actions.push({ key: 'kick', label: 'kick', icon: <RiUserUnfollowLine aria-hidden size={14} />, danger: true, onPick: pick('kick') });
    actions.push({ key: 'timeout', label: 'timeout', icon: <RiTimerLine aria-hidden size={14} />, danger: true, onPick: pick('timeout') });
  }
  if (can.ban) actions.push({ key: 'ban', label: 'ban', icon: <RiForbidLine aria-hidden size={14} />, danger: true, onPick: pick('ban') });
  actions.push({
    key: 'info',
    label: 'info',
    icon: <RiInformationLine aria-hidden size={14} />,
    onPick: () => {
      close();
      openMemberInfo(name);
    }
  });
  return actions;
}

export function lineModItems(room: GroupRoom | null, me: string | null | undefined, channel: string, line: ChatLine): LineMenuItem[] {
  if (!room || !me) return [];
  const mine = line.verified && line.from === me;
  const can = line.verified ? modPowers(room, me, line.from) : { ...NONE, kick: room.perms.kick };
  const items: LineMenuItem[] = [];
  if (mine || can.kick) {
    items.push({ key: 'delete', label: 'delete message', danger: true, onPick: () => askMod({ kind: 'delete', name: line.from, line: { id: line.id, channel } }) });
  }
  if (!mine && line.verified) {
    const first = items.length;
    if (can.kick) {
      items.push({ key: 'kick', label: 'kick', danger: true, onPick: () => askMod({ kind: 'kick', name: line.from }) });
      items.push({ key: 'timeout', label: 'timeout', danger: true, onPick: () => askMod({ kind: 'timeout', name: line.from }) });
    }
    if (can.ban) items.push({ key: 'ban', label: 'ban', danger: true, onPick: () => askMod({ kind: 'ban', name: line.from }) });
    const head = items[first];
    if (head) items[first] = { ...head, divider: true };
  }
  return items;
}

function said(server: string, err: unknown): void {
  serverChat(server).showNotice(messageOf(err), 5000);
}

async function setVoiceMute(name: string, muted: boolean): Promise<void> {
  const server = store.get(roomAtom)?.name;
  if (!server) return;
  try {
    await api.voiceMute(server, name, muted);
  } catch (err) {
    said(server, err);
  }
}

export function GroupModHost({ server }: { server: string }) {
  const ask = useAtomValue(modAskAtom);
  const info = useAtomValue(memberInfoAtom);
  useEffect(
    () => () => {
      store.set(modAskAtom, null);
      store.set(memberInfoAtom, null);
    },
    [server]
  );
  return (
    <>
      {info && <MemberInfo key={info} server={server} name={info} onClose={() => store.set(memberInfoAtom, null)} />}
      {ask && <ModConfirm key={`${ask.kind}-${ask.name}-${ask.line?.id ?? ''}`} server={server} ask={ask} onDone={() => store.set(modAskAtom, null)} />}
    </>
  );
}

const TITLES: Record<ModKind, (name: string) => { title: string; yes: string }> = {
  delete: () => ({ title: 'delete message?', yes: 'delete' }),
  kick: (name) => ({ title: `kick ${name}?`, yes: 'kick' }),
  timeout: (name) => ({ title: `timeout ${name}?`, yes: 'timeout' }),
  ban: (name) => ({ title: `ban ${name}?`, yes: 'ban' }),
  mute: (name) => ({ title: `mute ${name}?`, yes: 'mute' }),
  disconnect: (name) => ({ title: `disconnect ${name}?`, yes: 'disconnect' })
};

function ModConfirm({ server, ask, onDone }: { server: string; ask: ModAsk; onDone: () => void }) {
  const [seconds, setSeconds] = useState(600);
  const [reason, setReason] = useState('');
  const words = TITLES[ask.kind](ask.name);
  const run = async () => {
    const { kind, name, line } = ask;
    try {
      if (kind === 'delete' && line) {
        await api.deleteGroupMessage(server, line.channel, line.id);
        serverChat(server).removeLine(line.id, line.channel);
      } else if (kind === 'kick') await api.kickMember(server, name);
      else if (kind === 'timeout') await api.timeoutMember(server, name, seconds, reason.trim());
      else if (kind === 'ban') await api.banMember(server, name, reason.trim());
      else if (kind === 'mute') await api.voiceMute(server, name, true);
      else if (kind === 'disconnect') await api.voiceDisconnect(server, name);
      if ((kind === 'kick' || kind === 'ban') && store.get(memberInfoAtom) === name) store.set(memberInfoAtom, null);
    } catch (err) {
      said(server, err);
    }
  };
  return (
    <ConfirmDialog
      id={`mod-${ask.kind}`}
      title={words.title}
      yes={words.yes}
      onYes={() => {
        onDone();
        void run();
      }}
      onNo={onDone}
    >
      {ask.kind === 'timeout' && (
        <div className="flex flex-col gap-1">
          <span id="mod-timeout-for" className="text-xs font-semibold text-textSecondary">
            for
          </span>
          <div
            role="group"
            aria-labelledby="mod-timeout-for"
            className="grid divide-x divide-primaryStroke overflow-hidden rounded-control border border-primaryStroke"
            style={{ gridTemplateColumns: `repeat(${TIMEOUT_PICKS.length}, minmax(0, 1fr))` }}
          >
            {TIMEOUT_PICKS.map((pick) => (
              <button
                key={pick.seconds}
                id={`mod-timeout-${pick.label}`}
                type="button"
                aria-pressed={seconds === pick.seconds}
                onClick={() => setSeconds(pick.seconds)}
                className={cn(
                  'py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue max-md:min-h-11',
                  seconds === pick.seconds ? 'bg-primaryBlue/10 text-primaryBlue' : 'text-textTertiary hover:text-textPrimary'
                )}
              >
                {pick.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {(ask.kind === 'timeout' || ask.kind === 'ban') && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-textSecondary">reason</span>
          <input id={`mod-${ask.kind}-reason`} className={INPUT} placeholder="reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
    </ConfirmDialog>
  );
}

function joinedWords(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const ROLE_CHIP = 'flex items-center gap-1 rounded-control border px-2 py-0.5 text-xs font-semibold';

function MemberInfo({ server, name, onClose }: { server: string; name: string; onClose: () => void }) {
  const room = useAtomValue(roomAtom);
  const me = useAtomValue(meAtom);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const [member, setMember] = useState<GroupMember | null>(null);
  const [missing, setMissing] = useState('');
  const [lines, setLines] = useState<MemberLine[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const end = useRef<HTMLLIElement | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  const close = () => dialogRef.current?.close();
  useSheetBack(close);

  useEffect(() => {
    let live = true;
    api.groupMember(server, name).then(
      (m) => live && setMember(m),
      (err: unknown) => live && setMissing(messageOf(err))
    );
    return () => {
      live = false;
    };
  }, [server, name]);

  const fromRoster = room?.roster?.find((m) => m.name === name);
  const shown = fromRoster ?? member;

  const page = (before: string | null) =>
    api.groupMemberMessages(server, name, before).then(
      (got) => {
        setLines((had) => (before ? [...had, ...got.lines] : got.lines));
        setNext(got.next);
        setError('');
        setBusy(false);
      },
      (err: unknown) => {
        setError(messageOf(err));
        setBusy(false);
      }
    );
  const more = (before: string) => {
    setBusy(true);
    void page(before);
  };
  useEffect(() => {
    void page(null);
  }, [server, name]);

  useEffect(() => {
    const el = end.current;
    if (!el || !next || busy) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void more(next);
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [next, busy]);

  const can = modPowers(room, me, name);
  const seat = voiceSeatOf(room, name);
  const touch = !!room && room.perms.roles && (!shown?.owner || room.owner);
  const held = new Set(shown?.roles.map((r) => r.id) ?? []);
  const toggle = async (id: string, on: boolean) => {
    setSaving(id);
    try {
      if (on) await api.giveRole(server, id, name);
      else await api.takeRole(server, id, name);
      setMember((m) => {
        if (!m) return m;
        const role = room?.roles.find((r) => r.id === id);
        const roles = on && role ? [...m.roles, { id: role.id, name: role.name, color: role.color }] : m.roles.filter((r) => r.id !== id);
        return { ...m, roles };
      });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(null);
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && e.target === e.currentTarget) close();
  };
  const act = (kind: ModKind) => askMod({ kind, name });

  return createPortal(
    <dialog
      ref={dialogRef}
      id="member-info"
      data-sheet=""
      aria-labelledby="member-info-name"
      onPointerDown={onPointerDown}
      onClick={onClick}
      onClose={(event) => {
        event.stopPropagation();
        onClose();
      }}
      className={cn(
        'm-auto flex max-h-[min(720px,calc(100dvh-3rem))] w-[min(560px,calc(100vw-3rem))] flex-col md:rounded-panel border border-primaryStroke bg-backgroundSecondary p-0 text-base text-textPrimary backdrop:bg-black/60 [&:not([open])]:hidden',
        SHEET_DIALOG
      )}
    >
      <SheetGrab onDismiss={close} />
      <div className="flex items-start gap-3 border-b border-primaryStroke p-4">
        <Face name={name} version={shown?.avatar ?? null} className="h-14 w-14 shrink-0 text-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="member-info-name" className="truncate text-lg font-semibold leading-tight">
            {name}
          </h2>
          <p id="member-info-joined" className="text-xs text-textTertiary">
            {shown?.joined ? `joined ${joinedWords(shown.joined)}` : missing || ' '}
          </p>
        </div>
        <Tooltip content="close" at="left">
          <button
            type="button"
            aria-label="close"
            onClick={close}
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-transparent text-textTertiary hover:border-primaryStroke hover:text-textPrimary',
              SHEET_CLOSE
            )}
          >
            ×
          </button>
        </Tooltip>
      </div>
      <div className="flex flex-col gap-3 border-b border-primaryStroke p-4">
        <ul id="member-info-roles" aria-label="roles" className="flex flex-wrap gap-1.5">
          {room?.roles
            .filter((role) => held.has(role.id) || (touch && reaches(room, role.perms)))
            .map((role) => {
              const on = held.has(role.id);
              const edits = touch && reaches(room, role.perms);
              const look = on ? { color: role.color, borderColor: role.color } : undefined;
              return (
                <li key={role.id}>
                  {edits ? (
                    <button
                      type="button"
                      data-role={role.name}
                      aria-pressed={on}
                      disabled={saving !== null || !shown}
                      onClick={() => void toggle(role.id, !on)}
                      style={look}
                      className={cn(ROLE_CHIP, on ? '' : 'border-primaryStroke text-textTertiary hover:text-textPrimary', 'disabled:opacity-50')}
                    >
                      {role.name}
                    </button>
                  ) : (
                    <span data-role={role.name} style={look} className={ROLE_CHIP}>
                      {role.name}
                    </span>
                  )}
                </li>
              );
            })}
          {shown && held.size === 0 && !touch && <li className="text-xs text-textTertiary">no roles</li>}
        </ul>
        {can.any && (
          <div id="member-info-actions" className="flex flex-wrap gap-1.5">
            {seat && can.voice && (
              <>
                {seat.muted ? (
                  <Button size="sm" onClick={() => void setVoiceMute(name, false)}>
                    unmute
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => act('mute')}>
                    mute
                  </Button>
                )}
                <Button size="sm" onClick={() => act('disconnect')}>
                  disconnect
                </Button>
              </>
            )}
            {can.kick && (
              <>
                <Button size="sm" variant="outline-danger" onClick={() => act('kick')}>
                  kick
                </Button>
                <Button size="sm" variant="outline-danger" onClick={() => act('timeout')}>
                  timeout
                </Button>
              </>
            )}
            {can.ban && (
              <Button size="sm" variant="outline-danger" onClick={() => act('ban')}>
                ban
              </Button>
            )}
          </div>
        )}
      </div>
      <ol id="member-info-lines" aria-label="messages" className="flex min-h-40 flex-1 flex-col overflow-y-auto overscroll-contain">
        {lines.map((line) => (
          <LogLine key={`${line.channel}/${line.id}`} line={line} />
        ))}
        {lines.length === 0 && next !== undefined && !busy && <li className="p-4 text-sm text-textTertiary">no messages</li>}
        {error && (
          <li role="status" className="p-4 text-sm text-decrease">
            {error}
          </li>
        )}
        <li ref={end} aria-hidden className="h-px shrink-0" />
        {busy && <li className="p-4 text-sm text-textTertiary">loading…</li>}
      </ol>
    </dialog>,
    document.body
  );
}

function LogLine({ line }: { line: MemberLine }) {
  const words = plainEmotes(line.text) || quoteWords({ text: '', images: line.images?.length ?? 0, video: !!line.video });
  return (
    <li data-id={line.id} data-channel={line.channel} className="flex flex-col gap-0.5 border-b border-primaryStroke/60 px-4 py-2 text-sm">
      <span className="flex items-center gap-2 text-xs text-textTertiary">
        <span className="font-semibold text-textSecondary">#{line.channel}</span>
        <time dateTime={new Date(line.at).toISOString()} title={new Date(line.at).toLocaleString()}>
          {when(line.at)}
        </time>
      </span>
      {line.reply && (
        <span data-reply-quote className="flex min-w-0 items-center gap-1 border-l-2 border-primaryStroke pl-1.5 text-xs leading-4">
          <Face name={line.reply.from} version={line.reply.avatar ?? null} className="h-4 w-4 shrink-0 text-[9px]" />
          <span className="shrink-0 font-semibold text-textPrimary">{line.reply.from}</span>
          <span className="min-w-0 truncate text-textSecondary">{quoteWords({ text: line.reply.text, images: line.reply.images ?? 0, video: line.reply.video })}</span>
        </span>
      )}
      <span className="whitespace-pre-wrap break-words">{words}</span>
    </li>
  );
}
