import { RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtom, useAtomValue } from 'jotai';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ControlBar, Tile, type TileOf, useCallTiles, useVoiceView } from '@/app/explore/VoiceRoom';
import { type GroupRoom, isVoice } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { voiceSpeakingAtom } from '@/infra/atoms/voice-atoms';
import { hideVoicePip, pipCallKey, voicePipAtAtom, voicePipCollapsedAtom, voicePipHiddenAtom } from '@/infra/atoms/voice-pip-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { useIsMobile } from '@/infra/mobile';
import { clampPip, nextBig, type PipAt, type PipCandidate, parsePipAt, smallRows } from '@/infra/voice-pip';
import { Tooltip } from '@/shared-components/Tooltip';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { cn } from '@/utils/cn';

const EDGE = 24;
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textSecondary hover:border-secondaryStroke hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue';

export function VoicePip({ room }: { room: GroupRoom }) {
  const call = useAtomValue(voiceCallAtom);
  const hidden = useAtomValue(voicePipHiddenAtom);
  const mobile = useIsMobile();
  const view = useVoiceView(room);
  const live = call.phase === 'joining' || call.phase === 'connected';
  const here = live && call.server === room.name && (room.channels ?? []).some((c) => isVoice(c) && c.name === call.channel);
  if (mobile || !here || hidden === pipCallKey(call) || view.view === call.channel) return null;
  return createPortal(<PipWindow room={room} channel={call.channel} />, document.body);
}

function viewport() {
  const root = document.documentElement;
  return { w: Math.floor(Math.min(root.clientWidth, root.getBoundingClientRect().width)), h: root.clientHeight };
}

interface Order {
  call: string;
  seeded: boolean;
  speaking: ReadonlySet<string> | null;
  tick: number;
  active: Map<string, number>;
  streams: Map<string, MediaStream | null>;
  big: string[];
}

let order: Order | null = null;

function bigOf(call: string, tiles: TileOf[], speaking: ReadonlySet<string>): string[] {
  if (order?.call !== call) order = { call, seeded: false, speaking: null, tick: 0, active: new Map(), streams: new Map(), big: [] };
  const m = order;
  for (const t of tiles) {
    if (t.stream && m.seeded && m.streams.get(t.key) !== t.stream) {
      m.tick++;
      m.active.set(t.key, m.tick);
    }
    m.streams.set(t.key, t.stream);
  }
  m.seeded = true;
  if (m.speaking !== speaking) {
    m.speaking = speaking;
    m.tick++;
    for (const name of speaking) m.active.set(`person:${name}`, m.tick);
  }
  const candidates: PipCandidate[] = tiles.map((t) => {
    const voice = m.active.get(`person:${t.name}`) ?? 0;
    const own = m.active.get(t.key) ?? 0;
    return {
      key: t.key,
      speaking: t.kind === 'person' && speaking.has(t.name),
      video: !!t.stream,
      activeAt: Math.max(voice, t.stream ? own : 0),
      self: t.self
    };
  });
  m.big = nextBig(m.big, candidates);
  return m.big;
}

function PipWindow({ room, channel }: { room: GroupRoom; channel: string }) {
  const me = useAtomValue(meAtom) ?? '';
  const call = useAtomValue(voiceCallAtom);
  const [stored, setStored] = useAtom(voicePipAtAtom(me));
  const [collapsed, setCollapsed] = useAtom(voicePipCollapsedAtom);
  const side = useAtomValue(panelSideAtom);
  const sidebarOpen = useAtomValue(friendsOpenAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const view = useVoiceView(room);
  const tiles = useCallTiles(room, channel);
  const big = bigOf(pipCallKey(call), tiles, speaking);
  const ref = useRef<HTMLElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<PipAt | null>(null);
  const [space, setSpace] = useState(viewport);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useStackedWindow(ref, 'voice');

  useEffect(() => {
    const fit = () =>
      setSpace((was) => {
        const now = viewport();
        return now.w === was.w && now.h === was.h ? was : now;
      });
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(document.documentElement);
    window.addEventListener('resize', fit);
    return () => {
      watcher.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((was) => (was.w === el.offsetWidth && was.h === el.offsetHeight ? was : { w: el.offsetWidth, h: el.offsetHeight }));
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);

  useEffect(() => () => stop.current?.(), []);

  const fallback: PipAt = { right: side === 'right' ? (sidebarOpen ? 324 : 80) : EDGE, bottom: EDGE };
  const at = clampPip(drag ?? parsePipAt(stored) ?? fallback, space, size);

  const press = (e: ReactPointerEvent) => {
    if (e.button !== 0 || stop.current) return;
    if ((e.target as Element).closest('button')) return;
    e.preventDefault();
    const start = at;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const pointerId = e.pointerId;
    let last: PipAt | null = null;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const el = ref.current;
      last = clampPip(
        { right: start.right - (ev.clientX - x0), bottom: start.bottom - (ev.clientY - y0) },
        viewport(),
        el ? { w: el.offsetWidth, h: el.offsetHeight } : size
      );
      setDrag(last);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop.current?.();
      if (last) setStored(last);
      setDrag(null);
    };
    stop.current = () => {
      stop.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const people = tiles.filter((t) => t.kind === 'person').length;
  const bigTiles = big.flatMap((k) => tiles.filter((t) => t.key === k));
  const { shown, more } = smallRows(tiles.filter((t) => !big.includes(t.key)));
  const openMiddle = () => view.open(channel);
  const tile = (t: TileOf, kind: 'pip' | 'mini') => (
    <Tile
      key={t.key}
      tile={t}
      size={kind}
      version={avatarOf(t.name)}
      talking={t.kind === 'person' && speaking.has(t.name)}
      focused={false}
      label={`open ${channel} in the middle`}
      onClick={openMiddle}
    />
  );
  const status = call.phase === 'joining' || !call.linked ? 'connecting…' : `${people} in`;

  return (
    <section
      ref={ref}
      id="voice-pip"
      aria-label={`call: ${channel}`}
      data-collapsed={collapsed || undefined}
      style={{ right: at.right, bottom: at.bottom }}
      className="fixed flex w-[400px] max-w-[calc(100vw-16px)] flex-col rounded-panel border border-primaryStroke bg-backgroundSecondary text-sm"
    >
      <header
        id="voice-pip-head"
        onPointerDown={press}
        className={cn('flex min-h-11 shrink-0 cursor-move touch-none select-none items-center gap-2 px-3 [-webkit-touch-callout:none]', drag && 'cursor-grabbing')}
      >
        <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />
        <h2 id="voice-pip-channel" className="min-w-0 truncate font-semibold text-textPrimary">
          {channel}
        </h2>
        <span id="voice-pip-status" className={cn('shrink-0 text-xs tabular-nums', status === 'connecting…' ? 'text-textTertiary' : 'font-semibold text-increase')}>
          {status}
        </span>
        <span className="flex-1" />
        <HeadButton id="voice-pip-collapse" label={collapsed ? 'expand' : 'collapse'} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <RiArrowUpSLine aria-hidden size={16} /> : <RiArrowDownSLine aria-hidden size={16} />}
        </HeadButton>
        <HeadButton id="voice-pip-close" label="hide call window" onClick={hideVoicePip}>
          <RiCloseLine aria-hidden size={16} />
        </HeadButton>
      </header>
      {!collapsed && (
        <div id="voice-pip-tiles" className="flex flex-col gap-1.5 px-2 pb-2">
          <div id="voice-pip-big" className={cn('grid gap-1.5', bigTiles.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
            {bigTiles.map((t) => tile(t, 'pip'))}
          </div>
          {shown.length + more.length > 0 && (
            <div id="voice-pip-small" className="grid grid-cols-4 gap-1.5">
              {shown.map((t) => tile(t, 'mini'))}
              {more.length > 0 && <More tiles={more} onClick={openMiddle} />}
            </div>
          )}
        </div>
      )}
      <ControlBar mobile={false} pip />
    </section>
  );
}

function More({ tiles, onClick }: { tiles: TileOf[]; onClick: () => void }) {
  const names = tiles.map((t) => (t.kind === 'screen' ? `${t.name}'s screen` : t.name));
  const label = `${tiles.length} more: ${names.join(', ')}`;
  return (
    <Tooltip content={label}>
      <button
        id="voice-pip-more"
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex aspect-video items-center justify-center rounded-card border border-primaryStroke bg-backgroundTertiary text-sm font-semibold tabular-nums text-textSecondary hover:border-secondaryStroke hover:text-textPrimary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue bubble:border-transparent bubble:hover:border-secondaryStroke"
      >
        +{tiles.length}
      </button>
    </Tooltip>
  );
}

function HeadButton({ id, label, onClick, children }: { id: string; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip content={label}>
      <button id={id} type="button" aria-label={label} onClick={onClick} className={HEAD_BUTTON}>
        {children}
      </button>
    </Tooltip>
  );
}
