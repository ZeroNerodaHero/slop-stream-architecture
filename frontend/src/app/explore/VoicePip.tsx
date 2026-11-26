import { RiArrowDownSLine, RiArrowUpSLine, RiCloseLine, RiPhoneLine, RiVolumeUpLine } from '@remixicon/react';
import { useAtom, useAtomValue } from 'jotai';
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';

import { CallControls, ControlBar, Tile, type TileOf, useCallTiles, useVoiceView } from '@/app/explore/VoiceRoom';
import { type GroupRoom, isVoice } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { callRoomAtom } from '@/infra/atoms/call-room-atoms';
import { type DmCall, dmCallAtom, dmCallRoom } from '@/infra/atoms/dm-call-atoms';
import { openDmWith } from '@/infra/atoms/dm-atoms';
import { friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { voiceSpeakingAtom } from '@/infra/atoms/voice-atoms';
import { callBarSlotAtom, hideVoicePip, pipCallKey, voicePipAtAtom, voicePipCollapsedAtom, voicePipHiddenAtom } from '@/infra/atoms/voice-pip-atoms';
import { voiceCallAtom } from '@/infra/atoms/voice-state';
import { briefPhase, callStatus } from '@/infra/dm-call';
import { useIsMobile } from '@/infra/mobile';
import { cleanName } from '@/infra/names';
import {
  bigFit,
  clampPip,
  clampPipSize,
  nextStage,
  PIP_COLUMNS,
  PIP_SIZE,
  type PipAt,
  type PipCandidate,
  type PipSize,
  parsePipAt,
  parsePipSize,
  smallRows,
  stripFit
} from '@/infra/voice-pip';
import { SHEET_FLICK, SHEET_MS, SHEET_SNAP, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { cn } from '@/utils/cn';

const EDGE = 24;
const GAP = 6;
const PULL = 8;
const TAP_AFTER_PULL = 400;
const HANDLES = [
  {
    id: 'corner',
    sx: true,
    sy: true,
    tip: true,
    className: '-left-px -top-px h-4 w-4 cursor-nwse-resize rounded-tl-panel border-l-2 border-t-2 border-primaryBlue opacity-0 transition-opacity duration-150 group-hover/pip:opacity-100 group-data-[resizing]/pip:opacity-100'
  },
  { id: 'left', sx: true, sy: false, tip: false, className: '-left-px bottom-0 top-4 w-1.5 cursor-ew-resize' },
  { id: 'top', sx: false, sy: true, tip: false, className: '-top-px left-4 right-0 h-1.5 cursor-ns-resize' }
] as const;
const NAME_BUTTON =
  'flex min-w-0 items-baseline gap-1.5 rounded-control border border-transparent text-left hover:border-primaryStroke hover:bg-backgroundTertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue';
const HEAD_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textSecondary hover:border-secondaryStroke hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue';

export function VoicePip() {
  const call = useAtomValue(voiceCallAtom);
  const room = useAtomValue(callRoomAtom);
  const hidden = useAtomValue(voicePipHiddenAtom);
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const match = useMatch('/groups/:server/*');
  const { pathname } = useLocation();
  const page = !!match && cleanName(match.params.server) === call.server;
  const view = useVoiceView(page ? room : null);
  const dm = useAtomValue(dmCallAtom);
  const me = useAtomValue(meAtom) ?? '';
  const myAvatar = useAtomValue(myAvatarVersionAtom);
  const live = call.phase === 'joining' || call.phase === 'connected';
  if (dm && (briefPhase(dm.phase) ? call.phase === 'idle' || call.server === dm.server : live && call.server === dm.server)) {
    const dmRoom = dmCallRoom(dm, me, myAvatar);
    const chat = () => openDmWith(dm.peer);
    if (mobile) return <CallBar key={pathname} room={dmRoom} channel={dm.channel} open={chat} dm={dm} />;
    return createPortal(<PipWindow room={dmRoom} channel={dm.channel} page={false} open={chat} dm={dm} />, document.body);
  }
  if (!live || !room || room.name !== call.server || !(room.channels ?? []).some((c) => isVoice(c) && c.name === call.channel)) return null;
  const open = () =>
    page ? view.open(call.channel) : navigate(`/groups/${encodeURIComponent(room.name)}?voice=${encodeURIComponent(call.channel)}`);
  if (mobile) return page ? null : <CallBar key={pathname} room={room} channel={call.channel} open={open} />;
  if ((page && hidden === pipCallKey(call)) || view.view === call.channel) return null;
  return createPortal(<PipWindow room={room} channel={call.channel} page={page} open={open} />, document.body);
}

function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

function dmStatusOf(dm: DmCall, linked: boolean, now: number): { text: string; good: boolean } {
  const text = callStatus(dm.phase, dm.peer, linked ? dm.since : null, now);
  return { text, good: dm.phase === 'live' && linked && dm.since !== null };
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
      self: t.self,
      screen: t.kind === 'screen'
    };
  });
  m.big = nextStage(m.big, candidates);
  return m.big;
}

function CallTiles({
  at,
  room,
  channel,
  tiles,
  open,
  stripMax,
  expanded,
  setExpanded
}: {
  at: string;
  room: GroupRoom;
  channel: string;
  tiles: TileOf[];
  open: () => void;
  stripMax: string;
  expanded: boolean;
  setExpanded: (on: boolean) => void;
}) {
  const call = useAtomValue(voiceCallAtom);
  const speaking = useAtomValue(voiceSpeakingAtom);
  const big = bigOf(pipCallKey(call), tiles, speaking);
  const tilesRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(PIP_COLUMNS);
  const bigTiles = big.flatMap((k) => tiles.filter((t) => t.key === k));
  const staged = bigTiles.length;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const strip = tilesRef.current;
    if (!stage || !strip) return;
    const place = () => {
      const f = bigFit(staged, stage.clientWidth, stage.clientHeight, GAP);
      stage.style.setProperty('--pip-cols', `${f.cols}`);
      stage.style.setProperty('--pip-tile', `${f.tile}px`);
      const pad = getComputedStyle(strip);
      setFit(stripFit(strip.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight), GAP));
    };
    place();
    const watcher = new ResizeObserver(place);
    watcher.observe(stage);
    watcher.observe(strip);
    return () => watcher.disconnect();
  }, [staged]);

  const avatarOf = (name: string) => room.roster?.find((m) => m.name === name)?.avatar ?? null;
  const rest = tiles.filter((t) => !big.includes(t.key));
  const { shown, more } = expanded ? { shown: rest, more: [] } : smallRows(rest, fit, 1);
  const tile = (t: TileOf, kind: 'pip' | 'mini') => (
    <Tile
      key={t.key}
      tile={t}
      size={kind}
      version={avatarOf(t.name)}
      talking={t.kind === 'person' && speaking.has(t.name)}
      focused={false}
      label={`open ${channel} in the middle`}
      onClick={open}
    />
  );

  return (
    <div ref={tilesRef} id={`${at}-tiles`} className="flex min-h-0 flex-1 flex-col gap-1.5 px-2 pb-2">
      <div
        ref={stageRef}
        id={`${at}-big`}
        className="grid min-h-0 flex-1 grid-cols-[repeat(var(--pip-cols),var(--pip-tile))] content-center justify-center gap-1.5 overflow-hidden"
      >
        {bigTiles.map((t) => tile(t, 'pip'))}
      </div>
      {rest.length > 0 && (
        <div
          id={`${at}-small`}
          style={{ gridTemplateColumns: `repeat(${fit}, minmax(0, 1fr))` }}
          className={cn('grid shrink-0 gap-1.5', expanded && cn(stripMax, 'overflow-y-auto'))}
        >
          {shown.map((t) => tile(t, 'mini'))}
          {more.length > 0 && <More at={at} tiles={more} open={false} onClick={() => setExpanded(true)} />}
          {expanded && rest.length > fit && <More at={at} tiles={[]} open onClick={() => setExpanded(false)} />}
        </div>
      )}
    </div>
  );
}

function PipWindow({ room, channel, page, open, dm = null }: { room: GroupRoom; channel: string; page: boolean; open: () => void; dm?: DmCall | null }) {
  const me = useAtomValue(meAtom) ?? '';
  const call = useAtomValue(voiceCallAtom);
  const [stored, setStored] = useAtom(voicePipAtAtom(me));
  const [collapsed, setCollapsed] = useAtom(voicePipCollapsedAtom);
  const side = useAtomValue(panelSideAtom);
  const sidebarOpen = useAtomValue(friendsOpenAtom);
  const tiles = useCallTiles(room, channel);
  const ref = useRef<HTMLElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const sizing = useRef<PipSize | null>(null);
  const measure = useRef<() => void>(() => undefined);
  const [drag, setDrag] = useState<PipAt | null>(null);
  const [space, setSpace] = useState(viewport);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [expanded, setExpanded] = useState(false);
  const box = clampPipSize(parsePipSize(stored) ?? PIP_SIZE, space);

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
    if (!el || sizing.current) return;
    el.style.setProperty('--pip-w', `${box.w}px`);
    el.style.setProperty('--pip-h', `${box.h}px`);
  }, [box.w, box.h]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure.current = () => {
      if (sizing.current) return;
      setSize((was) => (was.w === el.offsetWidth && was.h === el.offsetHeight ? was : { w: el.offsetWidth, h: el.offsetHeight }));
    };
    measure.current();
    const watcher = new ResizeObserver(() => measure.current());
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
      const kept = parsePipSize(stored);
      if (last) setStored(kept ? { ...last, ...kept } : last);
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

  const resize = (e: ReactPointerEvent<HTMLElement>, sx: boolean, sy: boolean) => {
    const el = ref.current;
    if (e.button !== 0 || stop.current || !el) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const start = box;
    const anchor = at;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const pointerId = e.pointerId;
    const root = document.documentElement;
    const select = root.style.getPropertyValue('user-select');
    let next = start;
    let frame = 0;
    sizing.current = start;
    root.style.setProperty('user-select', 'none');
    el.toggleAttribute('data-resizing', true);
    const paint = () => {
      frame = 0;
      el.style.setProperty('--pip-w', `${next.w}px`);
      el.style.setProperty('--pip-h', `${next.h}px`);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      next = clampPipSize({ w: sx ? start.w - (ev.clientX - x0) : start.w, h: sy ? start.h - (ev.clientY - y0) : start.h }, viewport(), anchor);
      sizing.current = next;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      stop.current?.();
      paint();
      if (next.w !== start.w || next.h !== start.h) setStored({ ...anchor, ...next });
      measure.current();
    };
    stop.current = () => {
      stop.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      sizing.current = null;
      if (select) root.style.setProperty('user-select', select);
      else root.style.removeProperty('user-select');
      el.toggleAttribute('data-resizing', false);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };

  const now = useTick(dm?.phase === 'live');
  const people = tiles.filter((t) => t.kind === 'person').length;
  const linked = call.phase === 'connected' && call.linked;
  const dmStatus = dm ? dmStatusOf(dm, linked, now) : null;
  const status = dmStatus ? dmStatus.text : !linked ? 'connecting…' : `${people} in`;
  const good = dmStatus ? dmStatus.good : linked;

  return (
    <section
      ref={ref}
      id="voice-pip"
      aria-label={`call: ${dm ? dm.peer : channel}`}
      data-dm-call={dm ? dm.phase : undefined}
      data-collapsed={collapsed || undefined}
      style={{ right: at.right, bottom: at.bottom }}
      className={cn(
        'group/pip fixed flex w-[var(--pip-w)] flex-col rounded-panel border border-primaryStroke bg-backgroundSecondary text-sm',
        collapsed ? 'h-auto' : 'h-[var(--pip-h)]'
      )}
    >
      <header
        id="voice-pip-head"
        onPointerDown={press}
        className={cn('flex min-h-11 shrink-0 cursor-move touch-none select-none items-center gap-2 px-3 [-webkit-touch-callout:none]', drag && 'cursor-grabbing')}
      >
        {dm ? <RiPhoneLine aria-hidden size={14} className="shrink-0 text-textTertiary" /> : <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />}
        <h2 id="voice-pip-channel" className="flex min-w-0">
          <Tooltip content={dm ? `open the chat with ${dm.peer}` : page ? `open ${channel} in the middle` : `go to ${channel} in ${room.name}`} hideOnPress>
            <button id="voice-pip-go" type="button" onClick={open} className={cn(NAME_BUTTON, 'px-1.5 py-0.5')}>
              <span className="truncate font-semibold text-textPrimary">{dm ? dm.peer : channel}</span>
              {!page && !dm && <span className="truncate text-xs text-textTertiary">{room.name}</span>}
            </button>
          </Tooltip>
        </h2>
        <span id="voice-pip-status" className={cn('shrink-0 text-xs tabular-nums', good ? 'font-semibold text-increase' : 'text-textTertiary')}>
          {status}
        </span>
        <span className="flex-1" />
        <HeadButton id="voice-pip-collapse" label={collapsed ? 'expand' : 'collapse'} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <RiArrowUpSLine aria-hidden size={16} /> : <RiArrowDownSLine aria-hidden size={16} />}
        </HeadButton>
        {page && (
          <HeadButton id="voice-pip-close" label="hide call window" onClick={hideVoicePip}>
            <RiCloseLine aria-hidden size={16} />
          </HeadButton>
        )}
      </header>
      {!collapsed && (
        <CallTiles
          at="voice-pip"
          room={room}
          channel={channel}
          tiles={tiles}
          open={open}
          stripMax="max-h-[calc(var(--pip-h)/2)]"
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
      <ControlBar mobile={false} pip />
      {HANDLES.map((h) => {
        if (collapsed && !h.sx) return null;
        const handle = (
          <div
            key={h.id}
            id={`voice-pip-resize-${h.id}`}
            aria-hidden
            onPointerDown={(e) => resize(e, h.sx, h.sy && !collapsed)}
            className={cn('absolute touch-none select-none', h.className)}
          />
        );
        return h.tip ? (
          <Tooltip key={h.id} content="drag to resize" hideOnPress>
            {handle}
          </Tooltip>
        ) : (
          handle
        );
      })}
    </section>
  );
}

interface Pull {
  id: number;
  y: number;
  at: number;
  lastT: number;
  speed: number;
  from: number;
  height: number;
  dragging: boolean;
  frame: number;
  el: HTMLElement;
}

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function settle(panel: HTMLElement, on: boolean) {
  panel.getBoundingClientRect();
  panel.style.transition = still() ? 'none' : `transform ${SHEET_MS}ms ease-out`;
  panel.style.transform = on ? 'translateY(0)' : 'translateY(-100%)';
}

function CallBar({ room, channel, open, dm = null }: { room: GroupRoom; channel: string; open: () => void; dm?: DmCall | null }) {
  const call = useAtomValue(voiceCallAtom);
  const slot = useAtomValue(callBarSlotAtom);
  const tiles = useCallTiles(room, channel);
  const barRef = useRef<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef<HTMLButtonElement | null>(null);
  const held = useRef<Pull | null>(null);
  const pulled = useRef(-Infinity);
  const timer = useRef(0);
  const [up, setUp] = useState(false);
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const people = tiles.filter((t) => t.kind === 'person').length;
  const connecting = call.phase === 'joining' || !call.linked;
  const now = useTick(dm?.phase === 'live');
  const dmStatus = dm ? dmStatusOf(dm, !connecting, now) : null;
  const status = dmStatus ? dmStatus.text : connecting ? 'connecting…' : `${people} in`;
  const good = dmStatus ? dmStatus.good : !connecting;
  const title = dm ? dm.peer : channel;

  useStackedWindow(boxRef, 'voice', live);

  const go = (next: boolean) => {
    const panel = panelRef.current;
    if (panel) settle(panel, next);
    window.clearTimeout(timer.current);
    if (!next) timer.current = window.setTimeout(() => setLive(false), still() ? 0 : SHEET_MS);
    setUp(next);
  };

  useSheetBack(() => go(false), up);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (held.current?.frame) window.cancelAnimationFrame(held.current.frame);
    },
    []
  );

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (live && up && panel && !held.current) settle(panel, true);
  }, [live, up]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const box = boxRef.current;
    if (!live || !bar || !box) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      box.style.top = `${bar.getBoundingClientRect().bottom}px`;
    };
    const soon = () => {
      if (!frame) frame = window.requestAnimationFrame(place);
    };
    place();
    const watcher = new ResizeObserver(soon);
    watcher.observe(bar);
    watcher.observe(document.documentElement);
    const vv = window.visualViewport;
    window.addEventListener('scroll', soon, { passive: true });
    window.addEventListener('resize', soon);
    vv?.addEventListener('resize', soon);
    vv?.addEventListener('scroll', soon);
    return () => {
      window.cancelAnimationFrame(frame);
      watcher.disconnect();
      window.removeEventListener('scroll', soon);
      window.removeEventListener('resize', soon);
      vv?.removeEventListener('resize', soon);
      vv?.removeEventListener('scroll', soon);
    };
  }, [live, slot]);

  const shown = (h: Pull) => Math.min(h.height, Math.max(0, h.from * h.height + h.at - h.y));

  const paint = (h: Pull) => {
    h.frame = 0;
    const panel = panelRef.current;
    if (!panel) return;
    if (!h.height) h.height = panel.offsetHeight;
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${shown(h) - h.height}px)`;
  };

  const down = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || held.current) return;
    if ((e.target as Element).closest('button:not([data-pull])')) return;
    held.current = {
      id: e.pointerId,
      y: e.clientY,
      at: e.clientY,
      lastT: e.timeStamp,
      speed: 0,
      from: up ? 1 : 0,
      height: 0,
      dragging: false,
      frame: 0,
      el: e.currentTarget
    };
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    if (!h.dragging) {
      if (Math.abs(e.clientY - h.y) < PULL) return;
      h.dragging = true;
      h.y = e.clientY;
      h.at = e.clientY;
      h.el.setPointerCapture(h.id);
      window.clearTimeout(timer.current);
      if (!live) setLive(true);
    }
    const dt = e.timeStamp - h.lastT;
    if (dt > 0) h.speed = (e.clientY - h.at) / dt;
    h.at = e.clientY;
    h.lastT = e.timeStamp;
    if (!h.frame) h.frame = window.requestAnimationFrame(() => paint(h));
  };

  const end = (e: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const h = held.current;
    if (!h || e.pointerId !== h.id) return;
    held.current = null;
    if (h.frame) window.cancelAnimationFrame(h.frame);
    h.frame = 0;
    if (!h.dragging) return;
    pulled.current = e.timeStamp;
    if (h.el.hasPointerCapture(h.id)) h.el.releasePointerCapture(h.id);
    const panel = panelRef.current;
    h.height = panel?.offsetHeight ?? 0;
    const p = shown(h);
    const was = h.from === 1;
    const next = cancelled ? was : h.speed > SHEET_FLICK ? true : h.speed < -SHEET_FLICK ? false : p > h.height * (was ? 1 - SHEET_SNAP : SHEET_SNAP);
    go(next);
  };

  const tapped = (e: ReactMouseEvent) => e.timeStamp - pulled.current > TAP_AFTER_PULL;

  const toggle = (e: ReactMouseEvent) => {
    if (!tapped(e)) return;
    if (up) go(false);
    else if (live) go(true);
    else {
      setLive(true);
      setUp(true);
    }
  };

  const pull = {
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => end(e),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => end(e, true)
  };

  if (!slot) return null;
  const label = up ? 'hide call' : 'show call';

  return (
    <>
      {createPortal(
        <section
          ref={barRef}
          id="voice-bar"
          aria-label={`call: ${title}`}
          data-dm-call={dm ? dm.phase : undefined}
          {...pull}
          className="flex touch-none select-none items-center gap-2 border-b border-primaryStroke bg-backgroundSecondary px-3 py-2 text-sm bubble:border-transparent [-webkit-touch-callout:none] [html[data-keyboard]_&]:hidden"
        >
          <Tooltip content={label} hideOnPress>
            <button
              ref={grabRef}
              id="voice-bar-grab"
              type="button"
              data-pull=""
              aria-label={label}
              aria-expanded={up}
              aria-controls="voice-sheet"
              onClick={toggle}
              className={cn(HEAD_BUTTON, 'h-11 w-11')}
            >
              {up ? <RiArrowUpSLine aria-hidden size={20} /> : <RiArrowDownSLine aria-hidden size={20} />}
            </button>
          </Tooltip>
          <button
            id="voice-bar-go"
            type="button"
            data-pull=""
            aria-label={dm ? `open the chat with ${dm.peer}` : `go to ${channel} in ${room.name}`}
            onClick={(e) => {
              if (tapped(e)) open();
            }}
            className={cn(NAME_BUTTON, 'min-h-11 min-w-0 flex-1 items-center border-primaryStroke bg-background px-2')}
          >
            {dm ? <RiPhoneLine aria-hidden size={14} className="shrink-0 text-textTertiary" /> : <RiVolumeUpLine aria-hidden size={14} className="shrink-0 text-textTertiary" />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold text-textPrimary">{title}</span>
              {!dm && <span className="truncate text-xs text-textTertiary">{room.name}</span>}
            </span>
            <span id="voice-bar-status" className={cn('ml-auto shrink-0 text-xs tabular-nums', good ? 'font-semibold text-increase' : 'text-textTertiary')}>
              {status}
            </span>
          </button>
          <CallControls at="voice-bar" />
        </section>,
        slot
      )}
      {live &&
        createPortal(
          <div ref={boxRef} className="pointer-events-none fixed inset-x-0 bottom-0 overflow-hidden">
            <div
              ref={panelRef}
              id="voice-sheet"
              role="region"
              aria-label={`call: ${title}`}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                go(false);
                grabRef.current?.focus();
              }}
              className="pointer-events-auto flex h-[min(30rem,calc(100%-1rem))] -translate-y-full flex-col rounded-b-panel border-b border-primaryStroke bg-backgroundSecondary pt-2 text-sm bubble:border-transparent"
            >
              <CallTiles at="voice-sheet" room={room} channel={channel} tiles={tiles} open={open} stripMax="max-h-40" expanded={expanded} setExpanded={setExpanded} />
              <ControlBar mobile={false} pip />
              <div aria-hidden data-pull="" {...pull} className="flex shrink-0 cursor-grab touch-none select-none justify-center pb-2 pt-1 [-webkit-touch-callout:none]">
                <span className="h-1 w-10 rounded-control bg-primaryStroke" />
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

function More({ at, tiles, open, onClick }: { at: string; tiles: TileOf[]; open: boolean; onClick: () => void }) {
  const names = tiles.map((t) => (t.kind === 'screen' ? `${t.name}'s screen` : t.name));
  const label = open ? 'show fewer' : `${tiles.length} more: ${names.join(', ')}`;
  return (
    <Tooltip content={label}>
      <button
        id={open ? `${at}-less` : `${at}-more`}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${at}-small`}
        onClick={onClick}
        className="flex aspect-video items-center justify-center rounded-card border border-primaryStroke bg-backgroundTertiary text-xs font-semibold tabular-nums text-textSecondary hover:border-secondaryStroke hover:text-textPrimary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primaryBlue bubble:border-transparent bubble:hover:border-secondaryStroke"
      >
        {open ? <RiArrowUpSLine aria-hidden size={16} /> : `+${tiles.length} more`}
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
