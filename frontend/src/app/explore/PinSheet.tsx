import { RiArrowRightUpLine, RiPushpinLine, RiUnpinLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, messageOf, type PinnedLine } from '@/infra/api';
import { serverChat } from '@/infra/atoms/chat-atoms';
import { pinsTickAtom } from '@/infra/atoms/room-atoms';
import { chatStyleAtom } from '@/infra/atoms/settings-atoms';
import { RoomLines } from '@/shared-components/ChatPanel';
import { SHEET_FLICK, SHEET_MS, SHEET_SNAP, useSheetBack } from '@/shared-components/MobileSheet';
import { COUNT } from '@/shared-components/Notifications';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** How far a finger moves before the sheet decides it is a swipe up and not a scroll. */
const LOCK_PX = 10;
/** How dark the page under it gets, fully down: a drawer's (SwipeDrawer.tsx). */
const DIM = 0.6;
const SLIDE = 'duration-200 ease-out motion-reduce:transition-none';

/** A line's buttons in the sheet: the drawn line's own hover box (ChatLine.tsx `actions`), PinAction's size. */
const ACTION = 'flex h-6 w-6 items-center justify-center text-textSecondary focus-visible:text-primaryBlue focus-visible:outline-none max-md:h-11 max-md:w-11';

/**
 * A phone's pin in a group's title row (between the back caret and the group's picture): a
 * 44px square, the count on its glyph's corner in the bell's blue square while there are any.
 * It opens and shuts the sheet (`PinSheet`); lit while that is down.
 */
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
          'flex h-11 w-11 shrink-0 items-center justify-center border border-transparent focus-visible:border-primaryBlue focus-visible:outline-none',
          open ? 'text-primaryBlue' : 'text-textSecondary'
        )}
      >
        {/* `relative`: the count sits on the glyph's corner, not the 44px box's */}
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

/**
 * A group channel's pins on a phone (docs/groups.md "pins"): a sheet from the top, straight
 * under the title row, 60% of the window tall, the row over it whole and still pressed. The
 * pinned lines, newest pin first, drawn as the chat draws them (`RoomLines`: the shape this
 * browser picked, the faces, the badges, the pictures), with a jump to the line in the channel
 * on each and, for the channels power, an unpin. It scrolls in itself; the grabber at its foot.
 * A swipe up shuts it, on the grabber, or on the lines once they are scrolled to their end (or
 * fit); so do the pin again, a tap on the dim page under it, Escape and the back button. The
 * slide is 200ms, none for reduced motion. Drawn into the body under the title row (z-20, the
 * row is z-30) and clipped to the window below it, so it slides out from under the row; a
 * drawer (SwipeDrawer.tsx, z-50) and its dim go over it. The list is asked as it opens and
 * again on each pin or unpin while it is (`pinsTickAtom`).
 */
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
  // what was asked, and for which channel: another channel's is no list for this one
  const here = `${server}/${channel}`;
  const [got, setGot] = useState<{ for: string; pins: PinnedLine[] | null; error: string }>({ for: here, pins: null, error: '' });
  const list = got.for === here ? got.pins : null;
  const error = got.for === here ? got.error : '';
  const tick = useAtomValue(pinsTickAtom);
  const shape = useAtomValue(chatStyleAtom);
  const panel = useRef<HTMLDivElement | null>(null);
  const lines = useRef<HTMLDivElement | null>(null);
  const grab = useRef<HTMLDivElement | null>(null);
  // how far up a finger has it, in px (0 or less); null while nobody does
  const [drag, setDrag] = useState<number | null>(null);
  const [height, setHeight] = useState(1);
  // still on screen while it slides shut
  const [sliding, setSliding] = useState(false);
  const change = useRef(onOpenChange);
  useLayoutEffect(() => {
    change.current = onOpenChange;
  });

  useSheetBack(() => change.current(false), open);

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .channelPins(server, channel)
      .then((r) => {
        if (live) setGot({ for: here, pins: r.pins, error: '' });
      })
      .catch((err: unknown) => {
        if (live) setGot((was) => ({ for: here, pins: was.for === here ? was.pins : null, error: messageOf(err) }));
      });
    return () => {
      live = false;
    };
  }, [open, here, server, channel, tick]);

  // shut: on screen until the slide is over, then gone (and so out of the tab order)
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

  // open: the focus goes in, and Escape shuts it. shut: the focus back where it was
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // not while a modal dialog is over it, nor a drawer: that escape is theirs
      if (e.key === 'Escape' && !document.querySelector('dialog:modal, [data-drawer-open]')) change.current(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (before instanceof HTMLElement && panel.current?.contains(document.activeElement)) before.focus({ preventScroll: true });
    };
  }, [open]);

  // the finger, shutting it: a swipe up on the grabber, or on the lines with nothing more under them to scroll to
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
        // down, or across: a scroll, not this sheet's
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
      className={cn('fixed inset-x-0 bottom-0 top-[var(--title-row,4rem)] z-20 overflow-hidden', !shown && 'invisible', !open && 'pointer-events-none')}
    >
      {/* the page, dimmed: a tap shuts the sheet. no panning on it, so the page under does not scroll */}
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
        <div
          ref={lines}
          id="pin-sheet-lines"
          data-style={shape}
          className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 py-1 text-sm leading-snug', shape === 'log' ? 'gap-1' : 'gap-0.5')}
        >
          {error ? (
            <p id="pin-sheet-error" className="py-1 text-decrease">
              {error}
            </p>
          ) : list === null ? (
            <p className="py-1 text-textTertiary">loading…</p>
          ) : list.length === 0 ? (
            <p id="pin-sheet-empty" className="py-1 text-textTertiary">
              nothing pinned yet
            </p>
          ) : (
            shown && (
              <RoomLines
                name={server}
                room={room}
                lines={list}
                lineActions={(line) => (
                  <>
                    <Tooltip content="go to it">
                      <button
                        type="button"
                        data-pin-open={line.id}
                        aria-label="go to it"
                        onClick={() => {
                          onOpenChange(false);
                          void room.openLine(line.id, channel);
                        }}
                        className={cn(ACTION, 'hover:text-primaryBlue')}
                      >
                        <RiArrowRightUpLine aria-hidden size={14} />
                      </button>
                    </Tooltip>
                    {canPin && (
                      <Tooltip content="unpin">
                        <button type="button" data-pin-unpin={line.id} aria-label="unpin" onClick={() => onUnpin(line.id)} className={cn(ACTION, 'hover:text-decrease')}>
                          <RiUnpinLine aria-hidden size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </>
                )}
              />
            )
          )}
        </div>
        {/* the grabber: a swipe up on it shuts the sheet (a sheet's bar, MobileSheet.tsx `SheetGrab`, at the foot) */}
        <div
          ref={grab}
          aria-hidden
          id="pin-sheet-handle"
          className="flex shrink-0 cursor-grab touch-none select-none justify-center pb-2 pt-3 [-webkit-touch-callout:none]"
        >
          <span className="h-1 w-10 bg-primaryStroke" />
        </div>
      </div>
    </div>,
    document.body
  );
}
