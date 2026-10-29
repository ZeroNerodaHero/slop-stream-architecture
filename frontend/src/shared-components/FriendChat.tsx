import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  type Dm,
  dmActiveAtom,
  dmNoticeAtom,
  dmOpenAtom,
  dmThreadsAtom,
  dmsAtom,
  hideDms,
  loadOlderDm,
  markRead,
  openDm,
  pickDm,
  removeDm,
  selectDm,
  sendDm
} from '@/infra/atoms/dm-atoms';
import { followingAtom } from '@/infra/atoms/follow-atoms';
import { type Presence, PRESENCE_SQUARE } from '@/infra/atoms/presence-atoms';
import { type PanelSide, panelSideAtom } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { Who, Word } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
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

/** Where the window was dragged, and how big. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the window was left and its size, for the rest of the visit. `null` is the default,
 * the bottom corner beside the sidebar at 400 by 440, until the first move or resize. Hidden
 * and shown again, the window is where it was.
 */
let parked: Box | null = null;

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

/** The same box, back on screen: the browser window shrank, or the chat was left somewhere while hidden. */
function fitted(box: Box): Box {
  const r = room();
  const w = Math.min(box.w, r.w);
  const h = Math.min(box.h, r.h);
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

/** The presence square in the corner of a face, the sidebar's colours (docs/status.md), ringed in the window's background. */
function PresenceSquare({ presence }: { presence: Presence }) {
  return (
    <span
      aria-hidden
      data-presence={presence}
      className={cn('absolute -bottom-1 -right-1 h-3.5 w-3.5 border-2 border-backgroundSecondary', PRESENCE_SQUARE[presence])}
    />
  );
}

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
 * the person's card (PersonCard.tsx, the sidebar's) beside the column.
 */
function Tab({ dm, selected, reachable, side, onKey }: TabProps) {
  const peek = usePeek(PEEK_MS);
  return (
    <span
      className="group/tab relative shrink-0"
      onPointerEnter={(e) => peek.show(e.currentTarget, e.currentTarget.closest('#friend-chat-rail'))}
      onPointerLeave={(e) => peek.leave(e.currentTarget)}
      onFocus={(e) => peek.show(e.currentTarget, e.currentTarget.closest('#friend-chat-rail'))}
      onBlur={peek.blur}
    >
      <button
        id={tabId(dm.name)}
        role="tab"
        type="button"
        aria-selected={selected}
        aria-controls="friend-chat-thread"
        tabIndex={reachable ? 0 : -1}
        aria-label={`chat with ${dm.name}${dm.unread > 0 ? `, ${dm.unread} new` : ''}`}
        data-unread={dm.unread || undefined}
        onClick={() => {
          selectDm(dm.name);
          // a click means "talk to them": straight into the box (the same node for every tab, so it is there already)
          document.getElementById('friend-chat-text')?.focus();
        }}
        onKeyDown={onKey}
        className={cn(SQUARE, selected ? SQUARE_ON : SQUARE_OFF)}
      >
        <Face name={dm.name} version={dm.avatar} />
        <PresenceSquare presence={dm.presence} />
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
      <button
        id={`friend-chat-remove-${dm.name}`}
        type="button"
        aria-label={`close the chat with ${dm.name}`}
        title="close this chat (it is back when a line comes)"
        onClick={() => removeDm(dm.name)}
        className={cn(
          'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary',
          'opacity-0 transition-opacity duration-150 hover:border-primaryBlue hover:text-textPrimary focus-visible:opacity-100 focus-visible:outline-none group-hover/tab:opacity-100'
        )}
      >
        <RiCloseLine aria-hidden size={10} />
      </button>
      {peek.at && <PersonCard id={`friend-chat-peek-${dm.name}`} person={dm} at={peek.at} side={side} />}
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
      <button
        id="friend-chat-new"
        type="button"
        aria-pressed={active === null}
        aria-label="new chat"
        title="new chat: pick a friend"
        onClick={pickDm}
        className={cn(
          SQUARE,
          'flex h-[42px] w-[42px] items-center justify-center',
          active === null ? cn(SQUARE_ON, 'text-primaryBlue') : cn(SQUARE_OFF, 'text-textSecondary')
        )}
      >
        <RiAddLine aria-hidden size={20} />
      </button>
    </div>
  );
}

/**
 * The friends to pick from, where a thread would be: everyone who follows you back, a face
 * with its presence square and the name under it, the ones with a chat on the column in the
 * blue stroke. A pick opens their chat, or shows the one they have. Friends alone: a line can
 * only go to somebody who chose you back.
 */
function Picker({ dms }: { dms: Dm[] }) {
  const following = useAtomValue(followingAtom);
  const friends = following?.filter((f) => f.mutual) ?? [];
  const open = new Set(dms.map((d) => d.name));
  return (
    <div id="friend-chat-pick" className="min-h-0 flex-1 overflow-y-auto p-3">
      {following === undefined ? (
        <p className="text-sm text-textTertiary">loading</p>
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
                    <PresenceSquare presence={f.presence} />
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

/** The clock of a line, in its title. */
function stamp(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * Direct chats with friends (docs/dms.md), opened from the sidebar: one window, a tab per
 * friend down its side, dragged by its header, resized from a corner. The lines are the
 * api's: a page on opening a thread, older pages as you scroll up, new ones as they come on
 * the events socket, from either side and from your other devices. A thread keeps its
 * half-typed draft while another tab is shown. The × on the header hides the window and keeps
 * everything; the sidebar's chat button brings it back. With no tab shown, the friends to
 * pick from are where the thread would be, under `no chat` when there are no tabs at all.
 */
export function FriendChat() {
  const me = useAtomValue(meAtom);
  const dms = useAtomValue(dmsAtom);
  const active = useAtomValue(dmActiveAtom);
  const open = useAtomValue(dmOpenAtom);
  const threads = useAtomValue(dmThreadsAtom);
  const notice = useAtomValue(dmNoticeAtom);
  const side = useAtomValue(panelSideAtom);
  const following = useAtomValue(followingAtom);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [box, setBox] = useState<Box | null>(parked);
  const ref = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  /** Ends the drag in progress: its window listeners go. `null` between drags. */
  const stop = useRef<(() => void) | null>(null);
  /** The view sits on the newest line. Someone who scrolled up to read is left there. */
  const stuck = useRef(true);
  /** The log's height before the last paint, so prepending older lines can put the same pixels back. */
  const hold = useRef(0);
  /** Older lines are on their way: the next paint keeps the view where it was instead of jumping to the bottom. */
  const prepending = useRef(false);
  /** The thread the log last showed: a change of thread starts at the bottom. */
  const shownThread = useRef<string | undefined>(undefined);
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

  useEffect(() => {
    parked = box;
  }, [box]);

  // A moved or resized window is pulled back on screen when the browser window shrinks, and on showing, in case it did while this was hidden.
  useEffect(() => {
    if (!open) return;
    const fit = () =>
      setBox((b) => {
        if (!b) return b;
        const next = fitted(b);
        return next.x === b.x && next.y === b.y && next.w === b.w && next.h === b.h ? b : next;
      });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  // a tab shown: the box takes focus. not while the arrow keys walk the tabs: focus stays on the face they landed on
  useEffect(() => {
    if (!name || !open) return;
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
    if (prepending.current) {
      el.scrollTop += el.scrollHeight - hold.current;
      prepending.current = false;
    } else if (stuck.current || shownThread.current !== name) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
    }
    hold.current = el.scrollHeight;
    shownThread.current = name;
  }, [lines.length, name, open]);

  // the window going while a drag is on: its listeners go with it
  useEffect(() => () => stop.current?.(), []);

  if (!open) return null;

  function setDraft(text: string) {
    if (name) setDrafts((prev) => ({ ...prev, [name]: text }));
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!name || !draft.trim() || sending) return;
    setSending(true);
    const sent = await sendDm(name, draft);
    setSending(false);
    if (sent) setDraft('');
    input.current?.focus();
  }

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
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
          // until moved or resized: 400 by 440, just inside the page, clear of the open sidebar
          !box && cn('bottom-6 h-[min(440px,70vh)] w-[min(400px,calc(100vw-3rem))]', side === 'right' ? 'right-96' : 'left-96')
        )
      )}
    >
      {side === 'left' && rail}
      <div id="friend-chat-thread" role={name ? 'tabpanel' : undefined} aria-labelledby={name ? tabId(name) : undefined} className="flex min-w-0 flex-1 flex-col">
        {/* the name alone: the face is in the column beside it. no tab shown: what the window is doing instead */}
        <header
          onPointerDown={(e) => press(e, 'move')}
          title="drag to move"
          className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2', GRIP)}
        >
          {name && dm ? (
            <>
              <Who name={name} verified={dm.verified} className="min-w-0 flex-1" />
              <Word presence={dm.presence} className="text-xs" />
            </>
          ) : (
            <span id="friend-chat-title" className="min-w-0 flex-1 truncate font-semibold">
              {dms.length === 0 ? 'no chat' : 'new chat'}
            </span>
          )}
          <button
            id="friend-chat-close"
            type="button"
            aria-label="hide the chat window"
            title="hide. your chats stay; the sidebar's chat button brings them back"
            onClick={hideDms}
            className="shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none"
          >
            <RiCloseLine aria-hidden size={16} />
          </button>
        </header>
        {name ? (
          <>
            <div id="friend-chat-log" ref={log} onScroll={onScroll} role="log" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
              {!thread?.loaded && lines.length === 0 && <p className="text-sm text-textTertiary">loading</p>}
              {thread?.loaded && lines.length === 0 && (
                <p id="friend-chat-empty" className="text-sm text-textTertiary">
                  nothing yet. say hi to {name}: only the two of you see this.
                </p>
              )}
              {lines.map((line) => {
                const mine = line.from === me;
                return (
                  <p
                    key={line.id}
                    data-id={line.id}
                    data-mine={mine || undefined}
                    title={stamp(line.at)}
                    className={cn('text-sm leading-snug', mine ? 'text-right' : 'text-left')}
                  >
                    <span className="font-semibold">{mine ? 'you' : line.from}</span>
                    <span className="mt-0.5 block whitespace-pre-wrap text-textSecondary [overflow-wrap:anywhere]">{line.text}</span>
                  </p>
                );
              })}
            </div>
            <form onSubmit={(e) => void send(e)} className="border-t border-primaryStroke p-2">
              <div className="flex items-center gap-2">
                <label htmlFor="friend-chat-text" className="sr-only">
                  message {name}
                </label>
                <input
                  ref={input}
                  id="friend-chat-text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      hideDms();
                    }
                  }}
                  placeholder={`message ${name}`}
                  maxLength={MAX_CHARS + 50}
                  autoComplete="off"
                  className={cn(INPUT, 'py-1.5 text-sm')}
                />
                <Button id="friend-chat-send" type="submit" variant="primary" flat className="px-3 py-1.5 text-sm" disabled={!draft.trim() || left < 0 || sending}>
                  send
                </Button>
              </div>
              {/* the api's words when a line was not kept (not friends, too long, too fast), and the countdown once it matters */}
              <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                <span id="friend-chat-notice" className="min-h-[1em] text-decrease" aria-live="polite">
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
          <Picker dms={dms} />
        )}
      </div>
      {side === 'right' && rail}
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
