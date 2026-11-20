import { RiArrowLeftSLine, RiArrowRightSLine, RiCloseLine, RiImageAddLine, RiRobot2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { createPortal } from 'react-dom';

import { api, messageOf, type Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, type ChatRoom, chatRoomFor, chatSpeakerAtom, isBotLine, MAX_CHAT_IMAGES, nickAtom, nickIsValidAtom, setNick } from '@/infra/atoms/chat-atoms';
import { openProfilePopup } from '@/infra/atoms/profile-popup-atoms';
import { type ChatStyle, chatStyleAtom, hideBotsAtom, profilePopupEnabledAtom, setHideBots } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { ChatLineShape, placeOf } from '@/shared-components/ChatLine';
import { SearchHit, SearchResults } from '@/shared-components/ChatSearch';
import { Face } from '@/shared-components/Face';
import { LinkedText } from '@/shared-components/LinkedText';
import { LiveMark } from '@/shared-components/LiveMark';
import { panelClassName } from '@/shared-components/Panel';
import { PersonCard, usePeek } from '@/shared-components/PersonCard';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SHEET_CLOSE, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { CHIP, CHIP_BUTTON, ControlTip } from '@/shared-components/VideoControls';
import { useIsMobile } from '@/infra/mobile';
import { compressChatImage } from '@/infra/picture';
import { cn } from '@/utils/cn';

/** Within this many px of the newest line counts as "at the bottom", so a one-line gap after a font swap does not unstick the view. */
const STUCK_PX = 40;
/** How long the pointer rests on a name before the speaker's card shows: a pause, not a pass over the names while reading. */
const PEEK_MS = 300;
/** How many grey lines stand in the room before its past has landed: enough to fill the panel, the rest clipped. Blocks are twice as tall, so half as many. */
const LINES_GUESS = 16;
/** The grey lines' shapes, cycled: the name's width, then the words'. Uneven, so the grey reads as talk and not as a table. */
const LINE_SHAPES: readonly (readonly [name: string, words: string])[] = [
  ['w-16', 'w-1/2'],
  ['w-12', 'w-3/4'],
  ['w-20', 'w-1/3'],
  ['w-14', 'w-2/3'],
  ['w-16', 'w-5/12'],
  ['w-10', 'w-7/12'],
  ['w-24', 'w-1/4'],
  ['w-14', 'w-4/5']
];

interface ChatPanelProps {
  /** A stream's room, or, with `channel`, the server. */
  name: string;
  /** The streamer's own grant. With it, our lines are marked. */
  owner?: Owner | null;
  /** Inside another box (the corner player): no stroke or minimum height of its own, and no header, which a panel this small has no room for. The lines and the text box alone. */
  embedded?: boolean;
  /**
   * A second panel on a room the page's own panel already holds open: the popped out player's
   * chat, over the go live page, whose chat is that same room. It draws the room and neither
   * joins nor leaves it, and the page's panel draws nothing while this one is up, so there is
   * still one room, one socket and one list on screen. The lines and a half typed line are the
   * same ones on both sides of the move: nothing reconnects.
   */
  guest?: boolean;
  /**
   * A group's channel: `name` is the server, this the channel on screen. One socket for every
   * channel of the server (`openServerChat`); a change of channel is `showChannel`, no socket
   * and no history. The header is the channel. The lines are the same as a stream's, in the
   * shape this browser picked; the ids and the data attributes stay. The panel has no search
   * box of its own: a group's is the roster's first row (ServerRoom.tsx `RoomSearch`), and the
   * hits land here, in the lines' place (`#chat-results`); a stream's chat is not searched,
   * though the same pane shows a speaker's lines.
   */
  channel?: string;
  /** A hit from another channel of the group was opened: the page puts that channel in its address (the lines have moved already, `openLine`). */
  onChannel?: (channel: string) => void;
  /** A group channel's own controls in the header, before the count: the pins (ServerRoom.tsx). */
  headerEnd?: ReactNode;
  /** A mark always at a line's top right, and buttons there on hover: a group line's pin (ServerRoom.tsx). Nothing on a stream's chat. */
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  className?: string;
}

/** Enter sends. The enter that picks an ime candidate is not a send (safari says it with keyCode 229). */
function isSendKey(e: ReactKeyboardEvent<HTMLInputElement>): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

/** A wait on the send button: `12s` under a minute, `9:05` from there (a cooldown or a timeout can run minutes), `3h 10m` past an hour. */
function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Whole seconds until `until` (unix ms), counting down; 0 once it has passed, or when there is nothing to wait for. */
function useCountdown(until: number): number {
  // the clock as an external store: the seconds left are the snapshot, and a timer says "look again" four times a second until the wait is over
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (until <= Date.now()) return () => {};
      const timer = setInterval(() => {
        onChange();
        if (Date.now() >= until) clearInterval(timer);
      }, 250);
      return () => clearInterval(timer);
    },
    [until]
  );
  return useSyncExternalStore(subscribe, () => {
    const left = until - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  });
}

/**
 * The chat next to the video, and a group channel's. Lines newest at the bottom, a nick box
 * until you have one (or a login), then one row: a picture, the text, send. The lines take the
 * shape this browser picked (settings.chatStyle, the chat tab's cards, drawn by ChatLine.tsx
 * as a friend's chat is: a log, bubbles, or blocks; `#chat-lines` carries it as `data-style`),
 * each wearing its speaker's group badges after the name; the blocks' face is the picture when
 * the line is a login's or the streamer's, the letter their name makes otherwise. The robot in
 * the header hides the bots' lines (a setting too, the chat tab has it as well). Joins on
 * mount, leaves on unmount (a room the next panel takes over right away stays open: the chat
 * going with the player into a window of its own is not a reconnect); a change of `owner`
 * (going live, stopping) or of the login says hello again. Each panel draws its own room
 * (`chatRoomFor`, chat-atoms.ts): the page's and the corner player's are two rooms at once,
 * each with its lines and its box, and two panels on one room share its socket and its lines.
 * A `guest` is a second panel on the page's own room, and the page's draws nothing while it is up.
 */

/** What a press on a speaker (their name, their face) does, and whether it does anything: the popup, or a login's lines here (Speaker). */
function useSpeakerPress(line: ChatLine, room: ChatRoom) {
  const popup = useAtomValue(profilePopupEnabledAtom);
  const press = (name: HTMLElement) => {
    if (popup && name.ownerDocument === document)
      openProfilePopup({
        name: line.from,
        verified: line.verified,
        oauth_verified: line.oauth_verified,
        avatar: line.avatar,
        lines: line.verified ? room.key : undefined
      });
    else if (line.verified) void room.showSpeaker(line.from);
  };
  return { popup, pressable: line.verified || (popup && line.streamer), press };
}

/**
 * The speaker's name. When the line is really that name's (a login's, or the streamer's; an
 * anonymous nick is nobody), a click on it shows them over the page (ProfilePopup.tsx: who
 * they are, their stream while they are live, their page, and the button that goes there),
 * and the pointer resting on the name, or the keyboard's focus landing on it, puts the
 * person's card (PersonCard.tsx, the sidebar's) beside the chat: the face with the word on
 * it, the name, their status. Where this browser turned the popup off (settings.profilePopup),
 * and in a chat that is in a window of its own (the popped out player, infra/popout.ts: the
 * popup is the page's, under that window), a login's name opens that account's lines here
 * instead, which the popup has as `their lines here`. No `title` beside it: two boxes for
 * one name is one too many. The colour says who the line is really from: the streamer green,
 * a login blue, an anonymous nick red (no card for it, so its `title` says why).
 */
function Speaker({ line, room }: { line: ChatLine; room: ChatRoom }) {
  const peek = usePeek(PEEK_MS);
  const { popup, pressable, press } = useSpeakerPress(line, room);
  const someone = line.verified || line.streamer;
  const watched = someone
    ? {
        onPointerEnter: (e: SyntheticEvent<HTMLElement>) => peek.show(e.currentTarget, e.currentTarget.closest('#chat')),
        onPointerLeave: (e: SyntheticEvent<HTMLElement>) => peek.leave(e.currentTarget),
        onFocus: (e: FocusEvent<HTMLElement>) => peek.focus(e, e.currentTarget.closest('#chat')),
        onBlur: peek.blur
      }
    : {};
  const color = line.streamer ? 'text-increase' : line.verified ? 'text-primaryBlue' : 'text-decrease';
  return (
    <>
      {pressable ? (
        <span
          {...watched}
          role="button"
          tabIndex={0}
          aria-haspopup={popup ? 'dialog' : undefined}
          data-from={line.from}
          onClick={(e) => press(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              press(e.currentTarget);
            }
          }}
          className={cn('cursor-pointer font-semibold', color)}
        >
          {line.from}
        </span>
      ) : (
        <span {...watched} data-from={line.from} title={someone ? undefined : 'not logged in'} className={cn('font-semibold', color)}>
          {line.from}
        </span>
      )}
      {/* the speaker's account has a provider linked: the mark, as the row is now (api chat.rs `with_faces`) */}
      {someone && line.oauth_verified && <OAuthMark size={14} className="ml-1 align-[-2px]" />}
      {someone && peek.at && (
        <PersonCard
          id={`chat-peek-${line.from}`}
          person={{ name: line.from, verified: line.verified, oauth_verified: line.oauth_verified, avatar: line.avatar, groups: line.groups }}
          at={peek.at}
        />
      )}
    </>
  );
}

/**
 * The speaker's face at the head of a run (blocks, ChatLine.tsx): a click on it does what a
 * click on their name does (Speaker). For the pointer alone: the name beside it is the way for a
 * key and a reader, so the face is no second tab stop. An anonymous nick's face is only a face.
 */
function SpeakerFace({ line, room }: { line: ChatLine; room: ChatRoom }) {
  const { pressable, press } = useSpeakerPress(line, room);
  const face = <Face name={line.from} version={line.avatar} className="h-8 w-8 text-sm" />;
  if (!pressable) return face;
  return (
    <span aria-hidden data-face-from={line.from} onClick={(e) => press(e.currentTarget)} className="flex cursor-pointer">
      {face}
    </span>
  );
}

/** What stands after the name: the group badges (each shows its group's card on hover and focus, from what the line carried: Badge.tsx), the red broadcast mark for the streamer's own lines (LiveMark.tsx; the word comes up at once on hover, Tooltip.tsx), `you` on ours. No ✓: the name's colour says whether a login is behind it (Speaker). */
function Marks({ line, mine }: { line: ChatLine; mine: boolean }) {
  return (
    <>
      {line.groups.map((group) => (
        <Badge key={group.name} group={group} card />
      ))}
      {line.streamer && (
        <Tooltip content="streamer">
          <LiveMark role="img" aria-label="streamer" data-streamer-mark />
        </Tooltip>
      )}
      {mine && <span className="bg-primaryBlue/15 px-1 text-xs uppercase text-primaryBlue">you</span>}
    </>
  );
}

/** Where a chat picture is fetched from, by the id `POST /api/chat-images` handed back. */
export function pictureSrc(id: string): string {
  return `/api/chat-images/${encodeURIComponent(id)}`;
}

/** A thumbnail under the pointer (or with keyboard focus): the picture greyed a little under a translucent black, still plainly seen, so the hover is felt. */
const THUMB_HOVER =
  "relative after:pointer-events-none after:absolute after:inset-0 after:bg-black/25 after:opacity-0 after:transition-opacity after:duration-150 after:content-[''] hover:after:opacity-100 focus-visible:after:opacity-100";

/**
 * The pictures on a line, under the words. One is drawn as it is, at most five lines tall. Two
 * sit side by side. More make two rows, the first with the odd one out, and the pictures of a
 * row share its width, cropped to fill their cells: three are two over one across the whole row,
 * five are three over two, eight are four over four. A click on any puts it over the whole page
 * (`PictureView`), in the window the chat is in: the page's, or the popped-out player's own.
 * A direct message's pictures are drawn by the same (FriendChat.tsx).
 */
export function ChatImages({ ids }: { ids: string[] }) {
  const [view, setView] = useState<{ at: number; host: HTMLElement } | null>(null);

  if (ids.length === 0) return null;
  const many = ids.length > 1;
  // one or two pictures are one row; more are two, the first with the odd one out
  const first = ids.length <= 2 ? ids.length : Math.ceil(ids.length / 2);
  const rows = [ids.slice(0, first), ids.slice(first)].filter((row) => row.length > 0);
  return (
    // the grid asks for 28rem and takes what the line has: inside a block, and inside the server line's shrink-to-fit column alike
    <span className={cn('mt-1 flex max-w-full flex-col gap-1', many && 'w-[28rem]')}>
      {rows.map((row, r) => (
        <span key={r} className={cn('flex gap-1', many && 'h-24')}>
          {row.map((id, j) => {
            const i = r * first + j;
            return (
              <button
                key={id}
                type="button"
                aria-label={many ? `picture ${i + 1} of ${ids.length}` : 'picture'}
                title="see it full size"
                className={cn(THUMB_HOVER, many ? 'min-w-0 flex-1' : 'block max-w-full')}
                onClick={(e) => setView({ at: i, host: e.currentTarget.ownerDocument.body })}
              >
                <img src={pictureSrc(id)} alt="" className={many ? 'h-full w-full object-cover' : 'max-h-[7.5rem] max-w-full object-contain'} />
              </button>
            );
          })}
        </span>
      ))}
      {view &&
        createPortal(
          <PictureView
            ids={ids}
            at={view.at}
            onStep={(by) => setView((cur) => (cur ? { ...cur, at: (cur.at + by + ids.length) % ids.length } : cur))}
            onClose={() => setView(null)}
          />,
          view.host
        )}
    </span>
  );
}

interface PictureViewProps {
  ids: string[];
  /** Which of `ids` is up. */
  at: number;
  /** The arrows and the arrow keys: one on, or one back, round the end. */
  onStep: (by: number) => void;
  onClose: () => void;
}

/** The picture stops this far from the window's edges, in percent of the window, on the two sides it reaches. */
const PICTURE_EDGE = 3;

/**
 * A chat picture over the whole page: the page dimmed dark grey behind it, the picture as tall or
 * as wide as the window allows less a small edge (scaled up as well as down), and a little blue
 * in the grey under it. A native <dialog> opened modal on mount, the way ConfirmDialog is: the
 * browser keeps focus in it, closes it on escape and hands focus back to the thumbnail. The ×
 * closes it too, and so does a click on the grey beside the picture. Several on the line get
 * arrows at the edges, and the arrow keys.
 */
function PictureView({ ids, at, onStep, onClose }: PictureViewProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** The press that began this click was beside the picture too: a drag off the picture is not a close. */
  const pressedBeside = useRef(false);
  /** Width over height of each picture seen so far, read when it loads: its drawn size comes from it. */
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const many = ids.length > 1;
  const shown = ids[at];
  const ratio = shown === undefined ? undefined : ratios[shown];

  // A layout effect: its cleanup runs while the node is still in the document, which is when close() hands focus back.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const close = () => dialogRef.current?.close();
  // already the whole window, a phone's page over the page: the back button shuts it too (MobileSheet.tsx)
  useSheetBack(close);
  /** On the grey: not on a button, and not on the picture (the <img> is drawn at exactly the picture's size). */
  const beside = (target: EventTarget) => target instanceof Element && !target.closest('button, img');
  const span = 100 - 2 * PICTURE_EDGE;

  return (
    <dialog
      ref={dialogRef}
      id="chat-picture-view"
      aria-label={many ? `picture ${at + 1} of ${ids.length}` : 'picture'}
      onClose={onClose}
      onPointerDown={(e) => {
        pressedBeside.current = beside(e.target);
      }}
      onClick={(e) => {
        if (pressedBeside.current && beside(e.target)) close();
      }}
      onKeyDown={(e) => {
        if (!many || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        onStep(e.key === 'ArrowLeft' ? -1 : 1);
      }}
      // the whole window, a column: the room over the picture, the picture, the room under it. a size container, so
      // the picture's width can be put in terms of the window's height (`cqh`) without the scrollbar gutter in the way
      className="fixed inset-0 m-0 hidden h-auto w-auto max-h-none max-w-none flex-col overflow-hidden border-0 bg-neutral-700/85 p-0 backdrop:bg-transparent open:flex [container-type:size]"
    >
      <div className="flex-1" />
      {shown && (
        <img
          key={shown}
          src={pictureSrc(shown)}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth && naturalHeight) setRatios((all) => ({ ...all, [shown]: naturalWidth / naturalHeight }));
          }}
          // as wide as the window less the edge, or as tall as that, whichever comes first; the height follows from the ratio. unseen until the ratio is known
          style={ratio === undefined ? undefined : { width: `min(${span}cqw, calc(${span}cqh * ${ratio}))` }}
          className={cn('shrink-0 self-center', ratio === undefined && 'invisible')}
        />
      )}
      {/* everything under the picture: the grey with a little of the blue in it */}
      <div className="flex-1 bg-primaryBlue/10" />
      {/* chips over the picture: their names read on it the video controls' way (ControlTip), not the page's */}
      <button
        type="button"
        id="chat-picture-close"
        aria-label="close"
        className={cn(CHIP_BUTTON, 'group/control absolute right-3 top-3 h-10 w-10 justify-center', SHEET_CLOSE)}
        onClick={close}
      >
        <RiCloseLine aria-hidden size={24} />
        <ControlTip at="below-right">close</ControlTip>
      </button>
      {many && (
        <>
          {/* which picture this is, top right just left of close: only when there is more than one */}
          <span id="chat-picture-count" aria-hidden className={cn(CHIP, 'pointer-events-none absolute right-16 top-3 h-10 items-center px-3 text-sm font-semibold tabular-nums')}>
            {at + 1} / {ids.length}
          </span>
          <button
            type="button"
            id="chat-picture-prev"
            aria-label="previous picture"
            className={cn(CHIP_BUTTON, 'group/control absolute left-3 top-1/2 h-12 w-12 -translate-y-1/2 justify-center')}
            onClick={() => onStep(-1)}
          >
            <RiArrowLeftSLine aria-hidden size={32} />
            <ControlTip at="above-left">previous picture</ControlTip>
          </button>
          <button
            type="button"
            id="chat-picture-next"
            aria-label="next picture"
            className={cn(CHIP_BUTTON, 'group/control absolute right-3 top-1/2 h-12 w-12 -translate-y-1/2 justify-center')}
            onClick={() => onStep(1)}
          >
            <RiArrowRightSLine aria-hidden size={32} />
            <ControlTip at="above-right">next picture</ControlTip>
          </button>
        </>
      )}
    </dialog>
  );
}

/**
 * What stands in the lines' place while the room's past is on its way: grey lines in the shape
 * the lines will take, so the panel reads as a chat that has not arrived and not as one with
 * nothing in it. A log's are one line each, the time, a name, some words; bubbles are a box a
 * side at a time; blocks are the face beside the name over the words. Clipped to the panel,
 * never scrolled, and no <p>, so nothing that keys on `#chat-lines p` takes a grey line for a
 * said one.
 */
function ChatSkeleton({ shape }: { shape: ChatStyle }) {
  const rows = shape === 'blocks' ? LINES_GUESS / 2 : LINES_GUESS;
  return (
    <Skeleton id="chat-loading" label="loading the chat" className="flex h-full flex-col gap-1 overflow-hidden">
      {Array.from({ length: rows }, (_, i) => {
        const [name, words] = LINE_SHAPES[i % LINE_SHAPES.length] ?? ['w-16', 'w-1/2'];
        if (shape === 'blocks') {
          return (
            <div key={i} className="my-1 flex gap-2.5">
              <Bone className="h-8 w-8 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
                <Bone className={cn('h-3.5', name)} />
                <Bone className={cn('h-3.5', words)} />
              </div>
            </div>
          );
        }
        if (shape === 'bubbles') {
          // the box on one side or the other, the way two people's lines fall
          return (
            <div key={i} className="flex gap-2.5">
              <Bone className="h-3 w-8 shrink-0 self-center" />
              <div className={cn('flex min-w-0 flex-1', i % 3 === 2 ? 'justify-end' : 'justify-start')}>
                <Bone className={cn('h-8', words)} />
              </div>
            </div>
          );
        }
        // one line of text-base leading-snug tall, the way a said line is
        return (
          <div key={i} className="flex h-[1.375rem] items-center gap-2">
            <Bone className="h-3 w-8 shrink-0" />
            <Bone className={cn('h-3.5 shrink-0', name)} />
            <Bone className={cn('h-3.5', words)} />
          </div>
        );
      })}
    </Skeleton>
  );
}

export function ChatPanel({ name, owner = null, embedded = false, guest = false, channel, onChannel, headerEnd, lineMark, lineActions, className }: ChatPanelProps) {
  const server = channel !== undefined;
  const listRef = useRef<HTMLDivElement | null>(null);
  // height before the last paint, so prepending older lines can put the same pixels back
  const hold = useRef(0);
  // true while the view sits at the newest line. someone who scrolled up to read is left there.
  const stuck = useRef(true);
  const shown = useRef(0);
  const shownRoom = useRef<ChatRoom | null>(null);
  const mobile = useIsMobile();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // this panel's room, and none other's: its lines, its box, its socket (chat-atoms.ts)
  const room = chatRoomFor(name, server);
  const lines = useAtomValue(room.visibleLinesAtom);
  const total = useAtomValue(room.linesAtom).length;
  const loaded = useAtomValue(room.loadedAtom);
  const hideBots = useAtomValue(hideBotsAtom);
  const hiddenBots = useAtomValue(room.hiddenBotLinesAtom);
  const shape = useAtomValue(chatStyleAtom);
  const count = useAtomValue(room.countAtom);
  const phase = useAtomValue(room.phaseAtom);
  const draft = useAtomValue(room.draftAtom);
  const images = useAtomValue(room.imagesAtom);
  const notice = useAtomValue(room.noticeAtom);
  const nick = useAtomValue(nickAtom);
  const nickOk = useAtomValue(nickIsValidAtom);
  const canSend = useAtomValue(room.canSendAtom);
  const asStreamer = useAtomValue(room.asStreamerAtom);
  const speaker = useAtomValue(chatSpeakerAtom);
  const me = useAtomValue(meAtom);
  const results = useAtomValue(room.resultsAtom);
  const resultsFor = useAtomValue(room.resultsForAtom);
  const pinned = useAtomValue(room.pinnedAtom);
  const behind = useAtomValue(room.behindAtom);
  const scrollTick = useAtomValue(room.scrollAtom);
  const tier = useAtomValue(room.tierAtom);
  const shake = useAtomValue(room.shakeAtom);
  // a send refused for the rate: the seconds until the next line may go, on the send button
  const wait = useCountdown(useAtomValue(room.waitAtom));
  // a guest is drawing this room somewhere else: this panel, the one that holds the room open, stands aside
  const aside = useAtomValue(room.guestAtom) && !guest;

  // The inputs that change while mounted: the room, the owner (going live) and the login.
  // Nothing opens until /api/me has answered, so the first hello is the right one.
  // A server is one socket for every channel: the channel is not one of these inputs.
  // Going is not yet a close: the room may be the next panel's to take over, a moment from now.
  useEffect(() => {
    if (me === undefined) return;
    return room.join(owner);
  }, [room, owner?.session, owner?.token, me]);

  // A guest says it is up for as long as it is, and the panel that holds the room stands aside.
  useEffect(() => {
    if (!guest) return;
    room.setGuest(true);
    return () => room.setGuest(false);
  }, [room, guest]);

  // The channel on screen, for a server: a swap of what is shown, nothing opened or asked.
  useEffect(() => {
    if (channel !== undefined) room.showChannel(channel);
  }, [room, channel]);

  /** The nick box's join: the socket as the panels want it. */
  const open = () => room.open();

  // Keep the newest line in view, unless the reader has scrolled up, or a jump asked for one line.
  // A layout effect: the store fires before react has put the new lines in the dom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) {
      // standing aside for a guest: there is no list. the one that comes back is a new one, and starts at the newest line
      shown.current = 0;
      return;
    }
    // another room in this panel (the corner following another stream) starts at its newest line
    if (shownRoom.current !== room) {
      shownRoom.current = room;
      shown.current = 0;
    }
    const plan = room.takeScrollPlan();
    if (plan === 'keep') {
      el.scrollTop += el.scrollHeight - hold.current;
    } else if (plan && typeof plan === 'object') {
      const node = el.querySelector(`[data-id="${CSS.escape(plan.id)}"]`);
      // centred by the list's own scroll, not scrollIntoView: that would centre the line in the window as well, scrolling the page under the panel (the room page snaps between its views)
      if (node instanceof HTMLElement) el.scrollTop += node.getBoundingClientRect().top - el.getBoundingClientRect().top - (el.clientHeight - node.offsetHeight) / 2;
      stuck.current = false;
      room.setFollowing(false);
    } else if (plan === 'bottom' || stuck.current || shown.current === 0) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
      room.setFollowing(true);
    }
    shown.current = lines.length;
    hold.current = el.scrollHeight;
  }, [room, lines, total, scrollTick, aside]);

  // A phone's list changes height under the reader (the keyboard, the player easing to a strip and
  // back, mobile.ts): one sitting at the newest line stays there through it
  useEffect(() => {
    const el = listRef.current;
    if (!mobile || !el) return;
    const seen = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [mobile, aside]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
    stuck.current = atBottom;
    room.setFollowing(atBottom);
    room.noteScroll(el.scrollTop);
    if (el.scrollTop < 48) void room.loadOlder();
  }

  async function pickPictures(list: FileList | null) {
    const files = list ? [...list] : [];
    if (files.length === 0 || uploading) return;
    // the room the pictures were picked in, even when the panel moves to another before they are up
    const into = room;
    const left = MAX_CHAT_IMAGES - images.length;
    const batch = files.slice(0, Math.max(0, left));
    if (files.length > left) into.showNotice(`${MAX_CHAT_IMAGES} pictures at most`);
    if (batch.length === 0) return;
    setUploading(true);
    try {
      for (const file of batch) {
        const blob = await compressChatImage(file);
        const saved = await api.uploadChatImage(blob);
        into.addImage(saved.id);
      }
    } catch (err) {
      into.showNotice(messageOf(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // the nick box stays until "join" actually opened the socket. a login never needs one.
  const needsNick = !owner && !me && phase === 'off';
  // the room's past is still on its way, and nothing of it has come: a server's lines are asked of the api as its page
  // arrives; a stream's come down the socket, which opens once /api/me has answered and, without a login, once a nick
  // is picked (the nick box waits on nobody, so there the room is as empty as it says)
  const waiting = !loaded && total === 0 && (server || me === undefined || phase !== 'off');
  // the name the server echoes our own lines under: the stream's when we are the streamer, else the login or nick
  const myName = asStreamer ? name : speaker;

  // the room is being drawn in the player's own window: the panel's box, and where the chat went. the tab is
  // behind another while that window is up, so this is seen only where a browser leaves the window open
  if (aside) {
    return (
      <aside
        id="chat"
        data-phase={phase}
        data-away=""
        className={embedded ? cn('flex flex-col', className) : panelClassName(cn('flex min-h-[320px] flex-col', className))}
      >
        <p className="m-auto px-6 text-center text-textTertiary">the chat is out in your stream's window. it is back here when that closes.</p>
      </aside>
    );
  }

  return (
    <aside
      id="chat"
      data-phase={phase}
      data-room={room.key}
      className={embedded ? cn('relative flex flex-col', className) : panelClassName(cn('relative flex min-h-[320px] flex-col', className))}
    >
      {/* on a phone a stream's chat (watch, go live) drops this bar to leave the lines room over the keyboard: kept for screen readers, ids and the hide-bots setting as they are. a group's bar stays, it names the channel */}
      {!embedded && (
        <header
          className={cn('flex items-center justify-between gap-3 border-b border-primaryStroke px-3 py-1.5 text-base', !server && 'max-md:sr-only')}
        >
          <span id={server ? 'channel' : undefined} className="truncate font-semibold">
            {server ? `#${channel}` : 'chat'}
          </span>
          <span className="flex min-w-0 items-center gap-3">
            {headerEnd}
            <span id="chat-count" className="truncate text-textSecondary">
              {count} here · {phase === 'open' ? 'live' : phase}
            </span>
            {/* the bots' lines: shown, or held back with how many. a setting of this browser, so it follows you from room to room */}
            <button
              id="chat-hide-bots"
              type="button"
              aria-pressed={hideBots}
              title={hideBots ? `the bots' lines are hidden. click to show them` : "hide the bots' lines (the fake streams' chatters)"}
              onClick={() => setHideBots(!hideBots)}
              className={cn(
                'flex shrink-0 items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors duration-150',
                hideBots ? 'border-primaryBlue text-primaryBlue' : 'border-primaryStroke text-textTertiary hover:border-secondaryStroke hover:text-textSecondary'
              )}
            >
              <RiRobot2Line aria-hidden size={14} />
              {hideBots ? `${hiddenBots} hidden` : 'hide bots'}
            </button>
          </span>
        </header>
      )}

      {/* the lines (and `latest` over them while the view is off the tail), and over those the hits while there are any. `relative`: the pane is `absolute` in it (relative-parent.mdc) */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* under the hits the lines keep their place unseen (`invisible`), so the scroll, the ref and the plan hold and a line coming meanwhile lands at the bottom */}
        <div className={cn('flex min-h-0 flex-1 flex-col', results && 'invisible')}>
          {pinned && (
            <button
              id="chat-latest"
              type="button"
              onClick={() => room.backToLatest()}
              className="w-full shrink-0 border-b border-primaryStroke px-3 py-1 text-sm font-semibold text-primaryBlue"
            >
              latest{behind > 0 ? ` · ${behind} new` : ''}
            </button>
          )}

          <div
            ref={listRef}
            onScroll={onScroll}
            id="chat-lines"
            role="log"
            aria-live="polite"
            data-style={shape}
            // its scroll is its own: the top of the history does not scroll the page under it (the room page snaps between its views).
            // a column: a log is a line each at an even gap; bubbles stand close within a minute and apart between minutes, blocks close within a run and apart between runs (ChatLine.tsx)
            className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 py-1 text-base leading-snug', shape === 'log' ? 'gap-1' : 'gap-0.5')}
          >
            {waiting && <ChatSkeleton shape={shape} />}
            {!waiting && lines.length === 0 && (
              <p className="text-textTertiary">{hiddenBots ? `only bots so far, ${hiddenBots} lines hidden.` : 'nothing yet. say something.'}</p>
            )}
            {lines.map((line, i) => {
              // ours by name and by kind, since a nick may wear a free room's name: the streamer's lines wear `streamer`, a login's `verified`, a nick's neither
              const mine = line.from === myName && (asStreamer ? line.streamer : me ? line.verified : !line.verified && !line.streamer);
              // a run is one speaker's lines in a row: the same name of the same kind, since a nick may wear a name a login holds elsewhere
              const prev = lines[i - 1];
              const same = prev !== undefined && prev.from === line.from && prev.verified === line.verified && prev.streamer === line.streamer;
              return (
                <ChatLineShape
                  key={line.id}
                  shape={shape}
                  mine={mine}
                  at={line.at}
                  name={line.from}
                  crowd
                  who={
                    <>
                      <Speaker line={line} room={room} />
                      <span className="ml-1 inline-flex items-center gap-1 align-middle">
                        <Marks line={line} mine={mine} />
                      </span>
                    </>
                  }
                  face={<SpeakerFace line={line} room={room} />}
                  words={
                    line.text ? (
                      <span className="whitespace-pre-wrap">
                        <LinkedText text={line.text} />
                      </span>
                    ) : null
                  }
                  pictures={<ChatImages ids={line.images} />}
                  mark={lineMark?.(line)}
                  actions={lineActions?.(line)}
                  attrs={{
                    'data-id': line.id,
                    'data-streamer': line.streamer || undefined,
                    'data-verified': line.verified || undefined,
                    'data-bot': isBotLine(line) || undefined,
                    'data-groups': line.groups.length ? line.groups.map((g) => g.name).join(' ') : undefined,
                    'data-mine': mine || undefined
                  }}
                  {...placeOf(line.at, prev?.at, same)}
                />
              );
            })}
          </div>
        </div>

        {/* the hits, or one speaker's lines, newest first, where the lines were (ChatSearch.tsx). one clicked puts the lines back with it in view; close puts them back as they were */}
        {results && (
          <SearchResults id="chat-results" label={resultsFor} count={results.length} onClose={() => room.clearResults()} className="absolute inset-0 text-base">
            {results.map((line) => {
              // where the hit is, when it is not here: a server's search is every channel's
              const elsewhere = line.channel !== undefined && line.channel !== channel ? line.channel : null;
              return (
                <SearchHit
                  key={line.id}
                  id={line.id}
                  at={line.at}
                  attrs={{ 'data-channel': line.channel }}
                  before={elsewhere !== null && <span className="mr-1.5 text-textTertiary">#{elsewhere}</span>}
                  who={<span className="font-semibold text-primaryBlue">{line.from}</span>}
                  text={line.text}
                  images={line.images.length}
                  onClick={() => {
                    // a server's hit from another channel: the lines move there now, and the page's address follows
                    if (elsewhere !== null) onChannel?.(elsewhere);
                    room.clearResults();
                    void room.openLine(line.id, line.channel);
                  }}
                />
              );
            })}
          </SearchResults>
        )}
      </div>

      <footer className="border-t border-primaryStroke p-2">
        {needsNick ? (
          <div className="flex flex-wrap gap-2">
            <label htmlFor="chat-nick" className="sr-only">
              your nick
            </label>
            <input
              id="chat-nick"
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nickOk) open();
              }}
              placeholder="nickname"
              maxLength={24}
              autoComplete="off"
              className="min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base"
            />
            <Button id="chat-join" variant="primary" className="px-4 py-2 text-base" disabled={!nickOk} onClick={open}>
              join
            </Button>
            {/* "that name has an account": the refusal that sent you back here */}
            {notice && (
              <span id="chat-notice" className="w-full text-sm text-decrease" aria-live="polite">
                {notice}
              </span>
            )}
          </div>
        ) : (
          <>
            <label htmlFor="chat-text" className="sr-only">
              your message
            </label>
            <span id="chat-notice" className={cn('text-sm text-decrease', notice ? 'mb-1 block' : 'sr-only')} aria-live="polite">
              {notice}
            </span>
            {images.length > 0 && (
              <div id="chat-picture-preview" className="mb-2 flex flex-wrap gap-2">
                {images.map((id) => (
                  <span key={id} className="relative">
                    <img src={pictureSrc(id)} alt="" className="h-20 w-20 object-cover" />
                    <Tooltip content="remove">
                      <button
                        type="button"
                        aria-label="remove picture"
                        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center bg-black/70 text-white"
                        onClick={() => room.removeImage(id)}
                      >
                        <RiCloseLine aria-hidden size={14} />
                      </button>
                    </Tooltip>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Tooltip content={images.length >= MAX_CHAT_IMAGES ? `${MAX_CHAT_IMAGES} pictures at most` : 'add a picture'}>
                <button
                  type="button"
                  id="chat-picture"
                  aria-label="picture"
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-textTertiary disabled:opacity-40"
                  disabled={uploading || images.length >= MAX_CHAT_IMAGES}
                  onClick={() => fileRef.current?.click()}
                >
                  <RiImageAddLine size={20} aria-hidden />
                </button>
              </Tooltip>
              <input ref={fileRef} id="chat-picture-file" type="file" accept="image/*" multiple className="hidden" onChange={(e) => void pickPictures(e.target.files)} />
              <input
                id="chat-text"
                value={draft}
                onChange={(e) => room.setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (!isSendKey(e)) return;
                  e.preventDefault();
                  room.send();
                }}
                placeholder="comment"
                aria-label={`comment as ${asStreamer ? name : speaker}`}
                autoComplete="off"
                // a phone zooms in on a focused box under 16px: never smaller there, whatever text size the appearance tab picked
                className="h-9 min-w-0 flex-1 border border-primaryStroke bg-background px-3 text-base max-md:h-11 max-md:text-[length:max(1rem,16px)]"
              />
              {/* refused for the rate: the button goes red and counts down to the next line, and shakes at each try meanwhile. still a button, so a try can shake it */}
              <Button
                id="chat-send"
                variant={wait > 0 ? 'danger' : 'primary'}
                // a phone's: a 44px target at least, as tall as the box beside it
                className="h-9 shrink-0 px-4 text-base tabular-nums max-md:h-11 max-md:min-w-11 max-md:text-[length:max(1rem,16px)]"
                disabled={!canSend}
                title={wait > 0 ? `${tier.words}. the next in ${waitWords(wait)}` : undefined}
                data-wait={wait > 0 ? wait : undefined}
                onClick={() => room.send()}
              >
                {wait > 0 ? (
                  <span key={shake} className="inline-block motion-safe:animate-shake">
                    {waitWords(wait)}
                  </span>
                ) : (
                  'send'
                )}
              </Button>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
