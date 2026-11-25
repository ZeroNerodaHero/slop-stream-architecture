import { RiAddLine, RiArrowLeftSLine, RiArrowRightSLine, RiArrowUpLine, RiCloseLine, RiLoader4Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import {
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { type GroupBadge, type Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { BOT_GROUP, type ChatLine, type ChatRoom, chatRoomFor, chatSpeakerAtom, isBotLine, MAX_CHAT_IMAGES, nickAtom, nickIsValidAtom, setNick } from '@/infra/atoms/chat-atoms';
import { openProfilePopup } from '@/infra/atoms/profile-popup-atoms';
import { roleColorsAtom } from '@/infra/atoms/room-atoms';
import { type ChatStyle, chatStyleAtom, hideBotsAtom, profilePopupEnabledAtom } from '@/infra/atoms/settings-atoms';
import { EQUES, showWelcomesAtom, type Welcome } from '@/infra/atoms/welcome-atoms';
import { type MediaGone, shownSrc, whyGone } from '@/infra/chat-video';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { ATTACH_ACCEPT, dragFiles, dropFiles, pasteFiles, PendingThumb, PendingVideo, PICTURE_ACCEPT, splitFiles, STREAM_CHAT_VIDEO, STREAM_VIDEO_OFF } from '@/shared-components/ChatAttach';
import { ChatEmbeds } from '@/shared-components/ChatEmbeds';
import { ChatLineShape, type ChatLineShapeProps, LineActions, type LineMenuItem, placeOf, quoteWords, ReplyQuote } from '@/shared-components/ChatLine';
import { ReactionChips } from '@/shared-components/Reactions';
import { SearchHit, SearchResults } from '@/shared-components/ChatSearch';
import { ChatVideoPlayer, MediaGoneNote } from '@/shared-components/ChatVideoPlayer';
import { useEmoteComplete } from '@/shared-components/EmoteComplete';
import { Face } from '@/shared-components/Face';
import { IN_PILL, INPUT, INPUT_BUTTON, PILL } from '@/shared-components/input';
import { LinkedText } from '@/shared-components/LinkedText';
import { LiveMark } from '@/shared-components/LiveMark';
import { useMentionComplete } from '@/shared-components/MentionComplete';
import { panelClassName } from '@/shared-components/Panel';
import { PersonCard } from '@/shared-components/PersonCard';
import { usePeek } from '@/shared-components/peek';
import { OAuthMark } from '@/shared-components/OAuthMark';
import { CHAT_GRIP, useChatWindowBar } from '@/shared-components/ChatSlot';
import { Bone, Skeleton } from '@/shared-components/Skeleton';
import { SHEET_CLOSE, useSheetBack } from '@/shared-components/MobileSheet';
import { Tooltip } from '@/shared-components/Tooltip';
import { CHIP, CHIP_BUTTON, ControlTip } from '@/shared-components/VideoControls';
import { keepFocus } from '@/infra/keyboard';
import { cn } from '@/utils/cn';

const PEEK_MS = 300;
const LINES_GUESS = 16;
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
  name: string;
  owner?: Owner | null;
  embedded?: boolean;
  guest?: boolean;
  channel?: string;
  onChannel?: (channel: string) => void;
  headerEnd?: ReactNode;
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  lineMenu?: (line: ChatLine) => LineMenuItem[];
  welcome?: Welcome | null;
  className?: string;
}

function isSendKey(e: ReactKeyboardEvent<HTMLInputElement>): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function useCountdown(until: number): number {
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

function useRoleColors(room: ChatRoom): (name: string) => string | undefined {
  const { server, colors } = useAtomValue(roleColorsAtom);
  const ours = room.server !== null && room.server === server;
  return (name) => (ours ? colors.get(name) : undefined);
}

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

function Speaker({ line, room }: { line: ChatLine; room: ChatRoom }) {
  const peek = usePeek(PEEK_MS);
  const { popup, pressable, press } = useSpeakerPress(line, room);
  const someone = line.verified || line.streamer;
  const watched = someone
    ? {
        onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => peek.show(e, e.currentTarget.closest('#chat')),
        onPointerLeave: (e: SyntheticEvent<HTMLElement>) => peek.leave(e.currentTarget),
        onFocus: (e: FocusEvent<HTMLElement>) => peek.focus(e, e.currentTarget.closest('#chat')),
        onBlur: peek.blur,
        onKeyDown: peek.keyDown
      }
    : {};
  const roleColor = useRoleColors(room);
  const tint = line.verified ? roleColor(line.from) : undefined;
  const color = tint ? undefined : line.streamer ? 'text-increase' : line.verified ? 'text-primaryBlue' : 'text-decrease';
  const style = tint ? { color: tint } : undefined;
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
            peek.keyDown(e);
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              press(e.currentTarget);
            }
          }}
          className={cn('cursor-pointer font-semibold', color)}
          style={style}
        >
          {line.from}
        </span>
      ) : (
        <Tooltip content={someone ? null : 'not logged in'}>
          <span {...watched} data-from={line.from} className={cn('font-semibold', color)} style={style}>
            {line.from}
          </span>
        </Tooltip>
      )}
      {someone && line.oauth_verified && <OAuthMark size={14} className="ml-1 align-[-2px]" />}
      {someone && peek.at && (
        <PersonCard
          id={`chat-peek-${line.from}`}
          person={{ name: line.from, verified: line.verified, oauth_verified: line.oauth_verified, avatar: line.avatar, groups: line.groups }}
          at={peek.at}
          hold={peek.hold}
        />
      )}
    </>
  );
}

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

function Marks({ line, mine, small }: { line: ChatLine; mine: boolean; small: boolean }) {
  return (
    <>
      {line.groups.map((group) => (
        <Badge key={group.name} group={group} card size={small ? 'xs' : 'sm'} />
      ))}
      {line.streamer && (
        <Tooltip content="streamer">
          <LiveMark role="img" aria-label="streamer" data-streamer-mark size={small ? 'xs' : 'sm'} />
        </Tooltip>
      )}
      {mine && <span className="bg-primaryBlue/15 px-1 text-xs uppercase text-primaryBlue">you</span>}
    </>
  );
}

export function pictureSrc(id: string): string {
  return `/api/chat-images/${encodeURIComponent(id)}`;
}

const THUMB_HOVER =
  "relative after:pointer-events-none after:absolute after:inset-0 after:bg-black/25 after:opacity-0 after:transition-opacity after:duration-150 after:content-[''] hover:after:opacity-100 focus-visible:after:opacity-100";

export function ChatImages({ ids, small = false }: { ids: string[]; small?: boolean }) {
  const [view, setView] = useState<{ at: number; host: HTMLElement } | null>(null);
  const [gone, setGone] = useState<Record<string, MediaGone>>({});
  const [sensitive, setSensitive] = useState<Record<string, boolean>>({});
  const srcOf = (id: string) => (id in sensitive ? shownSrc(pictureSrc(id)) : pictureSrc(id));
  const failed = (id: string) =>
    void whyGone(srcOf(id)).then((w) => {
      if (w === 'sensitive') setSensitive((all) => (id in all ? all : { ...all, [id]: false }));
      else if (w) setGone((all) => ({ ...all, [id]: w }));
    });

  if (ids.length === 0) return null;
  const many = ids.length > 1;
  const first = ids.length <= 2 ? ids.length : Math.ceil(ids.length / 2);
  const rows = [ids.slice(0, first), ids.slice(first)].filter((row) => row.length > 0);
  return (
    <span className={cn('mt-1 flex max-w-full flex-col gap-1', many && 'w-[28rem]')}>
      {rows.map((row, r) => (
        <span key={r} className={cn('flex gap-1', many && (small ? 'h-16' : 'h-24'))}>
          {row.map((id, j) => {
            const i = r * first + j;
            const why = gone[id];
            if (why) return <MediaGoneNote key={id} why={why} className={many ? 'min-w-0 flex-1 justify-center' : undefined} />;
            if (sensitive[id] === false) {
              return (
                <span
                  key={id}
                  data-sensitive={id}
                  className={cn(
                    'relative flex flex-col items-center justify-center gap-1 overflow-hidden bg-backgroundTertiary',
                    many ? 'min-w-0 flex-1' : small ? 'h-20 w-32 max-w-full' : 'h-[7.5rem] w-48 max-w-full'
                  )}
                >
                  <span className="relative bg-background/70 px-1 text-xs text-textPrimary">sensitive</span>
                  <Button size="sm" className="relative" aria-label="show sensitive picture" onClick={() => setSensitive((all) => ({ ...all, [id]: true }))}>
                    show
                  </Button>
                </span>
              );
            }
            return (
              <button
                key={id}
                type="button"
                aria-label={many ? `picture ${i + 1} of ${ids.length}` : 'picture'}
                title="see it full size"
                className={cn(THUMB_HOVER, many ? 'min-w-0 flex-1' : 'block max-w-full')}
                onClick={(e) => setView({ at: i, host: e.currentTarget.ownerDocument.body })}
              >
                <img
                  src={srcOf(id)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  onError={() => failed(id)}
                  className={many ? 'h-full w-full object-cover' : cn('max-w-full object-contain', small ? 'max-h-20' : 'max-h-[7.5rem]')}
                />
              </button>
            );
          })}
        </span>
      ))}
      {view &&
        createPortal(
          <PictureView
            ids={ids}
            srcOf={srcOf}
            blurred={(id) => sensitive[id] === false}
            onShow={(id) => setSensitive((all) => ({ ...all, [id]: true }))}
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
  srcOf: (id: string) => string;
  blurred: (id: string) => boolean;
  onShow: (id: string) => void;
  at: number;
  onStep: (by: number) => void;
  onClose: () => void;
}

const PICTURE_EDGE = 3;

function PictureView({ ids, srcOf, blurred, onShow, at, onStep, onClose }: PictureViewProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBeside = useRef(false);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const many = ids.length > 1;
  const shown = ids[at];
  const ratio = shown === undefined ? undefined : ratios[shown];

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
  const beside = (target: EventTarget) => target instanceof Element && !target.closest('button, img, [data-sensitive]');
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
      className="fixed inset-0 m-0 hidden h-auto w-auto max-h-none max-w-none flex-col overflow-hidden border-0 bg-neutral-700/85 p-0 backdrop:bg-transparent open:flex [container-type:size]"
    >
      <div className="flex-1" />
      {shown && blurred(shown) && (
        <span data-sensitive={shown} className="flex shrink-0 flex-col items-center gap-2 self-center bg-backgroundTertiary px-8 py-10 text-sm text-textPrimary">
          sensitive
          <Button size="sm" aria-label="show sensitive picture" onClick={() => onShow(shown)}>
            show
          </Button>
        </span>
      )}
      {shown && !blurred(shown) && (
        <img
          key={shown}
          src={srcOf(shown)}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth && naturalHeight) setRatios((all) => ({ ...all, [shown]: naturalWidth / naturalHeight }));
          }}
          style={ratio === undefined ? undefined : { width: `min(${span}cqw, calc(${span}cqh * ${ratio}))` }}
          className={cn('shrink-0 self-center', ratio === undefined && 'invisible')}
        />
      )}
      <div className="flex-1 bg-primaryBlue/10" />
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

const BOT_BADGE: GroupBadge = { name: BOT_GROUP, badge: 'BOT', color: '#5865f2' };

const TOAST =
  'pointer-events-auto absolute bottom-full left-1/2 -translate-x-1/2 z-10 mb-2 flex w-max max-w-[calc(100%-1.5rem)] items-center gap-2 border border-decrease/60 bg-background px-2 py-1 text-xs text-decrease';

function ChatNotice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  return (
    <span id="chat-notice" role="status" aria-live="polite" className={cn(TOAST, !notice && 'sr-only')}>
      {notice && <span aria-hidden className="pointer-events-none absolute inset-0 bg-decrease/10" />}
      <span className="relative min-w-0 break-words">{notice}</span>
      {notice && (
        <Tooltip content="dismiss">
          <button
            type="button"
            aria-label="dismiss"
            className="relative flex h-4 w-4 shrink-0 items-center justify-center text-decrease hover:text-textPrimary max-md:-my-3 max-md:-mr-2 max-md:h-11 max-md:w-11"
            onClick={onDismiss}
          >
            <RiCloseLine aria-hidden size={12} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}

function WelcomeLine({ welcome }: { welcome: Welcome }) {
  const hideBots = useAtomValue(hideBotsAtom);
  const show = useAtomValue(showWelcomesAtom);
  const [at] = useState(() => Date.now());
  if (!welcome.on || hideBots || !show) return null;
  return <EquesLine message={welcome.message} at={at} attrs={{ id: 'chat-welcome', 'data-bot': true, 'data-welcome': '' }} />;
}

export function EquesLine({ message, at, attrs }: { message: string; at: number; attrs: ChatLineShapeProps['attrs'] }) {
  const shape = useAtomValue(chatStyleAtom);
  return (
    <ChatLineShape
      shape={shape}
      mine={false}
      at={at}
      name={EQUES}
      crowd
      who={
        <>
          <span data-from={EQUES} className="font-semibold normal-case text-textSecondary">
            {EQUES}
          </span>
          <span className="ml-1 inline-flex items-center gap-1 align-middle">
            <Badge group={BOT_BADGE} size={shape === 'bubbles' ? 'xs' : 'sm'} />
          </span>
        </>
      }
      face={<img src="/icon-192.png?v=3" alt={EQUES} draggable={false} className="h-8 w-8 shrink-0 border border-primaryStroke object-cover" />}
      words={
        <span className="whitespace-pre-wrap">
          <LinkedText text={message} />
        </span>
      }
      attrs={attrs}
      first
      bucket
    />
  );
}

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
          return (
            <div key={i} className="flex gap-2.5">
              <Bone className="h-3 w-8 shrink-0 self-center" />
              <div className={cn('flex min-w-0 flex-1', i % 3 === 2 ? 'justify-end' : 'justify-start')}>
                <Bone className={cn('h-8', words)} />
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="flex h-[1.203125rem] items-center gap-2">
            <Bone className="h-3 w-8 shrink-0" />
            <Bone className={cn('h-3.5 shrink-0', name)} />
            <Bone className={cn('h-3.5', words)} />
          </div>
        );
      })}
    </Skeleton>
  );
}

interface ChatRowProps {
  line: ChatLine;
  room: ChatRoom;
  shape: ChatStyle;
  mine: boolean;
  me: string | null | undefined;
  first: boolean;
  bucket: boolean;
  flashed: boolean;
  replyColor: string | undefined;
  replies: boolean;
  reacts: boolean;
  jumps: boolean;
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  lineMenu?: (line: ChatLine) => LineMenuItem[];
  lineSide?: (line: ChatLine) => ReactNode;
  bare?: boolean;
  firstInList?: boolean;
}

const ChatRow = memo(function ChatRow({
  line,
  room,
  shape,
  mine,
  me,
  first,
  bucket,
  flashed,
  replyColor,
  replies,
  reacts,
  jumps,
  lineMark,
  lineActions,
  lineMenu,
  lineSide,
  bare,
  firstInList
}: ChatRowProps) {
  return (
    <ChatLineShape
      shape={shape}
      mine={mine}
      at={line.at}
      name={line.from}
      crowd
      who={
        <>
          <Speaker line={line} room={room} />
          <span className="ml-1 inline-flex items-center gap-1 align-middle">
            <Marks line={line} mine={mine} small={shape === 'bubbles'} />
          </span>
        </>
      }
      face={<SpeakerFace line={line} room={room} />}
      words={
        line.text || line.pending === 'failed' ? (
          <>
            {line.text && (
              <span className="whitespace-pre-wrap">
                <LinkedText text={line.text} mentions={line.mentions} />
              </span>
            )}
            {line.pending === 'failed' && (
              <span data-not-sent className="ml-1.5 text-xs text-decrease">
                not sent
              </span>
            )}
          </>
        ) : null
      }
      pending={line.pending}
      pictures={
        <>
          <ChatImages ids={line.images} />
          {line.video && <ChatVideoPlayer video={line.video} />}
          <ChatEmbeds text={line.text} />
        </>
      }
      mark={line.pending ? undefined : lineMark?.(line)}
      actions={
        line.pending ? undefined : (
          <LineActions
            onReact={reacts && me ? (emoji) => room.react(line, emoji) : undefined}
            reactions={line.reactions ?? []}
            me={me}
            reactOff={reacts && !me ? 'log in to react' : undefined}
            onReply={replies ? () => room.setReply(line) : undefined}
            extra={lineActions?.(line)}
            text={line.text}
            menu={lineMenu?.(line)}
          />
        )
      }
      reactions={
        <ReactionChips
          reactions={line.reactions ?? []}
          me={me}
          onReact={reacts && me ? (emoji) => room.react(line, emoji) : undefined}
          onBlocked={reacts ? () => room.showNotice('log in to react') : undefined}
        />
      }
      quote={
        line.reply && (
          <ReplyQuote
            shape={shape}
            quote={{ from: line.reply.from, text: line.reply.text, avatar: line.reply.avatar ?? null, images: line.reply.images ?? 0, video: line.reply.video }}
            color={replyColor}
            onJump={jumps ? () => void room.jumpToReply(line.reply!.id) : undefined}
          />
        )
      }
      flash={flashed}
      side={line.pending ? undefined : lineSide?.(line)}
      attrs={{
        'data-id': line.id,
        'data-pending': line.pending,
        'data-reply-to': line.reply?.id,
        'data-streamer': line.streamer || undefined,
        'data-verified': line.verified || undefined,
        'data-bot': isBotLine(line) || undefined,
        'data-groups': line.groups.length ? line.groups.map((g) => g.name).join(' ') : undefined,
        'data-mine': mine || undefined
      }}
      first={first}
      bucket={bucket}
      bare={bare}
      firstInList={firstInList}
    />
  );
});

const FIRST_INDEX = 1_000_000;

interface RowCtx {
  room: ChatRoom;
  shape: ChatStyle;
  flash: string | null;
  me: string | null | undefined;
  myName: string | null;
  asStreamer: boolean;
  roleColor: (name: string) => string | undefined;
  replies: boolean;
  reacts: boolean;
  jumps: boolean;
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  lineMenu?: (line: ChatLine) => LineMenuItem[];
  lineSide?: (line: ChatLine) => ReactNode;
  bare: boolean;
  hasHeader: boolean;
}

function samePrev(lines: readonly ChatLine[], i: number): boolean {
  const line = lines[i]!;
  const prev = lines[i - 1];
  return prev !== undefined && prev.from === line.from && prev.verified === line.verified && prev.streamer === line.streamer;
}

function rowNode(lines: readonly ChatLine[], i: number, ctx: RowCtx): ReactNode {
  const line = lines[i]!;
  const mine = line.from === ctx.myName && (ctx.asStreamer ? line.streamer : ctx.me ? line.verified : !line.verified && !line.streamer);
  const place = placeOf(line.at, lines[i - 1]?.at, samePrev(lines, i));
  return (
    <ChatRow
      key={line.id}
      line={line}
      room={ctx.room}
      shape={ctx.shape}
      mine={mine}
      me={ctx.me}
      first={place.first}
      bucket={place.bucket}
      flashed={ctx.flash === line.id}
      replyColor={line.reply?.verified ? ctx.roleColor(line.reply.from) : undefined}
      replies={ctx.replies}
      reacts={ctx.reacts}
      jumps={ctx.jumps}
      lineMark={ctx.lineMark}
      lineActions={ctx.lineActions}
      lineMenu={ctx.lineMenu}
      lineSide={ctx.lineSide}
      bare={ctx.bare}
      firstInList={ctx.bare ? !ctx.hasHeader && i === 0 : undefined}
    />
  );
}

function rowTopPad(lines: readonly ChatLine[], i: number, shape: ChatStyle, hasHeader: boolean): string {
  if (!hasHeader && i === 0) return '0px';
  const line = lines[i]!;
  const place = placeOf(line.at, lines[i - 1]?.at, samePrev(lines, i));
  if (shape === 'log') return '0.25rem';
  if (shape === 'blocks') return place.first || line.reply ? '0.375rem' : '0.125rem';
  return place.bucket ? 'calc(1px + 0.25rem)' : '1px';
}

function useRowCtx(name: string, room: ChatRoom, extra: Pick<RowCtx, 'replies' | 'reacts' | 'jumps' | 'lineMark' | 'lineActions' | 'lineMenu' | 'lineSide' | 'bare' | 'hasHeader'>): RowCtx {
  const shape = useAtomValue(chatStyleAtom);
  const flash = useAtomValue(room.flashAtom);
  const asStreamer = useAtomValue(room.asStreamerAtom);
  const speaker = useAtomValue(chatSpeakerAtom);
  const me = useAtomValue(meAtom);
  const roleColor = useRoleColors(room);
  return { room, shape, flash, me, myName: asStreamer ? name : speaker, asStreamer, roleColor, ...extra };
}

export function RoomLines({
  name,
  room,
  lines,
  lineMark,
  lineActions,
  lineMenu,
  lineSide,
  replies = false,
  reacts = false,
  jumps = false
}: {
  name: string;
  room: ChatRoom;
  lines: readonly ChatLine[];
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  lineMenu?: (line: ChatLine) => LineMenuItem[];
  lineSide?: (line: ChatLine) => ReactNode;
  replies?: boolean;
  reacts?: boolean;
  jumps?: boolean;
}) {
  const ctx = useRowCtx(name, room, { replies, reacts, jumps, lineMark, lineActions, lineMenu, lineSide, bare: false, hasHeader: false });
  return <>{lines.map((_, i) => rowNode(lines, i, ctx))}</>;
}

function ChatLog({
  name,
  room,
  lines,
  header,
  scrollTick,
  lineMark,
  lineActions,
  lineMenu,
  lineSide,
  replies = false,
  reacts = false,
  jumps = false
}: {
  name: string;
  room: ChatRoom;
  lines: readonly ChatLine[];
  header: ReactNode;
  scrollTick: number;
  lineMark?: (line: ChatLine) => ReactNode;
  lineActions?: (line: ChatLine) => ReactNode;
  lineMenu?: (line: ChatLine) => LineMenuItem[];
  lineSide?: (line: ChatLine) => ReactNode;
  replies?: boolean;
  reacts?: boolean;
  jumps?: boolean;
}) {
  const hasHeader = header !== null && header !== undefined && header !== false;
  const ctx = useRowCtx(name, room, { replies, reacts, jumps, lineMark, lineActions, lineMenu, lineSide, bare: true, hasHeader });
  const vref = useRef<VirtuosoHandle | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const resizer = useRef<ResizeObserver | null>(null);
  const following = useRef(true);
  const anchorRef = useRef<{ id: string; top: number } | null>(null);

  const firstId = lines[0]?.id;
  const [pre, setPre] = useState({ firstId, restore: false });
  if (firstId !== pre.firstId) {
    const oldIdx = pre.firstId !== undefined ? lines.findIndex((l) => l.id === pre.firstId) : -1;
    setPre({ firstId, restore: oldIdx > 0 });
  }

  const components = useMemo(() => (hasHeader ? { Header: () => <>{header}</> } : {}), [hasHeader, header]);

  const toBottom = useCallback((behavior?: 'smooth') => {
    vref.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
  }, []);

  const repin = useCallback(() => {
    if (!following.current) return;
    let frame = 0;
    const pass = (left: number) => {
      toBottom();
      if (left > 0) frame = requestAnimationFrame(() => pass(left - 1));
    };
    frame = requestAnimationFrame(() => pass(4));
    return () => cancelAnimationFrame(frame);
  }, [toBottom]);

  const setScroller = useCallback(
    (el: HTMLElement | null) => {
      scroller.current = el;
      resizer.current?.disconnect();
      if (!el) return;
      resizer.current = new ResizeObserver(() => repin());
      resizer.current.observe(el);
    },
    [repin]
  );

  const onScroll = useCallback(
    (e: SyntheticEvent<HTMLElement>) => {
      const el = e.currentTarget;
      room.noteScroll(el.scrollTop);
      if (following.current) {
        anchorRef.current = null;
        return;
      }
      const top = el.getBoundingClientRect().top;
      for (const row of el.querySelectorAll('[data-id]')) {
        const dy = row.getBoundingClientRect().top - top;
        if (dy >= 0) {
          anchorRef.current = { id: row.getAttribute('data-id') ?? '', top: dy };
          return;
        }
      }
    },
    [room]
  );

  useLayoutEffect(() => {
    if (!pre.restore) return;
    const target = anchorRef.current;
    const el = scroller.current;
    if (!target || !el) return;
    let frame = 0;
    const fix = (passes: number) => {
      const row = el.querySelector(`[data-id="${CSS.escape(target.id)}"]`);
      if (row instanceof HTMLElement) {
        const off = row.getBoundingClientRect().top - el.getBoundingClientRect().top - target.top;
        if (Math.abs(off) > 0.5) el.scrollTop += off;
      }
      if (passes > 0) frame = requestAnimationFrame(() => fix(passes - 1));
    };
    frame = requestAnimationFrame(() => fix(3));
    return () => cancelAnimationFrame(frame);
  }, [pre]);

  useEffect(() => {
    const plan = room.takeScrollPlan();
    const v = vref.current;
    if (!v || !plan || plan === 'keep') return;
    if (plan === 'bottom') {
      following.current = true;
      requestAnimationFrame(() => toBottom());
    } else if (typeof plan === 'object') {
      const idx = lines.findIndex((l) => l.id === plan.id);
      if (idx >= 0) {
        following.current = false;
        v.scrollToIndex({ index: idx, align: 'center' });
      }
    }
  }, [room, lines, scrollTick, toBottom]);

  useEffect(() => () => resizer.current?.disconnect(), []);

  return (
    <Virtuoso
      ref={vref}
      scrollerRef={(el) => setScroller(el as HTMLElement | null)}
      style={{ height: '100%' }}
      data={lines as ChatLine[]}
      firstItemIndex={FIRST_INDEX}
      initialTopMostItemIndex={{ index: Math.max(0, lines.length - 1), align: 'end' }}
      followOutput={(atBottom) => (atBottom ? 'auto' : false)}
      atBottomStateChange={(atBottom) => {
        following.current = atBottom;
        room.setFollowing(atBottom);
      }}
      startReached={() => void room.loadOlder()}
      onScroll={onScroll}
      computeItemKey={(_, line) => line.id}
      increaseViewportBy={{ top: 900, bottom: 900 }}
      components={components}
      itemContent={(index) => {
        const i = index - FIRST_INDEX;
        return <div style={{ paddingTop: rowTopPad(lines, i, ctx.shape, hasHeader) }}>{rowNode(lines, i, ctx)}</div>;
      }}
    />
  );
}

export function ChatPanel({
  name,
  owner = null,
  embedded = false,
  guest = false,
  channel,
  onChannel,
  headerEnd,
  lineMark,
  lineActions,
  lineMenu,
  welcome = null,
  className
}: ChatPanelProps) {
  const server = channel !== undefined;
  const bar = useChatWindowBar();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLInputElement | null>(null);
  const sendKeepsFocus = useRef(false);
  const room = chatRoomFor(name, server);
  const lines = useAtomValue(room.visibleLinesAtom);
  const total = useAtomValue(room.linesAtom).length;
  const loaded = useAtomValue(room.loadedAtom);
  const hiddenBots = useAtomValue(room.hiddenBotLinesAtom);
  const shape = useAtomValue(chatStyleAtom);
  const count = useAtomValue(room.countAtom);
  const phase = useAtomValue(room.phaseAtom);
  const reader = useAtomValue(room.readerAtom);
  const draft = useAtomValue(room.draftAtom);
  const pictures = useAtomValue(room.picturesAtom);
  const video = useAtomValue(room.videoAtom);
  const sending = useAtomValue(room.sendingAtom);
  const takesVideos = server || STREAM_CHAT_VIDEO;
  const replyTo = useAtomValue(room.replyAtom);
  const replyColor = useRoleColors(room)(replyTo?.verified ? replyTo.from : '');
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
  const wait = useCountdown(useAtomValue(room.waitAtom));
  const aside = useAtomValue(room.guestAtom) && !guest;
  const emotes = useEmoteComplete({ value: draft, onChange: (next) => room.setDraft(next), input: textRef, id: 'chat-emotes' });
  const mentions = useMentionComplete({
    value: draft,
    onChange: (next) => room.setDraft(next),
    input: textRef,
    id: 'chat-mentions',
    emotes,
    ctx: server ? `chat:${name}/${channel}` : `chat:${name}`,
    first: server ? null : name,
    lines,
    hide: BOT_GROUP
  });

  useEffect(() => room.join(owner), [room, owner?.session, owner?.token, me]);

  useEffect(() => {
    if (!guest) return;
    room.setGuest(true);
    return () => room.setGuest(false);
  }, [room, guest]);

  useEffect(() => {
    if (channel !== undefined) room.showChannel(channel);
  }, [room, channel]);

  const open = () => room.open();

  useEffect(() => {
    if (replyTo) textRef.current?.focus();
  }, [replyTo]);

  function pickFiles(list: FileList | File[] | null) {
    const { pictures, videos } = splitFiles(list ? [...list] : []);
    if (fileRef.current) fileRef.current.value = '';
    const [first] = videos;
    if (first && !takesVideos) room.showNotice(STREAM_VIDEO_OFF, 5000);
    else if (first) room.addVideo(first, videos.length > 1);
    room.addPictures(pictures);
  }

  const needsNick = !owner && !me && (me === null || server) && (phase === 'off' || reader);
  const waiting = !loaded && total === 0;

  if (aside) {
    return (
      <aside
        id="chat"
        data-phase={phase}
        data-away=""
        className={embedded ? cn('flex flex-col', className) : panelClassName(cn('flex min-h-[320px] flex-col', className))}
      >
        {bar && (
          <header
            onPointerDown={bar.grip}
            title="drag to move"
            className={cn('flex cursor-move items-center justify-between gap-3 border-b border-primaryStroke bubble:border-transparent py-1.5 pl-3 pr-1 text-sm', CHAT_GRIP)}
          >
            <span className="truncate font-semibold">chat</span>
            <span className="flex items-center gap-1">
              {bar.clear}
              {bar.close}
            </span>
          </header>
        )}
        <p className="m-auto px-6 text-center text-textTertiary">the chat is out in your stream's window. it is back here when that closes.</p>
      </aside>
    );
  }

  return (
    <aside
      id="chat"
      data-phase={phase}
      data-room={room.key}
      className={embedded ? cn('relative flex flex-col', className) : panelClassName(cn('relative flex min-h-[320px] flex-col bubble:border-transparent', className))}
      onDragOver={needsNick ? undefined : dragFiles}
      onDrop={needsNick ? undefined : (e) => dropFiles(e, pickFiles)}
      onPaste={needsNick ? undefined : (e) => pasteFiles(e, pickFiles)}
    >
      {!embedded && (
        <header
          onPointerDown={bar?.grip}
          title={bar ? 'drag to move' : undefined}
          className={cn(
            'flex items-center justify-between gap-3 border-b border-primaryStroke px-3 py-1.5 text-sm bubble:border-transparent max-md:sr-only',
            bar && cn('cursor-move pr-1', CHAT_GRIP)
          )}
        >
          <span id={server ? 'channel' : undefined} className="truncate font-semibold">
            {server ? `#${channel}` : 'chat'}
          </span>
          <span className="flex min-w-0 items-center gap-3">
            {headerEnd}
            <span id="chat-count" className="sr-only">
              {count} here · {phase === 'open' ? 'live' : phase}
            </span>
            {bar && (
              <span className="flex items-center gap-1">
                {bar.clear}
                {bar.close}
              </span>
            )}
          </span>
        </header>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
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
            id="chat-lines"
            role="log"
            aria-live="polite"
            data-style={shape}
            className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1 text-sm', shape === 'bubbles' ? 'leading-tight' : 'leading-snug')}
          >
            {waiting && <ChatSkeleton shape={shape} />}
            {!waiting && lines.length === 0 && (
              <div className={cn('flex flex-col', shape === 'log' ? 'gap-1' : shape === 'bubbles' ? 'gap-px' : 'gap-0.5')}>
                {!server && welcome && <WelcomeLine key={room.key} welcome={welcome} />}
                <p className="text-textTertiary">{hiddenBots ? `only bots so far, ${hiddenBots} lines hidden.` : 'nothing yet. say something.'}</p>
              </div>
            )}
            {!waiting && lines.length > 0 && (
              <ChatLog
                name={name}
                room={room}
                lines={lines}
                scrollTick={scrollTick}
                header={!server && welcome ? <WelcomeLine key={room.key} welcome={welcome} /> : null}
                lineMark={lineMark}
                lineActions={lineActions}
                lineMenu={lineMenu}
                replies={!needsNick}
                reacts
                jumps
              />
            )}
          </div>
        </div>

        {results && (
          <SearchResults id="chat-results" label={resultsFor} count={results.length} onClose={() => room.clearResults()} className="absolute inset-0 text-sm">
            {results.map((line) => {
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
                  video={!!line.video}
                  onClick={() => {
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

      <footer className="border-t border-primaryStroke p-2 bubble:border-transparent bubble:md:p-[7px]">
        {needsNick ? (
          <div className={cn('relative flex flex-wrap gap-2', PILL)}>
            <ChatNotice notice={notice} onDismiss={() => room.showNotice('')} />
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
              className={cn(INPUT, 'h-[1.875rem] min-w-0 flex-1 text-sm max-md:h-11 max-md:text-[length:max(1rem,16px)]', IN_PILL)}
            />
            <Button id="chat-join" variant="primary" className={cn(INPUT_BUTTON, 'h-[1.875rem] text-sm')} disabled={!nickOk} onClick={open}>
              join
            </Button>
          </div>
        ) : (
          <>
            <label htmlFor="chat-text" className="sr-only">
              your message
            </label>
            {replyTo && (
              <div id="chat-replying" data-reply-to={replyTo.id} className="mb-1.5 flex items-center gap-2 border-l-2 border-primaryBlue bg-backgroundTertiary py-0.5 pl-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-textSecondary">
                  replying to{' '}
                  <span className={cn('font-semibold', !replyColor && 'text-textPrimary')} style={replyColor ? { color: replyColor } : undefined}>
                    {replyTo.from}
                  </span>
                  <span className="sr-only">: {quoteWords({ text: replyTo.text, images: replyTo.images.length, video: !!replyTo.video })}</span>
                </span>
                <Tooltip content="cancel reply">
                  <button
                    type="button"
                    id="chat-reply-cancel"
                    aria-label="cancel reply"
                    className="flex h-6 w-6 shrink-0 items-center justify-center text-textTertiary hover:text-textPrimary max-md:h-11 max-md:w-11"
                    onClick={() => {
                      room.setReply(null);
                      textRef.current?.focus();
                    }}
                  >
                    <RiCloseLine aria-hidden size={14} />
                  </button>
                </Tooltip>
              </div>
            )}
            {(pictures.length > 0 || video) && (
              <div id="chat-picture-preview" className="mb-2 flex flex-wrap gap-2">
                {video && <PendingVideo clip={video} sending={sending} onRemove={() => room.removeVideo()} />}
                {pictures.map((picture) => (
                  <PendingThumb key={picture.key} picture={picture} sending={sending} onRemove={() => room.removePicture(picture.key)} />
                ))}
              </div>
            )}
            <div className={cn('relative flex items-center gap-2', PILL)}>
              {emotes.list}
              {mentions.list}
              <button
                type="button"
                id="chat-picture"
                aria-label="attach"
                aria-disabled={pictures.length >= MAX_CHAT_IMAGES || undefined}
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-primaryStroke bg-background text-textSecondary transition-colors duration-100 focus-visible:border-primaryBlue focus-visible:outline-none bubble:focus-visible:border-primaryBlue',
                  IN_PILL,
                  pictures.length >= MAX_CHAT_IMAGES ? 'cursor-default opacity-40' : 'hover:bg-backgroundTertiary hover:text-textPrimary bubble:hover:bg-backgroundTertiary'
                )}
                onClick={() => (pictures.length >= MAX_CHAT_IMAGES ? room.showNotice(`${MAX_CHAT_IMAGES} pictures at most`) : fileRef.current?.click())}
              >
                <RiAddLine size={20} aria-hidden />
              </button>
              <input ref={fileRef} id="chat-picture-file" type="file" accept={takesVideos ? ATTACH_ACCEPT : PICTURE_ACCEPT} multiple className="hidden" onChange={(e) => pickFiles(e.target.files)} />
              <div className="relative flex min-w-0 flex-1">
                <ChatNotice notice={notice} onDismiss={() => room.showNotice('')} />
                <input
                  ref={textRef}
                  id="chat-text"
                  value={draft}
                  {...mentions.box}
                  onChange={(e) => {
                    room.setDraft(e.target.value);
                    mentions.box.onSelect(e);
                  }}
                  onKeyDown={(e) => {
                    if (mentions.box.onKeyDown(e)) return;
                    if (e.key === 'Escape' && replyTo) {
                      e.preventDefault();
                      e.stopPropagation();
                      room.setReply(null);
                      return;
                    }
                    if (!isSendKey(e)) return;
                    e.preventDefault();
                    void room.send();
                  }}
                  placeholder="comment"
                  aria-label={`comment as ${asStreamer ? name : speaker}`}
                  autoComplete="off"
                  className={cn(INPUT, 'h-8 min-w-0 flex-1 text-sm max-md:h-11 max-md:text-[length:max(1rem,16px)]', IN_PILL)}
                />
              </div>
              <Tooltip content={wait > 0 ? `${tier.words}. the next in ${waitWords(wait)}` : 'send'}>
                <Button
                  id="chat-send"
                  variant={wait > 0 ? 'danger' : 'primary'}
                  className={cn(
                    'h-8 shrink-0 py-0 text-sm tabular-nums max-md:h-11 max-md:text-[length:max(1rem,16px)]',
                    wait > 0 ? 'px-4 max-md:min-w-11' : 'w-8 px-0 max-md:w-11'
                  )}
                  aria-label={wait > 0 ? undefined : 'send'}
                  disabled={!canSend}
                  aria-busy={sending || undefined}
                  data-wait={wait > 0 ? wait : undefined}
                  onPointerDown={(e) => {
                    sendKeepsFocus.current = e.pointerType !== 'mouse' && document.activeElement === textRef.current;
                    keepFocus(e);
                  }}
                  onClick={() => {
                    void room.send();
                    if (sendKeepsFocus.current) textRef.current?.focus();
                    sendKeepsFocus.current = false;
                  }}
                >
                  {wait > 0 ? (
                    <span key={shake} className="inline-block motion-safe:animate-shake">
                      {waitWords(wait)}
                    </span>
                  ) : sending ? (
                    <span className="relative flex items-center">
                      <RiLoader4Line aria-hidden size={16} className="motion-safe:animate-spin" />
                      <span className="sr-only">sending</span>
                    </span>
                  ) : (
                    <RiArrowUpLine aria-hidden size={18} />
                  )}
                </Button>
              </Tooltip>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
