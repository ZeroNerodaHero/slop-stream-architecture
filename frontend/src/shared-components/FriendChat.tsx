import { RiAddLine, RiArrowLeftSLine, RiCloseLine, RiImageAddLine, RiSearchLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type CSSProperties,
  type DOMAttributes,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';

import { api, type DmLine, messageOf } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { MAX_CHAT_IMAGES } from '@/infra/atoms/chat-atoms';
import { type ChatBox as Box, keepDmBox, keptDmBox } from '@/infra/atoms/chat-layout-atoms';
import {
  clearDmResults,
  type Dm,
  dmActiveAtom,
  dmJumpAtom,
  dmNoticeAtom,
  dmOpenAtom,
  dmResultsAtom,
  dmThreadsAtom,
  dmsAtom,
  hideDms,
  loadOlderDm,
  markRead,
  openDm,
  openDmLine,
  pickDm,
  reactDm,
  removeDm,
  searchDm,
  selectDm,
  sendDm,
  showDmNotice
} from '@/infra/atoms/dm-atoms';
import { followingAtom, friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { chatStyleAtom, type PanelSide, panelSideAtom } from '@/infra/atoms/settings-atoms';
import { keepFocus, stuckAfterScroll, useBottomPin, useKeyboard } from '@/infra/keyboard';
import { useIsMobile } from '@/infra/mobile';
import { compressChatImage } from '@/infra/picture';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { ChatLineShape, LineActions, placeOf, quoteWords, ReplyQuote } from '@/shared-components/ChatLine';
import { ChatImages, pictureSrc } from '@/shared-components/ChatPanel';
import { comboProps, SearchFilters, SearchHit, SearchResults, SearchSuggestions, useChatSearch } from '@/shared-components/ChatSearch';
import { Face } from '@/shared-components/Face';
import { LinkedText } from '@/shared-components/LinkedText';
import { SHEET_FLICK, SHEET_MS, SHEET_SNAP, useSheetBack } from '@/shared-components/MobileSheet';
import { panelClassName } from '@/shared-components/Panel';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { ReactionChips } from '@/shared-components/Reactions';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { ProfileLink, profilePath, useShowProfile } from '@/shared-components/ProfileLink';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { INPUT, INPUT_BUTTON } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
/** The smallest the window goes: room for the column of faces, a few lines, and the box with its button. */
const MIN_W = 300;
const MIN_H = 260;
/** How long the pointer rests on a face before its card shows. */
const PEEK_MS = 100;
/** Within this many px of the newest line counts as "at the bottom": a new line keeps the view there. */
const STUCK_PX = 40;
/** A line may be this long, the api's rule. */
const MAX_CHARS = 500;

/** The square a face sits in, in the column and in the grid: a stroke, blue on the one that is on. */
const SQUARE = 'relative block shrink-0 border transition-[border-color] duration-150 focus-visible:outline-none';
const SQUARE_OFF = 'border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue';
const SQUARE_ON = 'border-primaryBlue';
/** An icon on the header, the search and the ×: a stroke on hover and on focus, the colour its own. */
const HEADER_BUTTON =
  'shrink-0 border border-transparent p-0.5 transition-colors duration-150 hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

/** Slid along with the pointer, stopped at the edges. */
function moved(rect: DOMRect, dx: number, dy: number): Box {
  const r = room();
  return {
    x: clamp(rect.left + dx, 0, Math.max(0, r.w - rect.width)),
    y: clamp(rect.top + dy, 0, Math.max(0, r.h - rect.height)),
    w: rect.width,
    h: rect.height
  };
}

/** A corner pulled. The opposite corner stays put, and the box stops at the screen edge. */
function resized(rect: DOMRect, dx: number, dy: number, sx: number, sy: number): Box {
  const r = room();
  let x = rect.left;
  let y = rect.top;
  let w = rect.width;
  let h = rect.height;
  if (sx > 0) w = clamp(w + dx, MIN_W, Math.max(MIN_W, r.w - x));
  else {
    w = clamp(w - dx, MIN_W, rect.right);
    x = rect.right - w;
  }
  if (sy > 0) h = clamp(h + dy, MIN_H, Math.max(MIN_H, r.h - y));
  else {
    h = clamp(h - dy, MIN_H, rect.bottom);
    y = rect.bottom - h;
  }
  return { x, y, w, h };
}

/** The same box, back on screen: the browser window shrank, the chat was left somewhere while hidden, or it was kept from a bigger window. No smaller than the smallest, unless the screen is. */
function fitted(box: Box): Box {
  const r = room();
  const w = Math.min(Math.max(box.w, MIN_W), r.w);
  const h = Math.min(Math.max(box.h, MIN_H), r.h);
  return { w, h, x: clamp(box.x, 0, Math.max(0, r.w - w)), y: clamp(box.y, 0, Math.max(0, r.h - h)) };
}

/** The corner handles, the stream chat window's. `sx`/`sy`: which way the box grows when that corner is pulled outward. */
const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

const tabId = (name: string) => `friend-chat-tab-${name}`;

/** The presence square on a face's corner (PresenceSquare.tsx), ringed in the window's background. */
const RING = 'border-backgroundSecondary';

interface TabProps {
  dm: Dm;
  selected: boolean;
  /** Reachable by the tab key: the shown face, else the first. */
  reachable: boolean;
  side: PanelSide;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * One face on the column, with its presence square, how many of their lines are new, and the
 * × in its corner that takes the chat off the column. Pointing at it, or tabbing onto it, puts
 * the person's card (PersonCard.tsx, the sidebar's) beside the column. A click on another face
 * shows that chat; a click on the shown one shows them (the popup, or their page: ProfileLink.tsx).
 */
function Tab({ dm, selected, reachable, side, onKey }: TabProps) {
  const peek = usePeek(PEEK_MS);
  const profile = useShowProfile();
  // the shown one's tab goes to their page on a click while the popup is off: asked for on the press
  const prefetch = usePrefetchOnPointerDown(selected && !profile.popup ? profilePath(dm.name) : null);
  return (
    <span
      className="group/tab relative shrink-0"
      onPointerEnter={(e) => peek.show(e, e.currentTarget.closest('#friend-chat-rail'))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.show(e, e.currentTarget.closest('#friend-chat-rail'))}
      onBlur={peek.blur}
      onKeyDown={peek.keyDown}
    >
      <button
        id={tabId(dm.name)}
        role="tab"
        type="button"
        aria-selected={selected}
        aria-controls="friend-chat-thread"
        tabIndex={reachable ? 0 : -1}
        aria-label={`chat with ${dm.name}${dm.unread > 0 ? `, ${dm.unread} new` : ''}`}
        aria-haspopup={selected && profile.popup ? 'dialog' : undefined}
        data-unread={dm.unread || undefined}
        {...prefetch}
        onClick={() => {
          // the shown one's face is them, the roster's way: the popup, or their page (ProfileLink.tsx)
          if (selected) {
            profile.show(dm, dm.presence === 'streaming');
            return;
          }
          selectDm(dm.name);
          // a click means "talk to them": straight into the box (the same node for every tab, so it is there already)
          document.getElementById('friend-chat-text')?.focus();
        }}
        onKeyDown={onKey}
        className={cn(SQUARE, selected ? SQUARE_ON : SQUARE_OFF)}
      >
        <Face name={dm.name} version={dm.avatar} />
        <PresenceSquare status={dm.presence} className={RING} />
        {/* how many of their lines came while this was not on screen: the sidebar's number, in the other corner */}
        {dm.unread > 0 && (
          <span
            id={`friend-chat-unread-${dm.name}`}
            aria-hidden
            className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center border border-backgroundSecondary bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
          >
            {dm.unread > 99 ? '99+' : dm.unread}
          </span>
        )}
      </button>
      {/* this chat off the column, from the face's corner. there while the pointer is on the face, or the tab key reaches it */}
      <Tooltip content="close this chat (it is back when a line comes)">
        <button
          id={`friend-chat-remove-${dm.name}`}
          type="button"
          aria-label={`close the chat with ${dm.name}`}
          onClick={() => removeDm(dm.name)}
          className={cn(
            'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary',
            'opacity-0 transition-opacity duration-150 hover:border-primaryBlue hover:text-textPrimary focus-visible:opacity-100 focus-visible:outline-none group-hover/tab:opacity-100'
          )}
        >
          <RiCloseLine aria-hidden size={10} />
        </button>
      </Tooltip>
      {peek.at && <PersonCard id={`friend-chat-peek-${dm.name}`} person={dm} at={peek.at} side={side} hold={peek.hold} />}
    </span>
  );
}

/**
 * The column down the side of the window that faces the sidebar: the open chats, a face each
 * with its presence square, and a + under the last for a new one. The shown one wears the
 * blue stroke (the + does, while the friends to pick from are showing); a click shows another,
 * and the arrow keys walk the faces.
 */
function Rail({ dms, active, side }: { dms: Dm[]; active: string | null; side: PanelSide }) {
  function onKey(e: KeyboardEvent<HTMLButtonElement>, at: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const next = dms[(at + (e.key === 'ArrowDown' ? 1 : -1) + dms.length) % dms.length];
    if (!next) return;
    selectDm(next.name);
    document.getElementById(tabId(next.name))?.focus();
  }
  return (
    <div
      id="friend-chat-rail"
      // no bar: it would take width from the faces. the column scrolls all the same
      className={cn(
        'flex shrink-0 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        side === 'right' ? 'border-l border-primaryStroke' : 'border-r border-primaryStroke'
      )}
    >
      <div id="friend-chat-tabs" role="tablist" aria-orientation="vertical" aria-label="open chats" className="flex flex-col gap-2">
        {dms.map((d, i) => (
          <Tab key={d.name} dm={d} selected={d.name === active} reachable={d.name === active || (active === null && i === 0)} side={side} onKey={(e) => onKey(e, i)} />
        ))}
      </div>
      <Tooltip content="new chat: pick a friend">
        <button
          id="friend-chat-new"
          type="button"
          aria-pressed={active === null}
          aria-label="new chat"
          onClick={pickDm}
          className={cn(
            SQUARE,
            'flex h-[calc(2.5rem+2px)] w-[calc(2.5rem+2px)] items-center justify-center',
            active === null ? cn(SQUARE_ON, 'text-primaryBlue') : cn(SQUARE_OFF, 'text-textSecondary')
          )}
        >
          <RiAddLine aria-hidden size={20} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The friends to pick from, where a thread would be: everyone who follows you back, a face
 * with its presence square and the name under it, the ones with a chat on the column in the
 * blue stroke. A pick opens their chat, or shows the one they have. Friends alone: a line can
 * only go to somebody who chose you back. A phone's sheet (`list`) has them as a list instead:
 * a row each, the face with its presence square, the name, and the last line said when there
 * is one to hand (the thread on screen before, or the list of threads).
 */
function Picker({ dms, list = false }: { dms: Dm[]; list?: boolean }) {
  const following = useAtomValue(followingAtom);
  const threads = useAtomValue(dmThreadsAtom);
  const me = useAtomValue(meAtom);
  const friends = following?.filter((f) => f.mutual) ?? [];
  const open = new Set(dms.map((d) => d.name));
  if (list) {
    return (
      <div id="friend-chat-pick" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {following === undefined ? (
          <Skeleton id="friend-chat-pick-loading" className="flex flex-col">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                <Bone className="h-10 w-10" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Bone className="h-3.5 w-24" />
                  <Bone className="h-3 w-40" />
                </div>
              </div>
            ))}
          </Skeleton>
        ) : friends.length === 0 ? (
          <p id="friend-chat-pick-empty" className="p-3 text-sm text-textSecondary">
            nobody follows you back yet. a chat is with a friend: someone you follow who follows you.
          </p>
        ) : (
          <ul aria-label="friends" className="flex flex-col">
            {friends.map((f) => {
              const tab = dms.find((d) => d.name === f.name);
              const last = threads[f.name]?.lines.at(-1) ?? tab?.last;
              const said = last && (last.text || (last.images.length > 0 ? 'a picture' : ''));
              return (
                <li key={f.name} className="border-b border-primaryStroke">
                  <button
                    id={`friend-chat-pick-${f.name}`}
                    type="button"
                    aria-label={`chat with ${f.name}${tab?.unread ? `, ${tab.unread} new` : ''}`}
                    onClick={() => openDm({ id: '', name: f.name, avatar: f.avatar, verified: f.verified, bio: f.bio, presence: f.presence })}
                    className="flex min-h-14 w-full items-center gap-3 border border-transparent px-3 py-2 text-left focus-visible:border-primaryBlue focus-visible:outline-none active:bg-backgroundTertiary"
                  >
                    <span className="relative block shrink-0">
                      <Face name={f.name} version={f.avatar} />
                      <PresenceSquare status={f.presence} className={RING} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Who name={f.name} verified={f.verified} />
                      {said && (
                        <span className={cn('truncate text-sm', tab?.unread ? 'text-textPrimary' : 'text-textTertiary')}>
                          {last.from === me ? 'you: ' : ''}
                          {said}
                        </span>
                      )}
                    </span>
                    {tab && tab.unread > 0 && (
                      <span aria-hidden className="flex h-5 min-w-5 shrink-0 items-center justify-center bg-primaryBlue px-1 text-xs font-semibold leading-none text-background">
                        {tab.unread > 99 ? '99+' : tab.unread}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div id="friend-chat-pick" className="min-h-0 flex-1 overflow-y-auto p-3">
      {following === undefined ? (
        // the grid of squares in grey before the list has answered: a face and a name's worth each
        <Skeleton id="friend-chat-pick-loading" className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5 p-2">
              <Bone className="h-10 w-10" />
              <Bone className="h-3 w-12" />
            </div>
          ))}
        </Skeleton>
      ) : friends.length === 0 ? (
        <p id="friend-chat-pick-empty" className="text-sm text-textSecondary">
          nobody follows you back yet. a chat is with a friend: someone you follow who follows you.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-textSecondary">pick a friend to chat with.</p>
          <ul aria-label="friends" className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2">
            {friends.map((f) => (
              <li key={f.name}>
                <button
                  id={`friend-chat-pick-${f.name}`}
                  type="button"
                  aria-label={`chat with ${f.name}`}
                  title={f.bio || f.name}
                  onClick={() => openDm({ id: '', name: f.name, avatar: f.avatar, verified: f.verified, bio: f.bio, presence: f.presence })}
                  className={cn(SQUARE, 'flex w-full flex-col items-center gap-1.5 p-2', open.has(f.name) ? SQUARE_ON : SQUARE_OFF)}
                >
                  <span className="relative block">
                    <Face name={f.name} version={f.avatar} />
                    <PresenceSquare status={f.presence} className={RING} />
                  </span>
                  <span className="w-full truncate text-center text-xs">{f.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** How far up a phone's sheet comes: this share of the window's height, its top 20% down. */
const SHEET = 0.8;
/** At least this much of the dimmed page stays above the sheet while the keyboard is up, to tap it shut. */
const SHEET_GAP = 24;
/** The keyboard up, the sheet keeps its top while it is at least this tall; a shorter window moves its top up instead. */
const SHEET_MIN = 200;
const SHEET_SLIDE = 'duration-200 ease-out motion-reduce:transition-none';
/** How dark the page behind the sheet gets. */
const SHEET_DIM = 0.6;

/** The handlers a drag down by the grabber or the sheet's head goes through. */
type SheetGrip = Pick<DOMAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;

/**
 * A phone's chat sheet, while `active` (a phone, the chat open): the slide up once it is on
 * screen, the slide down before `onDismiss` takes it off (a tap on the dim page, a drag down
 * let go past `SHEET_SNAP` of its height or flicked, Escape, the browser's back button), and the
 * keyboard's place (`useKeyboard`, keyboard.ts: while its box has the focus the document is pinned,
 * so iOS cannot scroll the page to bring the box over the keyboard).
 * `grip` goes on the grabber and on the head: the sheet follows the finger. The drag's numbers and
 * the back button are every phone sheet's (MobileSheet.tsx).
 */
function useSheet(active: boolean, onDismiss: () => void) {
  const kb = useKeyboard();
  const view = active && kb.height ? kb : null;
  // in: a frame after it is on screen, so the slide up has a place to start from. leaving: sliding down, then gone
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // px pulled down while a finger holds it; null while nobody does
  const [drag, setDrag] = useState<number | null>(null);
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    setEntered(false);
    setLeaving(false);
    setDrag(null);
  }
  const held = useRef<{ id: number; y: number; lastY: number; lastT: number; speed: number } | null>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!leaving) return;
    const done = window.setTimeout(() => dismiss.current(), SHEET_MS);
    return () => window.clearTimeout(done);
  }, [leaving]);

  // the back button slides it down too
  useSheetBack(() => setLeaving(true), active);

  useEffect(() => {
    if (!active) return;
    // not while a modal dialog is over it (that one's escape is its own). a panel that is merely shown (the notifications) does not count
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog:modal')) setLeaving(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const grip: SheetGrip = {
    onPointerDown(e) {
      if (e.button !== 0 || held.current || (e.target as Element).closest('button, input, textarea, a')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      held.current = { id: e.pointerId, y: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
    },
    onPointerMove(e) {
      const h = held.current;
      if (!h || e.pointerId !== h.id) return;
      const dt = e.timeStamp - h.lastT;
      if (dt > 0) h.speed = (e.clientY - h.lastY) / dt;
      h.lastY = e.clientY;
      h.lastT = e.timeStamp;
      setDrag(Math.max(0, e.clientY - h.y));
    },
    onPointerUp(e) {
      const h = held.current;
      if (!h || e.pointerId !== h.id) return;
      held.current = null;
      const pulled = Math.max(0, e.clientY - h.y);
      const tall = e.currentTarget.closest('#friend-chat')?.getBoundingClientRect().height ?? window.innerHeight * SHEET;
      setDrag(null);
      if (h.speed > SHEET_FLICK || pulled > tall * SHEET_SNAP) setLeaving(true);
    },
    onPointerCancel(e) {
      if (held.current?.id !== e.pointerId) return;
      held.current = null;
      setDrag(null);
    }
  };

  return { view, drag, up: entered && !leaving, leave: () => setLeaving(true), grip, raised: (view?.bottom ?? 0) > 0 };
}

type Sheet = ReturnType<typeof useSheet>;

/**
 * A phone's chat (below 768px, mobile.ts): a sheet up from the foot of the window to 20% from its
 * top, over the page dimmed, with a grabber at its head (`useSheet`). It sits on the keyboard
 * while one is up: its top stays where it was if it can, and it shrinks so the box's row sits
 * flush on the keyboard (the foot of the visual viewport, `useKeyboard`); on a window too
 * short for that its top comes up too, never past `SHEET_GAP` from the top. The page under it
 * does not scroll (globals.css's `data-sheet-open`, and keyboard.ts's pin while typing). Drawn into the
 * body, over the drawers.
 */
function MobileSheet({ sheet, label, with: name, children }: { sheet: Sheet; label: string; with?: string; children: ReactNode }) {
  const { view, drag, up, grip } = sheet;
  const full = window.innerHeight * SHEET;
  let height = full;
  let bottom: number | undefined;
  if (view) {
    // the keyboard's top, from the layout viewport's top
    const foot = view.top + view.height;
    const top = Math.min(window.innerHeight - full, Math.max(view.top + SHEET_GAP, foot - SHEET_MIN));
    height = Math.max(0, foot - top);
    bottom = Math.max(0, window.innerHeight - foot);
  }
  const shown = up ? 1 - Math.min(1, (drag ?? 0) / Math.max(1, height)) : 0;
  return createPortal(
    <div data-sheet-open="" className="fixed inset-0 z-[55] overflow-hidden">
      {/* the page, dimmed: a tap shuts the sheet. no panning on it, so the page under does not scroll */}
      <div
        aria-hidden
        onClick={sheet.leave}
        className={cn('absolute inset-0 touch-none bg-black', drag === null && cn('transition-opacity', SHEET_SLIDE))}
        style={{ opacity: shown * SHEET_DIM }}
      />
      <section
        id="friend-chat"
        role="dialog"
        aria-modal
        aria-label={label}
        data-with={name}
        className={cn(
          'absolute inset-x-0 bottom-0 flex h-[80dvh] flex-col overflow-x-hidden border-t border-primaryStroke bg-backgroundSecondary pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-base text-textPrimary',
          drag === null && cn('transition-transform', SHEET_SLIDE)
        )}
        style={{ ...(view ? { bottom, height } : {}), transform: up ? `translateY(${drag ?? 0}px)` : 'translateY(100%)' }}
      >
        {/* the grabber: a bar to pull the sheet down by */}
        <div aria-hidden {...grip} className={cn('flex shrink-0 justify-center pb-1 pt-2', GRIP)}>
          <span className="h-1 w-10 bg-primaryStroke" />
        </div>
        {children}
      </section>
    </div>,
    document.body
  );
}

/**
 * Direct chats with friends (docs/dms.md), opened from the sidebar: one window, a tab per
 * friend down its side, dragged by its header, resized from a corner. The lines are the
 * api's: a page on opening a thread, older pages as you scroll up, new ones as they come on
 * the events socket, from either side and from your other devices. A thread keeps its
 * half-typed draft, and the pictures picked for its next line, while another tab is shown. The
 * header is the name alone, the glass and the ×: the glass opens a search box under it
 * (`#friend-chat-search`, the room chat's words and filter words, `ChatSearch.tsx`) that asks
 * the thread on screen (`searchDm`); the hits take the lines' whole place (`#friend-chat-results`,
 * `SearchResults`, the lines kept under it unseen), and one clicked puts the lines back with
 * it in view, the pages back to it loaded as needed (`openDmLine`); `close` puts them back as
 * they were. The ×
 * hides the window and keeps everything; a friend's chat button in the sidebar brings it back. With no tab
 * shown, the friends to pick from are where the thread would be, under `no chat` when there
 * are no tabs at all (a phone's sheet: under `friends`, as a list, and its back button and the
 * browser's back come to it from a chat). The lines take the shape the chat tab picked for every chat
 * (settings.chatStyle, drawn by ChatLine.tsx as the rooms' are): a log, bubbles, or blocks;
 * the log carries it as `data-style`, and your name is the blue one. A line may carry
 * pictures, the room chat's way: the picture button beside the box (`#friend-chat-picture`)
 * picks files, each is shrunk and put up at once and waits in a strip over the box with its ×
 * until the line goes; a line may be pictures alone.
 */
export function FriendChat() {
  const me = useAtomValue(meAtom);
  const dms = useAtomValue(dmsAtom);
  const active = useAtomValue(dmActiveAtom);
  const open = useAtomValue(dmOpenAtom);
  const threads = useAtomValue(dmThreadsAtom);
  const notice = useAtomValue(dmNoticeAtom);
  const results = useAtomValue(dmResultsAtom);
  const jump = useAtomValue(dmJumpAtom);
  const side = useAtomValue(panelSideAtom);
  const shape = useAtomValue(chatStyleAtom);
  const myAvatar = useAtomValue(myAvatarVersionAtom);
  const following = useAtomValue(followingAtom);
  /** A phone: the chat is a sheet up from the foot (MobileSheet), not the window. */
  const mobile = useIsMobile();
  const sheet = useSheet(mobile && open, hideDms);
  // a phone's chat in the sheet: the browser's back goes to the friends to pick from first, and the sheet's own back after.
  // declared after the sheet's, so it is the newer on the back button's stack (MobileSheet.tsx)
  useSheetBack(pickDm, mobile && open && active !== null);
  const { pathname } = useLocation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The search box is under the header. One box for the window: its words stay through a change of tab, the hits are the thread's they were asked of. */
  const [searching, setSearching] = useState(false);
  /** Each thread's pictures waiting to go with its next line: the ids `POST /api/chat-images` handed back, kept like the draft while another tab is shown. */
  const [pending, setPending] = useState<Record<string, string[]>>({});
  /** Each thread's line the next send answers (the action bar's reply), kept like the draft while another tab is shown. */
  const [replies, setReplies] = useState<Record<string, DmLine | null>>({});
  /** The line a reply's quote just jumped to, lit for a moment. */
  const [flash, setFlash] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);
  /** A picked picture is being shrunk and put up: the picture button waits, and so does send, so a line does not go without the picture meant for it. */
  const [uploading, setUploading] = useState(false);
  /** Where the window was left and its size, kept over a refresh (chat-layout-atoms.ts). `null` is the default, the bottom corner beside the sidebar at 400 by 440, until the first move or resize. */
  const [box, setBox] = useState<Box | null>(() => {
    const kept = keptDmBox();
    return kept && fitted(kept);
  });
  const ref = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  /** Ends the drag in progress: its window listeners go. `null` between drags. */
  const stop = useRef<(() => void) | null>(null);
  /** The view sits on the newest line. Someone who scrolled up to read is left there. */
  const stuck = useRef(true);
  /** The log's height before the last paint, so prepending older lines can put the same pixels back. */
  const hold = useRef(0);
  /** Older lines are on their way: the next paint keeps the view where it was instead of jumping to the bottom. */
  const prepending = useRef(false);
  /** The thread a line of yours is on its way to: its next paint that brings lines goes to the newest, wherever the reader had scrolled. */
  const sentJump = useRef<string | null>(null);
  /** The thread the log last showed: a change of thread starts at the bottom. */
  const shownThread = useRef<string | undefined>(undefined);
  /** The oldest line the log last drew: one older than it next time is a page put above (the scroll's, or a hit's). */
  const oldestShown = useRef<number | undefined>(undefined);
  /** The jump last made (`dmJumpAtom`'s `n`): a tab shown again does not jump to its old hit. */
  const jumped = useRef(0);
  // each tab's person with the sidebar's current words over the ones it opened with: the list is asked again on every open of the sidebar
  const people = dms.map((d) => {
    const now = following?.find((f) => f.name === d.name);
    return now ? { ...d, avatar: now.avatar, verified: now.verified, bio: now.bio, presence: now.presence } : d;
  });
  const dm = active === null ? null : (people.find((d) => d.name === active) ?? null);
  const name = dm?.name;
  const thread = name ? threads[name] : undefined;
  const lines = thread?.lines ?? [];
  const draft = (name && drafts[name]) || '';
  const pictures = (name && pending[name]) || [];
  const replyTo = (name && replies[name]) || null;
  // the hits over the lines: a search's, while the thread it asked is the one on screen
  const hits = results?.name === name ? results : null;
  // the box's words and the filter words, the room chat's; submitting asks the thread on screen. `from:` is one of the two, each with their face
  const search = useChatSearch(
    searchInput,
    (q) => {
      if (name) void searchDm(name, q);
    },
    {
      people:
        me && name
          ? [
              { name: me, avatar: myAvatar },
              { name, avatar: dm?.avatar ?? null }
            ]
          : []
    }
  );
  // a logout, or a change of login, drops everything (docs/dms.md). the box and its words are this component's
  // own state, out of `closeAllDms`'s reach, so they go here, in the render that sees the new login (not an
  // effect: no pass with the old words first)
  const [lastMe, setLastMe] = useState(me);
  if (me !== lastMe) {
    setLastMe(me);
    setSearching(false);
    search.setQuery('');
    setReplies({});
  }

  useEffect(() => {
    keepDmBox(box);
  }, [box]);

  // A moved or resized window is pulled back on screen when the browser window shrinks, and on showing, in case it did while this was hidden.
  // not on a phone: the sheet has no box, and the kept one is the desktop's
  useEffect(() => {
    if (!open || mobile) return;
    const fit = () =>
      setBox((b) => {
        if (!b) return b;
        const next = fitted(b);
        return next.x === b.x && next.y === b.y && next.w === b.w && next.h === b.h ? b : next;
      });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open, mobile]);

  // a phone: the sheet opens in place of the sidebar's drawer (a chat button in it, most often), and a page change
  // (a name in the sheet tapped) takes it down, so the page it went to is not under it
  useEffect(() => {
    if (mobile && open) store.set(friendsOpenAtom, false);
  }, [mobile, open]);
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (mobile && open) hideDms();
  }, [pathname, mobile, open]);

  // a tab shown: the box takes focus. not while the arrow keys walk the tabs: focus stays on the face they landed on.
  // not on a phone either: the keyboard would come up over the lines before they were read
  useEffect(() => {
    if (!name || !open || mobile) return;
    const focused = document.activeElement;
    if (focused instanceof Element && focused.closest('#friend-chat-tabs')) return;
    input.current?.focus();
  }, [name, open]);

  // the tab comes back to the front with a thread on screen: what came meanwhile has been seen
  useEffect(() => {
    if (!name || !open) return;
    const onShow = () => {
      if (document.visibilityState === 'visible') markRead(name);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [name, open]);

  // Keep the newest line in view, unless the reader has scrolled up; older lines prepended keep the same pixels on screen.
  // A layout effect: before the paint, so nothing flashes at the wrong place.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const oldest = lines[0]?.id;
    // a page put above the lines on screen: the scroll asked for it, or a hit is loading its way back (`openDmLine`)
    const older = shownThread.current === name && oldestShown.current !== undefined && oldest !== undefined && oldest < oldestShown.current;
    // another thread on screen since the send: that one starts at its bottom anyway
    if (sentJump.current !== name) sentJump.current = null;
    if (sentJump.current && shownThread.current === name) {
      // your own send: to the bottom. a page of older lines still on its way keeps its flag, and holds its place when it lands
      sentJump.current = null;
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
    } else if (prepending.current || older) {
      el.scrollTop += el.scrollHeight - hold.current;
      prepending.current = false;
    } else if (stuck.current || shownThread.current !== name) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
    }
    hold.current = el.scrollHeight;
    shownThread.current = name;
    oldestShown.current = oldest;
  }, [lines.length, name, open]);

  // A hit clicked (`openDmLine`): its line is among the drawn ones by now, and the log centres it by its own
  // scroll, not scrollIntoView, which would scroll the page under the window too. The view is off the
  // newest line then and stays where it was put, as one scrolled up to read is. After the effect above, so
  // the page the hit loaded does not move it after it has landed.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !jump || jump.name !== name || jump.n === jumped.current) return;
    const node = el.querySelector(`[data-id="${jump.id}"]`);
    if (!(node instanceof HTMLElement)) return;
    jumped.current = jump.n;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - (el.clientHeight - node.offsetHeight) / 2;
    stuck.current = false;
  }, [jump, name]);

  // the glass pressed: the box takes the focus, so the words can be typed at once
  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  // The newest line stays in view when the log changes shape after the lines did: a picture on a
  // line finishes loading and the line grows, the strip of picked pictures opens under the log, or
  // a phone's keyboard comes up and the sheet shrinks over it (keyboard.ts)
  useBottomPin(log, stuck, `${name}:${open}`);

  // the window going while a drag is on: its listeners go with it
  useEffect(() => () => stop.current?.(), []);

  // a reply begun (the action bar's reply): the box takes the focus, so the words go straight in
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  if (!open) return null;

  function setDraft(text: string) {
    if (name) setDrafts((prev) => ({ ...prev, [name]: text }));
  }

  function setPictures(ids: string[]) {
    if (name) setPending((prev) => ({ ...prev, [name]: ids }));
  }

  function setReply(line: DmLine | null) {
    if (name) setReplies((prev) => ({ ...prev, [name]: line }));
  }

  /** A reply's quote clicked: its line in view (`openDmLine`, the pages back to it asked for), lit for a moment; or, when the thread has no such line, a word under the box. */
  async function jumpTo(id: number) {
    if (!name) return;
    if (!(await openDmLine(name, id))) {
      showDmNotice('that line is not here any more');
      return;
    }
    setFlash(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }

  /** The search box down, its words and the hits with it: the glass pressed again, or escape in the box. The focus back to the text box, where it was. */
  function closeSearch() {
    setSearching(false);
    search.setQuery('');
    clearDmResults();
    input.current?.focus();
  }

  /**
   * The files picked for the thread on screen, each shrunk and put up (`compressChatImage`,
   * `POST /api/chat-images`) and its id kept for the next line; past the cap the rest are left,
   * with a word under the box. The room chat's `pickPictures` (ChatPanel.tsx).
   */
  async function pickPictures(list: FileList | null) {
    const files = list ? [...list] : [];
    if (!name || files.length === 0 || uploading) return;
    const forThread = name;
    const room = MAX_CHAT_IMAGES - pictures.length;
    const batch = files.slice(0, Math.max(0, room));
    if (files.length > room) showDmNotice(`${MAX_CHAT_IMAGES} pictures at most`);
    if (batch.length === 0) return;
    setUploading(true);
    try {
      for (const file of batch) {
        const blob = await compressChatImage(file);
        const saved = await api.uploadChatImage(blob);
        // into the thread the pick was for, even if another tab is shown by the time the upload lands
        setPending((prev) => {
          const have = prev[forThread] ?? [];
          return have.includes(saved.id) || have.length >= MAX_CHAT_IMAGES ? prev : { ...prev, [forThread]: [...have, saved.id] };
        });
      }
    } catch (err) {
      showDmNotice(messageOf(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      input.current?.focus();
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!name || (!draft.trim() && pictures.length === 0) || sending || uploading) return;
    setSending(true);
    // the thread's lines are one run from the newest back (dm-atoms.ts), so the newest is always loaded: the line just goes on the bottom, and the view with it
    sentJump.current = name;
    const sent = await sendDm(name, draft, pictures, replyTo?.id ?? null);
    setSending(false);
    if (!sent) sentJump.current = null;
    if (sent) {
      setDraft('');
      setPictures([]);
      setReply(null);
    }
    input.current?.focus();
  }

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stuck.current = stuckAfterScroll(el, stuck.current, STUCK_PX);
    if (el.scrollTop < 48 && name && thread?.loaded && !thread.start && !prepending.current) {
      prepending.current = true;
      hold.current = el.scrollHeight;
      void loadOlderDm(name).then((came) => {
        if (!came) prepending.current = false;
      });
    }
  }

  /**
   * A press on the header (a move) or on a corner (a resize): the window follows the pointer,
   * through window listeners so leaving the handle loses nothing, and stops at the screen's edges.
   */
  function press(e: ReactPointerEvent, kind: 'move' | 'resize', sx = 0, sy = 0) {
    const el = ref.current;
    if (e.button !== 0 || stop.current || !el) return;
    if ((e.target as Element).closest('button, input, textarea, a')) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setBox(kind === 'move' ? moved(rect, dx, dy) : resized(rect, dx, dy, sx, sy));
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) stop.current?.();
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
  }

  const style: CSSProperties | undefined = box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined;
  const rail = <Rail dms={people} active={name ?? null} side={side} />;
  const left = MAX_CHARS - [...draft.trim()].length;
  // a phone's header buttons are a finger's 44px square, their icons a size up
  const headerButton = mobile ? cn(HEADER_BUTTON, 'flex h-11 w-11 items-center justify-center p-0') : HEADER_BUTTON;
  const headerIcon = mobile ? 20 : 16;
  // a phone's sheet is the thread alone: the column of faces is the window's, and the drawer's chat buttons pick another
  const tabbed = Boolean(name) && !mobile;

  const content = (
    <>
      {side === 'left' && !mobile && rail}
      <div
        id="friend-chat-thread"
        role={tabbed ? 'tabpanel' : undefined}
        aria-labelledby={tabbed && name ? tabId(name) : undefined}
        className={cn('flex min-w-0 flex-1 flex-col', mobile && 'min-h-0')}
      >
        {/* the name alone: the face, with how they are on its corner, is in the column beside it. no tab shown: what the window is doing instead.
            a phone's is the sheet's head, under the grabber: a drag on it pulls the sheet down, and it moves nothing */}
        <header
          {...(mobile ? sheet.grip : { onPointerDown: (e: ReactPointerEvent) => press(e, 'move'), title: 'drag to move' })}
          className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP, mobile && 'shrink-0 cursor-auto gap-1 py-0.5 pr-1', mobile && name && 'pl-1')}
        >
          {name && dm ? (
            <>
              {/* a phone's sheet has no column of faces or +: back to the friends to pick from, in the same sheet */}
              {mobile && (
                <Tooltip content="back to friends">
                  <button
                    id="friend-chat-back"
                    type="button"
                    aria-label="back to friends"
                    onClick={pickDm}
                    className={cn(headerButton, 'text-textTertiary hover:text-textPrimary')}
                  >
                    <RiArrowLeftSLine aria-hidden size={24} />
                  </button>
                </Tooltip>
              )}
              {/* the name is a way to them: the popup, or their page (ProfileLink.tsx). a link, so a press on it is not a move.
                  a phone's carries their face with how they are on its corner, which the window's column does */}
              <span className="flex min-w-0 flex-1">
                <ProfileLink
                  id="friend-chat-profile"
                  person={dm}
                  live={dm.presence === 'streaming'}
                  className={cn('min-w-0 border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue', mobile && 'flex items-center gap-2.5 py-1 pr-1')}
                >
                  {mobile && (
                    <span id="friend-chat-face" className="relative block shrink-0">
                      <Face name={name} version={dm.avatar} className="h-8 w-8 text-sm" />
                      <PresenceSquare status={dm.presence} className={RING} />
                    </span>
                  )}
                  <Who name={name} verified={dm.verified} />
                </ProfileLink>
              </span>
              {/* the search box under the header, up and down. blue while it is up: a pressed state is colour (buttons.mdc) */}
              <Tooltip content={searching ? 'close the search' : 'search this chat'}>
                <button
                  id="friend-chat-search-open"
                  type="button"
                  aria-pressed={searching}
                  aria-label={searching ? 'close the search' : `search the chat with ${name}`}
                  onClick={() => (searching ? closeSearch() : setSearching(true))}
                  className={cn(headerButton, searching ? 'text-primaryBlue' : 'text-textTertiary hover:text-textPrimary')}
                >
                  <RiSearchLine aria-hidden size={headerIcon} />
                </button>
              </Tooltip>
            </>
          ) : (
            <span id="friend-chat-title" className="min-w-0 flex-1 truncate font-semibold">
              {mobile ? 'friends' : dms.length === 0 ? 'no chat' : 'new chat'}
            </span>
          )}
          <Tooltip content="hide. your chats stay; a friend's chat button in the sidebar brings them back">
            <button
              id="friend-chat-close"
              type="button"
              aria-label="hide the chat window"
              onClick={mobile ? sheet.leave : hideDms}
              className={cn(headerButton, 'text-textTertiary hover:text-textPrimary')}
            >
              <RiCloseLine aria-hidden size={headerIcon} />
            </button>
          </Tooltip>
        </header>
        {name ? (
          <>
            {/* the search box: the words, search, and the filter words under them, the room chat's (ChatSearch.tsx). escape takes it down */}
            {searching && (
              <form id="friend-chat-search-form" onSubmit={search.submit} className="shrink-0 border-b border-primaryStroke px-2.5 py-1.5">
                <div className="relative flex items-center gap-2">
                  <label htmlFor="friend-chat-search" className="sr-only">
                    search the chat with {name}
                  </label>
                  <input
                    ref={searchInput}
                    id="friend-chat-search"
                    {...comboProps(search, 'friend-chat-search-list')}
                    onKeyDown={(e) => {
                      // the list's keys first: escape takes the list down before it takes the box down
                      if (search.onKeyDown(e)) return;
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        closeSearch();
                      }
                    }}
                    placeholder="search"
                    className={INPUT}
                  />
                  <SearchSuggestions id="friend-chat-search-list" search={search} />
                  <button
                    id="friend-chat-search-go"
                    type="submit"
                    disabled={!search.query.trim()}
                    className="shrink-0 text-sm font-semibold text-primaryBlue disabled:opacity-40"
                  >
                    search
                  </button>
                </div>
                <SearchFilters id="friend-chat-search-filters" search={search} className="mt-1" />
              </form>
            )}
            {/* the lines, and over them the hits while there are any. `relative`: the pane is `absolute` in it (relative-parent.mdc) */}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* the lines in the shape picked: a log is a line each at an even gap; bubbles stand close within a minute and apart between minutes, blocks close within a run and apart between runs (ChatLine.tsx).
                  under the hits they keep their place unseen (`invisible`), so the scroll, the refs and the listeners hold and a line coming meanwhile lands at the bottom */}
              <div
                id="friend-chat-log"
                ref={log}
                onScroll={onScroll}
                role="log"
                aria-live="polite"
                data-style={shape}
                className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto p-2.5 text-sm', shape === 'log' ? 'gap-1' : 'gap-0.5', hits && 'invisible')}
              >
                {!thread?.loaded && lines.length === 0 && <p className="text-textTertiary">loading</p>}
                {thread?.loaded && lines.length === 0 && (
                  <p id="friend-chat-empty" className="text-textTertiary">
                    nothing yet. say hi to {name}: only the two of you see this.
                  </p>
                )}
                {lines.map((line, i) => {
                  const mine = line.from === me;
                  const prev = lines[i - 1];
                  const person = { name: line.from, verified: mine || (dm?.verified ?? false), avatar: mine ? myAvatar : (dm?.avatar ?? null) };
                  return (
                    <ChatLineShape
                      key={line.id}
                      shape={shape}
                      mine={mine}
                      at={line.at}
                      name={line.from}
                      who={
                        <ProfileLink person={person} className={cn('font-semibold underline-offset-2 hover:underline', mine && 'text-primaryBlue')}>
                          {line.from}
                        </ProfileLink>
                      }
                      // the head's face is the same way to them as the name (blocks, ChatLine.tsx), for the pointer: the name is the key's and the reader's
                      face={
                        <ProfileLink person={person} twin className="flex">
                          <Face name={line.from} version={person.avatar} className={mobile && shape === 'log' ? 'h-5 w-5 text-[10px]' : 'h-8 w-8 text-sm'} />
                        </ProfileLink>
                      }
                      // a phone's sheet has no column of faces: each line carries its writer's, whatever the shape
                      faced={mobile}
                      words={
                        line.text ? (
                          <span className="whitespace-pre-wrap">
                            <LinkedText text={line.text} />
                          </span>
                        ) : null
                      }
                      pictures={<ChatImages ids={line.images} />}
                      actions={<LineActions onReact={(emoji) => void reactDm(name, line, emoji)} reactions={line.reactions} me={me} onReply={() => setReply(line)} text={line.text} />}
                      reactions={<ReactionChips reactions={line.reactions ?? []} me={me} onReact={(emoji) => void reactDm(name, line, emoji)} />}
                      quote={
                        line.reply && (
                          <ReplyQuote
                            shape={shape}
                            quote={{
                              from: line.reply.from ?? '',
                              text: line.reply.text ?? '',
                              avatar: line.reply.avatar ?? null,
                              images: line.reply.images ?? 0,
                              gone: line.reply.gone
                            }}
                            onJump={() => void jumpTo(line.reply!.id)}
                          />
                        )
                      }
                      flash={flash === line.id}
                      attrs={{ 'data-id': line.id, 'data-mine': mine || undefined, 'data-reply-to': line.reply?.id }}
                      {...placeOf(line.at, prev?.at, prev?.from === line.from)}
                    />
                  );
                })}
              </div>
              {/* the hits, newest first, where the lines were, while the thread they are of is the one on screen (ChatSearch.tsx): the name (yours in blue) and the words, the picture mark for pictures. one clicked puts the lines back with it in view; close puts them back as they were, the focus in the box for the next words */}
              {hits && (
                <SearchResults
                  id="friend-chat-results"
                  label={hits.query}
                  count={hits.lines.length}
                  onClose={() => {
                    clearDmResults();
                    searchInput.current?.focus();
                  }}
                  className="absolute inset-0 text-sm"
                >
                  {hits.lines.map((line) => (
                    <SearchHit
                      key={line.id}
                      id={line.id}
                      at={line.at}
                      who={<span className={cn('font-semibold', line.from === me && 'text-primaryBlue')}>{line.from}</span>}
                      text={line.text}
                      images={line.images.length}
                      onClick={() => {
                        clearDmResults();
                        void openDmLine(name, line.id);
                      }}
                    />
                  ))}
                </SearchResults>
              )}
            </div>
            {/* a phone's foot: room for the home bar under the box, unless the keyboard is up and has taken that place */}
            <form
              onSubmit={(e) => void send(e)}
              className={cn('border-t border-primaryStroke p-2', mobile && 'shrink-0', mobile && !sheet.raised && 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]')}
            >
              {/* the line the next send answers, the room chat's bar over the box (ChatPanel.tsx `#chat-replying`): who, and the × (escape in the box too) */}
              {replyTo && (
                <div id="friend-chat-replying" data-reply-to={replyTo.id} className="mb-1.5 flex items-center gap-2 border-l-2 border-primaryBlue bg-backgroundTertiary py-0.5 pl-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-textSecondary">
                    replying to <span className="font-semibold text-textPrimary">{replyTo.from === me ? 'yourself' : replyTo.from}</span>
                    <span className="sr-only">: {quoteWords({ text: replyTo.text, images: replyTo.images.length })}</span>
                  </span>
                  <Tooltip content="cancel reply">
                    <button
                      type="button"
                      id="friend-chat-reply-cancel"
                      aria-label="cancel reply"
                      className={cn('flex h-6 w-6 shrink-0 items-center justify-center text-textTertiary hover:text-textPrimary', mobile && 'h-11 w-11')}
                      onClick={() => {
                        setReply(null);
                        input.current?.focus();
                      }}
                    >
                      <RiCloseLine aria-hidden size={14} />
                    </button>
                  </Tooltip>
                </div>
              )}
              {/* the pictures going with the next line, each with its × (the room chat's strip, ChatPanel.tsx) */}
              {pictures.length > 0 && (
                <div id="friend-chat-picture-preview" className="mb-2 flex flex-wrap gap-2">
                  {pictures.map((id) => (
                    <span key={id} className="relative">
                      <img src={pictureSrc(id)} alt="" className="h-16 w-16 object-cover" />
                      <Tooltip content="remove">
                        <button
                          type="button"
                          aria-label="remove picture"
                          className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center bg-black/70 text-white"
                          onClick={() => setPictures(pictures.filter((have) => have !== id))}
                        >
                          <RiCloseLine aria-hidden size={14} />
                        </button>
                      </Tooltip>
                    </span>
                  ))}
                </div>
              )}
              <div className="relative flex items-center gap-2">
                <label htmlFor="friend-chat-text" className="sr-only">
                  message {name}
                </label>
                <Tooltip content={pictures.length >= MAX_CHAT_IMAGES ? `${MAX_CHAT_IMAGES} pictures at most` : 'add a picture'}>
                  <button
                    type="button"
                    id="friend-chat-picture"
                    aria-label="picture"
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center text-textTertiary hover:text-textPrimary disabled:opacity-40',
                      mobile && 'h-11 w-11'
                    )}
                    disabled={uploading || pictures.length >= MAX_CHAT_IMAGES}
                    onClick={() => fileRef.current?.click()}
                  >
                    <RiImageAddLine size={18} aria-hidden />
                  </button>
                </Tooltip>
                <input
                  ref={fileRef}
                  id="friend-chat-picture-file"
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => void pickPictures(e.target.files)}
                />
                <input
                  ref={input}
                  id="friend-chat-text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      // a reply is let go of first; the window goes on the next
                      if (replyTo) setReply(null);
                      else hideDms();
                    }
                  }}
                  placeholder="message"
                  aria-label={`message ${name}`}
                  maxLength={MAX_CHARS + 50}
                  autoComplete="off"
                  // a phone's box is 16px text: a smaller one zooms the page in when it takes focus (ios; globals.css keeps
                  // it at 16px under a smaller text size too). it takes the row's room and gives it back, so send never leaves the row.
                  // a desktop's is text-sm like the lines, pinned at the 30px box
                  className={cn(INPUT, mobile ? 'h-11 min-w-0 flex-1 py-0' : 'h-[1.875rem] text-sm')}
                />
                <Button
                  id="friend-chat-send"
                  type="submit"
                  // a finger's press keeps the box's focus, so a phone's keyboard stays up through the send
                  onPointerDown={keepFocus}
                  variant="primary"
                  className={cn(INPUT_BUTTON, mobile ? 'h-11 min-w-[44px] shrink-0 py-0' : 'h-[1.875rem] text-sm')}
                  disabled={(!draft.trim() && pictures.length === 0) || left < 0 || sending || uploading}
                >
                  send
                </Button>
              </div>
              {/* the api's words when a line was not kept (not friends, too long, too fast) or a picture would not go up, and the countdown once it matters.
                  the row stays mounted so a screen reader hears a notice as it lands, but takes no room while there's nothing in it */}
              <div className={cn('flex items-center justify-between gap-2 text-xs', (notice || left < 50) && 'mt-1')}>
                <span id="friend-chat-notice" className={cn('text-decrease', notice && 'min-h-[1em]')} aria-live="polite">
                  {notice}
                </span>
                {left < 50 && (
                  <span id="friend-chat-left" className={cn('shrink-0 tabular-nums text-textTertiary', left < 0 && 'font-semibold text-decrease')}>
                    {left}
                  </span>
                )}
              </div>
            </form>
          </>
        ) : (
          <Picker dms={people} list={mobile} />
        )}
      </div>
      {side === 'right' && !mobile && rail}
    </>
  );

  if (mobile) {
    return (
      <MobileSheet sheet={sheet} label={name ? `chat with ${name}` : 'chat'} with={name}>
        {content}
      </MobileSheet>
    );
  }

  return (
    <section
      ref={ref}
      id="friend-chat"
      role="dialog"
      aria-label={name ? `chat with ${name}` : 'chat'}
      data-with={name}
      style={style}
      className={panelClassName(
        cn(
          'group fixed z-50 flex text-base',
          // until moved or resized: 400 by 440, just inside the page, clear of the open sidebar (300px, UserPanel.tsx, and 1.5rem)
          !box && cn('bottom-6 h-[min(440px,70vh)] w-[min(400px,calc(100vw-3rem))]', side === 'right' ? 'right-[324px]' : 'left-[324px]')
        )
      )}
    >
      {content}
      {/* the corners show while the pointer is over the window: pull one, and the opposite corner stays put */}
      {CORNERS.map((c) => (
        <div
          key={c.id}
          id={`friend-chat-resize-${c.id}`}
          aria-hidden
          onPointerDown={(e) => press(e, 'resize', c.sx, c.sy)}
          className={cn('absolute z-10 h-4 w-4 border-primaryBlue opacity-0 transition-opacity duration-150 group-hover:opacity-100', GRIP, c.className)}
        />
      ))}
    </section>
  );
}
