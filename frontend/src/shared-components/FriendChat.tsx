import { RiAddLine, RiArrowLeftSLine, RiArrowUpLine, RiCloseLine, RiLoader4Line, RiPhoneFill, RiPhoneLine, RiSearchLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type CSSProperties,
  type DOMAttributes,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';

import { type DmLine } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { idsOf, isPictureRefusal, MAX_CHAT_IMAGES } from '@/infra/chat-attach';
import { type ChatBox as Box, keepDmBox, keptDmBox } from '@/infra/atoms/chat-layout-atoms';
import {
  clearDmResults,
  type Dm,
  dmActiveAtom,
  dmAttach,
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
import { dmCallAtom, dmCallBusyAtom, endDmCall, startDmCall } from '@/infra/atoms/dm-call-atoms';
import { followingAtom, friendsOpenAtom } from '@/infra/atoms/follow-atoms';
import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { type ChatStyle, chatStyleAtom, type PanelSide, panelSideAtom } from '@/infra/atoms/settings-atoms';
import { keepFocus, stuckAfterScroll, useBottomPin, useKeyboard } from '@/infra/keyboard';
import { briefPhase } from '@/infra/dm-call';
import { useIsMobile } from '@/infra/mobile';
import { usePrefetchOnPointerDown } from '@/infra/prefetch';
import { plainEmotes } from '@/infra/emotes';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { ATTACH_ACCEPT, dragFiles, dropFiles, pasteFiles, PendingThumb, PendingVideo, splitFiles } from '@/shared-components/ChatAttach';
import { ChatLineShape, clock, LineActions, placeOf, quoteWords, ReplyQuote, stamp } from '@/shared-components/ChatLine';
import { ChatEmbeds } from '@/shared-components/ChatEmbeds';
import { ChatAudioPlayer } from '@/shared-components/ChatAudioPlayer';
import { ChatVideoPlayer } from '@/shared-components/ChatVideoPlayer';
import { AttachMenu, PendingVoiceChip, VoiceBar } from '@/shared-components/ChatVoice';
import { ChatImages } from '@/shared-components/ChatPanel';
import { SearchField, SearchFilters, SearchHit, SearchResults, useChatSearch } from '@/shared-components/ChatSearch';
import { Face } from '@/shared-components/Face';
import { useEmoteComplete } from '@/shared-components/EmoteComplete';
import { useMentionComplete } from '@/shared-components/MentionComplete';
import { LinkedText } from '@/shared-components/LinkedText';
import { SHEET_FLICK, SHEET_MS, SHEET_SNAP, useSheetBack } from '@/shared-components/MobileSheet';
import { panelClassName } from '@/shared-components/Panel';
import { PersonCard } from '@/shared-components/PersonCard';
import { usePeek } from '@/shared-components/peek';
import { ReactionChips } from '@/shared-components/Reactions';
import { Who } from '@/shared-components/PersonRow';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { ProfileLink, profilePath, useShowProfile } from '@/shared-components/ProfileLink';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { IN_PILL, INPUT, INPUT_BUTTON, PILL } from '@/shared-components/input';
import { Tooltip } from '@/shared-components/Tooltip';
import { useVoiceRecorder } from '@/shared-components/useVoiceRecorder';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { cn } from '@/utils/cn';

const GRIP = 'touch-none select-none [-webkit-touch-callout:none]';
const MIN_W = 300;
const MIN_H = 260;
const PEEK_MS = 100;
const STUCK_PX = 40;
const MAX_CHARS = 500;

const SQUARE = 'relative block shrink-0 border transition-[border-color] duration-150 focus-visible:outline-none';
const SQUARE_OFF = 'border-transparent hover:border-primaryStroke focus-visible:border-primaryBlue';
const SQUARE_ON = 'border-primaryBlue';
const HEADER_BUTTON =
  'shrink-0 rounded-control border border-transparent p-0.5 transition-colors duration-150 bubble:p-px hover:border-primaryStroke focus-visible:border-primaryBlue focus-visible:outline-none';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const room = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });

function moved(rect: DOMRect, dx: number, dy: number): Box {
  const r = room();
  return {
    x: clamp(rect.left + dx, 0, Math.max(0, r.w - rect.width)),
    y: clamp(rect.top + dy, 0, Math.max(0, r.h - rect.height)),
    w: rect.width,
    h: rect.height
  };
}

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

function fitted(box: Box): Box {
  const r = room();
  const w = Math.min(Math.max(box.w, MIN_W), r.w);
  const h = Math.min(Math.max(box.h, MIN_H), r.h);
  return { w, h, x: clamp(box.x, 0, Math.max(0, r.w - w)), y: clamp(box.y, 0, Math.max(0, r.h - h)) };
}

const CORNERS = [
  { id: 'nw', sx: -1, sy: -1, className: '-left-px -top-px cursor-nwse-resize border-l-2 border-t-2' },
  { id: 'ne', sx: 1, sy: -1, className: '-right-px -top-px cursor-nesw-resize border-r-2 border-t-2' },
  { id: 'sw', sx: -1, sy: 1, className: '-bottom-px -left-px cursor-nesw-resize border-b-2 border-l-2' },
  { id: 'se', sx: 1, sy: 1, className: '-bottom-px -right-px cursor-nwse-resize border-b-2 border-r-2' }
] as const;

const tabId = (name: string) => `friend-chat-tab-${name}`;

const RING = 'border-backgroundSecondary';

interface TabProps {
  dm: Dm;
  selected: boolean;
  reachable: boolean;
  side: PanelSide;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

function Tab({ dm, selected, reachable, side, onKey }: TabProps) {
  const peek = usePeek(PEEK_MS);
  const profile = useShowProfile();
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
          if (selected) {
            profile.show(dm, dm.presence === 'streaming');
            return;
          }
          selectDm(dm.name);
          document.getElementById('friend-chat-text')?.focus();
        }}
        onKeyDown={onKey}
        className={cn(SQUARE, 'rounded-control', selected ? SQUARE_ON : SQUARE_OFF)}
      >
        <span className="relative flex">
          <Face name={dm.name} version={dm.avatar} />
          <PresenceSquare status={dm.presence} className={RING} />
        </span>
        {dm.unread > 0 && (
          <span
            id={`friend-chat-unread-${dm.name}`}
            aria-hidden
            className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-control border border-backgroundSecondary bg-primaryBlue px-0.5 text-[10px] font-semibold leading-none text-background"
          >
            {dm.unread > 99 ? '99+' : dm.unread}
          </span>
        )}
      </button>
      <Tooltip content="close this chat (it is back when a line comes)">
        <button
          id={`friend-chat-remove-${dm.name}`}
          type="button"
          aria-label={`close the chat with ${dm.name}`}
          onClick={() => removeDm(dm.name)}
          className={cn(
            'absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary',
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
            'flex h-[calc(2.5rem+2px)] w-[calc(2.5rem+2px)] rounded-control items-center justify-center',
            active === null ? cn(SQUARE_ON, 'text-primaryBlue') : cn(SQUARE_OFF, 'text-textSecondary')
          )}
        >
          <RiAddLine aria-hidden size={20} />
        </button>
      </Tooltip>
    </div>
  );
}

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
              const said = last && (plainEmotes(last.text) || (last.images.length > 0 ? 'a picture' : last.video ? 'a video' : last.audio ? 'a voice message' : ''));
              return (
                <li key={f.name} className="border-b border-primaryStroke">
                  <button
                    id={`friend-chat-pick-${f.name}`}
                    type="button"
                    aria-label={`chat with ${f.name}${tab?.unread ? `, ${tab.unread} new` : ''}`}
                    onClick={() => openDm({ id: '', name: f.name, avatar: f.avatar, verified: f.verified, bio: f.bio, presence: f.presence })}
                    className="flex min-h-14 w-full items-center gap-3 rounded-card border border-transparent px-3 py-2 text-left focus-visible:border-primaryBlue focus-visible:outline-none active:bg-backgroundTertiary"
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
                      <span aria-hidden className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control bg-primaryBlue px-1 text-xs font-semibold leading-none text-background">
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
                  className={cn(SQUARE, 'flex w-full flex-col items-center gap-1.5 rounded-card p-2', open.has(f.name) ? SQUARE_ON : SQUARE_OFF)}
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

const SHEET = 0.8;
const SHEET_GAP = 24;
const SHEET_MIN = 200;
const SHEET_SLIDE = 'duration-200 ease-out motion-reduce:transition-none';
const SHEET_DIM = 0.6;

type SheetGrip = Pick<DOMAttributes<HTMLElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'>;

function useSheet(active: boolean, onDismiss: () => void) {
  const kb = useKeyboard();
  const view = active && kb.height ? kb : null;
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
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

  useSheetBack(() => setLeaving(true), active);

  useEffect(() => {
    if (!active) return;
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

function MobileSheet({ sheet, label, with: name, children }: { sheet: Sheet; label: string; with?: string; children: ReactNode }) {
  const { view, drag, up, grip } = sheet;
  const full = window.innerHeight * SHEET;
  let height = full;
  let bottom: number | undefined;
  if (view) {
    const foot = view.top + view.height;
    const top = Math.min(window.innerHeight - full, Math.max(view.top + SHEET_GAP, foot - SHEET_MIN));
    height = Math.max(0, foot - top);
    bottom = Math.max(0, window.innerHeight - foot);
  }
  const shown = up ? 1 - Math.min(1, (drag ?? 0) / Math.max(1, height)) : 0;
  return createPortal(
    <div data-sheet-open="" className="fixed inset-0 z-[55] overflow-hidden">
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
          'absolute inset-x-0 bottom-0 flex h-[80dvh] flex-col overflow-x-hidden rounded-t-panel border-t border-primaryStroke bg-backgroundSecondary pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-base text-textPrimary',
          drag === null && cn('transition-transform', SHEET_SLIDE)
        )}
        style={{ ...(view ? { bottom, height } : {}), transform: up ? `translateY(${drag ?? 0}px)` : 'translateY(100%)' }}
      >
        <div aria-hidden {...grip} className={cn('flex shrink-0 justify-center pb-1 pt-2', GRIP)}>
          <span className="h-1 w-10 rounded-control bg-primaryStroke" />
        </div>
        {children}
      </section>
    </div>,
    document.body
  );
}

interface DmRowProps {
  line: DmLine;
  peer: string;
  me: string | null | undefined;
  shape: ChatStyle;
  mobile: boolean;
  myAvatar: number | null;
  dmVerified: boolean;
  dmAvatar: number | null;
  mine: boolean;
  first: boolean;
  bucket: boolean;
  flashed: boolean;
  onReply: (line: DmLine) => void;
  onJump: (id: number) => void;
}

const DmRow = memo(function DmRow({ line, peer, me, shape, mobile, myAvatar, dmVerified, dmAvatar, mine, first, bucket, flashed, onReply, onJump }: DmRowProps) {
  const person = { name: line.from, verified: mine || dmVerified, avatar: mine ? myAvatar : dmAvatar };
  return (
    <ChatLineShape
      shape={shape}
      mine={mine}
      at={line.at}
      name={line.from}
      who={
        <ProfileLink person={person} className={cn('font-semibold underline-offset-2 hover:underline', mine && 'text-primaryBlue')}>
          {line.from}
        </ProfileLink>
      }
      face={
        <ProfileLink person={person} twin className="flex">
          <Face name={line.from} version={person.avatar} className={mobile && shape === 'log' ? 'h-5 w-5 text-[10px]' : 'h-8 w-8 text-sm'} />
        </ProfileLink>
      }
      faced={mobile}
      words={
        line.text ? (
          <span className="whitespace-pre-wrap">
            <LinkedText text={line.text} mentions={line.mentions} />
          </span>
        ) : null
      }
      pictures={
        <>
          <ChatImages ids={line.images} />
          {line.video && <ChatVideoPlayer video={line.video} />}
          {line.audio && <ChatAudioPlayer audio={line.audio} />}
          <ChatEmbeds text={line.text} />
        </>
      }
      actions={<LineActions onReact={(emoji) => void reactDm(peer, line, emoji)} reactions={line.reactions} me={me} onReply={() => onReply(line)} text={line.text} />}
      reactions={<ReactionChips reactions={line.reactions ?? []} me={me} onReact={(emoji) => void reactDm(peer, line, emoji)} />}
      quote={
        line.reply && (
          <ReplyQuote
            shape={shape}
            quote={{
              from: line.reply.from ?? '',
              text: line.reply.text ?? '',
              avatar: line.reply.avatar ?? null,
              images: line.reply.images ?? 0,
              video: line.reply.video,
              audio: line.reply.audio,
              gone: line.reply.gone
            }}
            onJump={() => void onJump(line.reply!.id)}
          />
        )
      }
      flash={flashed}
      attrs={{ 'data-id': line.id, 'data-mine': mine || undefined, 'data-reply-to': line.reply?.id }}
      first={first}
      bucket={bucket}
    />
  );
});

function CallLine({ line }: { line: DmLine }) {
  return (
    <p data-id={line.id} data-call={line.call?.outcome} className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-textTertiary">
      <RiPhoneLine aria-hidden size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{line.text}</span>
      <Tooltip content={stamp(line.at)}>
        <time dateTime={new Date(line.at).toISOString()} className="shrink-0 tabular-nums">
          {clock(line.at)}
        </time>
      </Tooltip>
    </p>
  );
}

export function FriendChat() {
  const me = useAtomValue(meAtom);
  const dmCall = useAtomValue(dmCallAtom);
  const callBusy = useAtomValue(dmCallBusyAtom);
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
  const mobile = useIsMobile();
  const sheet = useSheet(mobile && open, hideDms);
  useSheetBack(pickDm, mobile && open && active !== null);
  const { pathname } = useLocation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [replies, setReplies] = useState<Record<string, DmLine | null>>({});
  const [flash, setFlash] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(() => {
    const kept = keptDmBox();
    return kept && fitted(kept);
  });
  const ref = useRef<HTMLElement | null>(null);
  useStackedWindow(ref, 'dm', open && !mobile);
  const input = useRef<HTMLInputElement | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const stuck = useRef(true);
  const hold = useRef(0);
  const prepending = useRef(false);
  const sentJump = useRef<string | null>(null);
  const shownThread = useRef<string | undefined>(undefined);
  const oldestShown = useRef<number | undefined>(undefined);
  const jumped = useRef(0);
  const people = dms.map((d) => {
    const now = following?.find((f) => f.name === d.name);
    return now ? { ...d, avatar: now.avatar, verified: now.verified, bio: now.bio, presence: now.presence } : d;
  });
  const dm = active === null ? null : (people.find((d) => d.name === active) ?? null);
  const name = dm?.name;
  const thread = name ? threads[name] : undefined;
  const lines = thread?.lines ?? [];
  const draft = (name && drafts[name]) || '';
  const attach = dmAttach(name ?? '');
  const pictures = useAtomValue(attach.picturesAtom);
  const video = useAtomValue(attach.videoAtom);
  const voice = useAtomValue(attach.voiceAtom);
  const recorder = useVoiceRecorder(showDmNotice);
  const recording = recorder.phase !== 'idle';
  const sending = sendingFor !== null && sendingFor === name;
  const replyTo = (name && replies[name]) || null;
  const latest = useRef({ drafts, replies });
  useEffect(() => {
    latest.current = { drafts, replies };
  }, [drafts, replies]);
  const emotes = useEmoteComplete({ value: draft, onChange: (next) => setDraft(next), input, id: 'friend-chat-emotes' });
  const mentions = useMentionComplete({ value: draft, onChange: (next) => setDraft(next), input, id: 'friend-chat-mentions', emotes, ctx: null, first: dm });
  const hits = results?.name === name ? results : null;
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

  useEffect(() => {
    if (mobile && open) store.set(friendsOpenAtom, false);
  }, [mobile, open]);
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    if (mobile && open) hideDms();
  }, [pathname, mobile, open]);

  useEffect(() => {
    if (!name || !open || mobile) return;
    const focused = document.activeElement;
    if (focused instanceof Element && focused.closest('#friend-chat-tabs')) return;
    input.current?.focus();
  }, [name, open]);

  useEffect(() => {
    if (!name || !open) return;
    const onShow = () => {
      if (document.visibilityState === 'visible') markRead(name);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [name, open]);

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const oldest = lines[0]?.id;
    const older = shownThread.current === name && oldestShown.current !== undefined && oldest !== undefined && oldest < oldestShown.current;
    if (sentJump.current !== name) sentJump.current = null;
    if (sentJump.current && shownThread.current === name) {
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

  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !jump || jump.name !== name || jump.n === jumped.current) return;
    const node = el.querySelector(`[data-id="${jump.id}"]`);
    if (!(node instanceof HTMLElement)) return;
    jumped.current = jump.n;
    el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - (el.clientHeight - node.offsetHeight) / 2;
    stuck.current = false;
  }, [jump, name]);

  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  useBottomPin(log, stuck, `${name}:${open}`);

  useEffect(() => () => stop.current?.(), []);

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

  const setReply = useCallback(
    (line: DmLine | null) => {
      if (name) setReplies((prev) => ({ ...prev, [name]: line }));
    },
    [name]
  );

  const jumpTo = useCallback(
    async (id: number) => {
      if (!name) return;
      if (!(await openDmLine(name, id))) {
        showDmNotice('that line is not here any more');
        return;
      }
      setFlash(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 1600);
    },
    [name]
  );

  function closeSearch() {
    setSearching(false);
    search.setQuery('');
    clearDmResults();
    input.current?.focus();
  }

  function pickFiles(list: FileList | File[] | null) {
    const { pictures: still, videos } = splitFiles(list ? [...list] : []);
    if (fileRef.current) fileRef.current.value = '';
    if (!name) return;
    const into = dmAttach(name);
    const [first] = videos;
    if (first) into.addVideo(first, videos.length > 1);
    into.addPictures(still);
    if (still.length > 0 || first) input.current?.focus();
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (!name || sendingFor !== null) return;
    const forThread = name;
    const into = dmAttach(forThread);
    if (!draft.trim() && !into.any()) return;
    setSendingFor(forThread);
    await into.settle();
    const error = into.errorOf();
    if (error) {
      setSendingFor(null);
      showDmNotice(error);
      input.current?.focus();
      return;
    }
    const text = latest.current.drafts[forThread] ?? '';
    const reply = latest.current.replies[forThread] ?? null;
    const taken = { pictures: into.pictures(), video: into.video(), voice: into.voice() };
    sentJump.current = forThread;
    const failed = await sendDm(forThread, text, idsOf(taken.pictures), reply?.id ?? null, taken.video?.video?.id ?? null, taken.voice?.audio?.id ?? null);
    setSendingFor(null);
    if (failed) {
      sentJump.current = null;
      if (isPictureRefusal(failed)) into.markPictures(failed);
    } else {
      setDrafts((prev) => (prev[forThread] === text ? { ...prev, [forThread]: '' } : prev));
      into.drop(taken);
      setReplies((prev) => ({ ...prev, [forThread]: null }));
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
  const headerButton = mobile ? cn(HEADER_BUTTON, 'flex h-11 w-11 items-center justify-center p-0') : HEADER_BUTTON;
  const headerIcon = mobile ? 20 : 16;
  const inCall = !!name && dmCall?.peer === name && !briefPhase(dmCall.phase);
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
        <header
          {...(mobile ? sheet.grip : { onPointerDown: (e: ReactPointerEvent) => press(e, 'move'), title: 'drag to move' })}
          className={cn('flex cursor-move items-center gap-2 border-b border-primaryStroke px-3 py-2 bubble:border-transparent', GRIP, mobile && 'shrink-0 cursor-auto gap-1 py-0.5 pr-1', mobile && name && 'pl-1')}
        >
          {name && dm ? (
            <>
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
              <span className="flex min-w-0 flex-1">
                <ProfileLink
                  id="friend-chat-profile"
                  person={dm}
                  live={dm.presence === 'streaming'}
                  className={cn('min-w-0 rounded-control border border-transparent outline-none hover:border-primaryStroke focus-visible:border-primaryBlue', mobile && 'flex items-center gap-2.5 py-1 pr-1')}
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
              <Tooltip content={inCall ? 'hang up' : 'call'} hideOnPress>
                <button
                  id="friend-chat-call"
                  type="button"
                  aria-label={inCall ? 'hang up' : 'call'}
                  aria-pressed={inCall}
                  disabled={callBusy && !inCall}
                  data-call={inCall ? dmCall?.phase : undefined}
                  onClick={() => (inCall ? endDmCall() : void startDmCall(name))}
                  className={cn(headerButton, 'disabled:opacity-50', inCall ? 'text-decrease' : 'text-textTertiary hover:text-textPrimary')}
                >
                  {inCall ? <RiPhoneFill aria-hidden size={headerIcon} className="rotate-[135deg]" /> : <RiPhoneLine aria-hidden size={headerIcon} />}
                </button>
              </Tooltip>
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
            {searching && (
              <form id="friend-chat-search-form" onSubmit={search.submit} className="shrink-0 border-b border-primaryStroke px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <SearchField
                    id="friend-chat-search"
                    search={search}
                    input={searchInput}
                    label={`search the chat with ${name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        closeSearch();
                      }
                    }}
                    className="min-w-0 flex-1"
                  />
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
            <div className="relative flex min-h-0 flex-1 flex-col">
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
                  const place = placeOf(line.at, prev?.at, prev?.from === line.from && !prev?.call);
                  if (line.call) return <CallLine key={line.id} line={line} />;
                  return (
                    <DmRow
                      key={line.id}
                      line={line}
                      peer={name}
                      me={me}
                      shape={shape}
                      mobile={mobile}
                      myAvatar={myAvatar}
                      dmVerified={dm?.verified ?? false}
                      dmAvatar={dm?.avatar ?? null}
                      mine={mine}
                      first={place.first}
                      bucket={place.bucket}
                      flashed={flash === line.id}
                      onReply={setReply}
                      onJump={jumpTo}
                    />
                  );
                })}
              </div>
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
                      video={!!line.video}
                      audio={!!line.audio}
                      onClick={() => {
                        clearDmResults();
                        void openDmLine(name, line.id);
                      }}
                    />
                  ))}
                </SearchResults>
              )}
            </div>
            <form
              onSubmit={(e) => void send(e)}
              onDragOver={dragFiles}
              onDrop={(e) => dropFiles(e, pickFiles)}
              onPaste={(e) => pasteFiles(e, pickFiles)}
              className={cn('border-t border-primaryStroke p-2 bubble:border-transparent bubble:md:p-[7px]', mobile && 'shrink-0', mobile && !sheet.raised && 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]')}
            >
              {replyTo && (
                <div id="friend-chat-replying" data-reply-to={replyTo.id} className="mb-1.5 flex items-center gap-2 border-l-2 border-primaryBlue bg-backgroundTertiary py-0.5 pl-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-textSecondary">
                    replying to <span className="font-semibold text-textPrimary">{replyTo.from === me ? 'yourself' : replyTo.from}</span>
                    <span className="sr-only">: {quoteWords({ text: replyTo.text, images: replyTo.images.length, video: !!replyTo.video, audio: !!replyTo.audio })}</span>
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
              {voice && (
                <div className="mb-2 flex">
                  <PendingVoiceChip voice={voice} sending={sending} idPrefix="friend-chat" onRemove={() => attach.removeVoice()} onRetry={() => attach.retryVoice()} />
                </div>
              )}
              {(pictures.length > 0 || video) && (
                <div id="friend-chat-picture-preview" className="mb-2 flex flex-wrap gap-2">
                  {video && <PendingVideo clip={video} sending={sending} idPrefix="friend-chat" size="h-16 w-16" onRemove={() => attach.removeVideo()} />}
                  {pictures.map((picture) => (
                    <PendingThumb key={picture.key} picture={picture} sending={sending} size="h-16 w-16" onRemove={() => attach.removePicture(picture.key)} />
                  ))}
                </div>
              )}
              <div className={cn('relative flex items-center gap-2', PILL)}>
                <label htmlFor="friend-chat-text" className="sr-only">
                  message {name}
                </label>
                {!recording && (
                  <AttachMenu
                    id="friend-chat-picture"
                    iconSize={18}
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textSecondary transition-colors duration-100 hover:bg-backgroundTertiary hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none bubble:hover:bg-backgroundTertiary bubble:focus-visible:border-primaryBlue',
                      IN_PILL,
                      mobile && 'h-11 w-11'
                    )}
                    onImage={() => (pictures.length >= MAX_CHAT_IMAGES ? showDmNotice(`${MAX_CHAT_IMAGES} pictures at most`) : fileRef.current?.click())}
                    onVoice={recorder.start}
                  />
                )}
                <input
                  ref={fileRef}
                  id="friend-chat-picture-file"
                  type="file"
                  accept={ATTACH_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(e) => pickFiles(e.target.files)}
                />
                {recording ? (
                  <VoiceBar
                    recorder={recorder}
                    idPrefix="friend-chat"
                    sendClassName={cn(INPUT_BUTTON, 'shrink-0 px-0 py-0', mobile ? 'h-11 w-11' : 'h-8 w-8 text-sm')}
                    onSend={(clip) => {
                      if (!name) return;
                      dmAttach(name).addVoice(clip.blob, clip.durationMs);
                      void send();
                    }}
                  />
                ) : (
                  <>
                  {emotes.list}
                  {mentions.list}
                  <input
                    ref={input}
                    id="friend-chat-text"
                    value={draft}
                    {...mentions.box}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      mentions.box.onSelect(e);
                    }}
                    onKeyDown={(e) => {
                      if (mentions.box.onKeyDown(e)) return;
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        if (replyTo) setReply(null);
                        else hideDms();
                      }
                    }}
                    placeholder="message"
                    aria-label={`message ${name}`}
                    maxLength={MAX_CHARS + 50}
                    autoComplete="off"
                    className={cn(INPUT, IN_PILL, mobile ? 'h-11 min-w-0 flex-1 py-0' : 'h-8 text-sm')}
                  />
                  <Tooltip content="send">
                    <Button
                      id="friend-chat-send"
                      type="submit"
                      aria-label="send"
                      onPointerDown={keepFocus}
                      variant="primary"
                      className={cn(INPUT_BUTTON, 'shrink-0 px-0 py-0', mobile ? 'h-11 w-11' : 'h-8 w-8 text-sm')}
                      disabled={(!draft.trim() && pictures.length === 0 && !video && !voice) || left < 0 || sending}
                      aria-busy={sending || undefined}
                    >
                      {sending ? (
                        <span className="relative flex items-center">
                          <RiLoader4Line aria-hidden size={16} className="motion-safe:animate-spin" />
                          <span className="sr-only">sending</span>
                        </span>
                      ) : (
                        <RiArrowUpLine aria-hidden size={18} />
                      )}
                    </Button>
                  </Tooltip>
                  </>
                )}
              </div>
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
          'group fixed flex text-base',
          !box && cn('bottom-6 h-[min(440px,70vh)] w-[min(400px,calc(100vw-3rem))]', side === 'right' ? 'right-[324px]' : 'left-[324px]')
        )
      )}
    >
      {content}
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
