import { RiArrowRightUpLine, RiPushpinLine, RiUnpinLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { messageOf, type PinnedLine } from '@/infra/api';
import { loadChannelPins, serverChat } from '@/infra/atoms/chat-atoms';
import { pinsTickAtom, roleColorsAtom } from '@/infra/atoms/room-atoms';
import { Badge } from '@/shared-components/Badge';
import { pictureSrc } from '@/shared-components/ChatPanel';
import { clock } from '@/shared-components/ChatLine';
import { Face } from '@/shared-components/Face';
import { LiveMark } from '@/shared-components/LiveMark';
import { SHEET_FLICK, SHEET_MS, SHEET_SNAP, useSheetBack } from '@/shared-components/MobileSheet';
import { COUNT } from '@/shared-components/NotificationsBell';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const LOCK_PX = 10;
const DIM = 0.6;
const SLIDE = 'duration-200 ease-out motion-reduce:transition-none';

const ACTION =
  "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-control border before:absolute before:-inset-x-[3px] before:-inset-y-2.5 before:content-[''] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue";

function PinRow({ line, canPin, onJump, onUnpin }: { line: PinnedLine; canPin: boolean; onJump: () => void; onUnpin: () => void }) {
  const { server, colors } = useAtomValue(roleColorsAtom);
  const tint = line.verified && server !== null ? colors.get(line.from) : undefined;
  const color = tint ? undefined : line.streamer ? 'text-increase' : line.verified ? 'text-primaryBlue' : 'text-decrease';
  const someone = line.verified || line.streamer;
  const pictures = line.images ?? [];
  const words = line.text || (line.video ? 'video' : line.audio ? 'voice message' : pictures.length > 0 ? (pictures.length === 1 ? 'picture' : `${pictures.length} pictures`) : '');
  return (
    <li data-id={line.id} className="relative flex items-start gap-3 p-3 focus-within:bg-backgroundSecondary active:bg-backgroundSecondary">
      <Face name={line.from} version={line.avatar} className="h-8 w-8 text-sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          data-pin-open={line.id}
          aria-label={`jump to message from ${line.from}${line.text ? `: ${line.text}` : ''}`}
          onClick={onJump}
          className="flex min-w-0 flex-col gap-0.5 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-1 leading-5">
            <span className={cn('truncate font-semibold', color)} style={tint ? { color: tint } : undefined}>
              {line.from}
            </span>
            {someone && line.oauth_verified && <OAuthMark size={14} className="shrink-0" />}
            {line.groups.map((group) => (
              <Badge key={group.name} group={group} size="xs" className="shrink-0" />
            ))}
            {line.streamer && <LiveMark aria-hidden size="xs" className="shrink-0" />}
            <time dateTime={new Date(line.at).toISOString()} className="shrink-0 text-xs tabular-nums text-textTertiary">
              {clock(line.at)}
            </time>
          </span>
          {words && <span className={cn('truncate', line.text ? 'text-textSecondary' : 'text-textTertiary')}>{words}</span>}
        </button>
        {pictures.length > 0 && (
          <span data-pin-pictures={line.id} aria-hidden className="mt-1 flex gap-1">
            {pictures.map((id) => (
              <img key={id} src={pictureSrc(id)} alt="" draggable={false} loading="lazy" className="h-8 w-8 shrink-0 rounded-card bg-backgroundTertiary object-cover" />
            ))}
          </span>
        )}
      </div>
      <div className="flex shrink-0 gap-1.5 self-center">
        {canPin && (
          <Tooltip content="unpin">
            <button
              type="button"
              data-pin-unpin={line.id}
              aria-label="unpin"
              onClick={(e) => {
                e.stopPropagation();
                onUnpin();
              }}
              className={cn(ACTION, 'border-primaryStroke text-textSecondary hover:text-decrease')}
            >
              <RiUnpinLine aria-hidden size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="jump to message">
          <button
            type="button"
            data-pin-jump={line.id}
            aria-label="jump to message"
            onClick={(e) => {
              e.stopPropagation();
              onJump();
            }}
            className={cn(ACTION, 'border-primaryBlue text-primaryBlue')}
          >
            <RiArrowRightUpLine aria-hidden size={14} />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}

export function PinSheetButton({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }) {
  return (
    <Tooltip content={open ? null : 'pinned messages'}>
      <button
        type="button"
        id="pin-sheet-open"
        aria-label={count === 0 ? 'pinned messages' : `pinned messages: ${count}`}
        aria-expanded={open}
        aria-controls="pin-sheet"
        data-count={count}
        onClick={onClick}
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none',
          open ? 'text-primaryBlue' : 'text-textSecondary'
        )}
      >
        <span className="relative flex">
          <RiPushpinLine aria-hidden size={22} />
          {count > 0 && (
            <span id="pin-sheet-count" aria-hidden className={COUNT}>
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
      </button>
    </Tooltip>
  );
}

export function PinSheet({
  server,
  channel,
  open,
  onOpenChange,
  canPin,
  onUnpin
}: {
  server: string;
  channel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canPin: boolean;
  onUnpin: (id: string) => void;
}) {
  const here = `${server}/${channel}`;
  const [got, setGot] = useState<{ for: string; pins: PinnedLine[] | null; error: string }>({ for: here, pins: null, error: '' });
  const list = got.for === here ? got.pins : null;
  const error = got.for === here ? got.error : '';
  const tick = useAtomValue(pinsTickAtom);
  const panel = useRef<HTMLDivElement | null>(null);
  const lines = useRef<HTMLDivElement | null>(null);
  const grab = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [height, setHeight] = useState(1);
  const [sliding, setSliding] = useState(false);
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });

  useSheetBack(() => change.current(false), open);

  useEffect(() => {
    if (!open) return;
    let live = true;
    loadChannelPins(server, channel)
      .then((pins) => {
        if (live) setGot({ for: here, pins, error: '' });
      })
      .catch((err: unknown) => {
        if (live) setGot((was) => ({ for: here, pins: was.for === here ? was.pins : null, error: messageOf(err) }));
      });
    return () => {
      live = false;
    };
  }, [open, here, server, channel, tick]);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setSliding(true);
  }
  useEffect(() => {
    if (open) return;
    const done = window.setTimeout(() => setSliding(false), SHEET_MS);
    return () => window.clearTimeout(done);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog:modal, [data-drawer-open]')) change.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement && panel.current?.contains(document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    let start: { x: number; y: number } | null = null;
    let up = false;
    let at = 0;
    let lastY = 0;
    let lastT = 0;
    let speed = 0;

    function begin(e: TouchEvent) {
      start = null;
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch) return;
      const list = lines.current;
      const onGrab = e.target instanceof Node && grab.current?.contains(e.target);
      const atEnd = !list || list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if (!onGrab && !atEnd) return;
      start = { x: touch.clientX, y: touch.clientY };
      up = false;
      at = 0;
      lastY = touch.clientY;
      lastT = e.timeStamp;
      speed = 0;
      setHeight(el?.offsetHeight || 1);
    }

    function move(e: TouchEvent) {
      const touch = e.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!up) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
        if (dy > 0 || Math.abs(dx) > Math.abs(dy)) {
          start = null;
          return;
        }
        up = true;
      }
      e.preventDefault();
      at = Math.min(0, dy);
      const dt = e.timeStamp - lastT;
      if (dt > 0) speed = (touch.clientY - lastY) / dt;
      lastY = touch.clientY;
      lastT = e.timeStamp;
      setDrag(at);
    }

    function end() {
      if (!start) return;
      start = null;
      if (!up) return;
      const shut = speed < -SHEET_FLICK || -at > (el?.offsetHeight || 1) * SHEET_SNAP;
      setDrag(null);
      if (shut) change.current(false);
    }

    function cancel() {
      start = null;
      setDrag(null);
    }

    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    return () => {
      el.removeEventListener('touchstart', begin);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', cancel);
    };
  }, []);

  const shown = open || sliding;
  const room = serverChat(server);
  const dim = open ? DIM * (1 + (drag ?? 0) / height) : 0;

  return createPortal(
    <div
      data-sheet-open={open || undefined}
      className={cn(
        'fixed inset-x-0 bottom-0 top-[calc(var(--title-row,4rem)+var(--banner-h,0px))] z-20 overflow-hidden',
        !shown && 'invisible',
        !open && 'pointer-events-none'
      )}
    >
      <div
        aria-hidden
        id="pin-sheet-scrim"
        onClick={() => onOpenChange(false)}
        className={cn('absolute inset-0 touch-none bg-black', drag === null && cn('transition-opacity', SLIDE))}
        style={{ opacity: dim }}
      />
      <div
        ref={panel}
        id="pin-sheet"
        role="dialog"
        aria-label="pinned messages"
        tabIndex={-1}
        inert={!shown}
        className={cn(
          'absolute inset-x-0 top-0 flex h-[60dvh] flex-col border-b border-primaryStroke bg-background text-textPrimary outline-none',
          drag === null && cn('transition-transform', SLIDE)
        )}
        style={{ transform: open ? `translateY(${drag ?? 0}px)` : 'translateY(-100%)' }}
      >
        <div ref={lines} id="pin-sheet-lines" className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain text-sm leading-snug">
          {error ? (
            <p id="pin-sheet-error" className="p-3 text-decrease">
              {error}
            </p>
          ) : list === null ? (
            <p className="p-3 text-textTertiary">loading…</p>
          ) : list.length === 0 ? (
            <p id="pin-sheet-empty" className="p-3 text-textTertiary">
              nothing pinned yet
            </p>
          ) : (
            shown && (
              <ul id="pin-sheet-list" className="flex flex-col divide-y divide-primaryStroke border-b border-primaryStroke">
                {list.map((line) => (
                  <PinRow
                    key={line.id}
                    line={line}
                    canPin={canPin}
                    onJump={() => {
                      onOpenChange(false);
                      void room.jumpToReply(line.id, channel);
                    }}
                    onUnpin={() => onUnpin(line.id)}
                  />
                ))}
              </ul>
            )
          )}
        </div>
        <div
          ref={grab}
          aria-hidden
          id="pin-sheet-handle"
          className="flex shrink-0 cursor-grab touch-none select-none justify-center pb-2 pt-3 [-webkit-touch-callout:none]"
        >
          <span className="h-1 w-10 rounded-control bg-primaryStroke" />
        </div>
      </div>
    </div>,
    document.body
  );
}
