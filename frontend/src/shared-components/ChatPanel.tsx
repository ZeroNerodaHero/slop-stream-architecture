import { RiArrowLeftSLine, RiArrowRightSLine, RiCloseLine, RiImageAddLine, RiRobot2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type UIEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api, messageOf, type Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  type ChatLine,
  addChatImage,
  backToLatest,
  chatAsStreamerAtom,
  chatBehindAtom,
  chatCanSendAtom,
  chatCountAtom,
  chatDraftAtom,
  chatImagesAtom,
  chatLinesAtom,
  chatNoticeAtom,
  chatPhaseAtom,
  chatPinnedAtom,
  chatResultsAtom,
  chatResultsForAtom,
  chatScrollAtom,
  chatSpeakerAtom,
  clearResults,
  closeChat,
  hiddenBotLinesAtom,
  isBotLine,
  loadOlder,
  MAX_CHAT_IMAGES,
  nickAtom,
  nickIsValidAtom,
  noteChatScroll,
  openChat,
  openLine,
  openServerChat,
  removeChatImage,
  searchRoom,
  sendChat,
  setChatDraft,
  setChatFollowing,
  setNick,
  showChannel,
  showNotice,
  showSpeaker,
  takeScrollPlan,
  visibleChatLinesAtom
} from '@/infra/atoms/chat-atoms';
import { chatFacesAtom, hideBotsAtom, setHideBots } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { LiveMark } from '@/shared-components/LiveMark';
import { panelClassName } from '@/shared-components/Panel';
import { Tooltip } from '@/shared-components/Tooltip';
import { compressChatImage } from '@/infra/picture';
import { cn } from '@/utils/cn';

/** Within this many px of the newest line counts as "at the bottom", so a one-line gap after a font swap does not unstick the view. */
const STUCK_PX = 40;

interface ChatPanelProps {
  /** A stream's room, or, with `channel`, the server. */
  name: string;
  /** The streamer's own grant. With it, our lines are marked. */
  owner?: Owner | null;
  /** Inside another box (the corner player): no stroke, shadow or minimum height of its own, and no header or search box, which a panel this small has no room for. The lines and the text box alone. */
  embedded?: boolean;
  /**
   * A group's channel: `name` is the server, this the channel on screen. One socket for every
   * channel of the server (`openServerChat`); a change of channel is `showChannel`, no socket
   * and no history. The header is the channel, and a line is a block (the face, the name
   * above the text) instead of one paragraph. The ids and the data attributes stay.
   */
  channel?: string;
  className?: string;
}

/** Enter sends. The enter that picks an ime candidate is not a send (safari says it with keyCode 229). */
function onKey(e: ReactKeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendChat();
  }
}

/**
 * The chat next to the video. Lines newest at the bottom, a nick box until you
 * have one (or a login), then one row: a picture, the text, send. Each line wears its
 * speaker's group badges, and starts with their face (a setting of this browser,
 * on unless the settings tab turned it off: the picture when the line is a login's
 * or the streamer's, the letter their name makes otherwise); the robot in the
 * header hides the bots' lines (a setting too, the settings tab has it as well). Joins on mount, leaves on
 * unmount; a change of `owner` (going live, stopping) or of the login reconnects
 * through `openChat`. One at a time: the chat atoms hold one room, and the ids
 * here are the ones the tests key on.
 */
/** Unix ms on the line, drawn as a clock. A line with no time says nothing. */
function saidAt(at: number): string {
  if (!at) return '';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Speaker({ line }: { line: ChatLine }) {
  const className = cn('cursor-pointer font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue');
  if (!line.verified) return <span className={cn('font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue')}>{line.from}</span>;
  return (
    <span
      role="button"
      tabIndex={0}
      data-from={line.from}
      title={`${line.from}'s lines`}
      onClick={() => void showSpeaker(line.from)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void showSpeaker(line.from);
        }
      }}
      className={className}
    >
      {line.from}
    </span>
  );
}

/** What stands after the name: the ✓, the group badges, the red broadcast mark for the streamer's own lines (the friends bar's, LiveMark.tsx; the word comes up at once on hover, Tooltip.tsx), `you` on ours. */
function Marks({ line, mine }: { line: ChatLine; mine: boolean }) {
  return (
    <>
      {line.verified && (
        <span className="text-increase" title="logged in as this name">
          ✓
        </span>
      )}
      {line.groups.map((group) => (
        <Badge key={group.name} group={group} />
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

function pictureSrc(id: string): string {
  return `/api/chat-images/${encodeURIComponent(id)}`;
}

/**
 * The pictures on a line, under the words. One is as tall as five lines; several sit in a row.
 * Pointing at one pops a larger one beside it. Several on the line get arrows to move through them.
 */
function ChatImages({ ids }: { ids: string[] }) {
  const thumbs = useRef<Array<HTMLButtonElement | null>>([]);
  const pop = useRef<HTMLDivElement | null>(null);
  const hide = useRef<number | null>(null);
  // `at` is the one the pointer is on, so the pop stays put. `view` is the one it shows.
  const [open, setOpen] = useState<{ at: number; view: number } | null>(null);
  const [sized, setSized] = useState(0);

  function stay() {
    if (hide.current) window.clearTimeout(hide.current);
  }
  function hideSoon() {
    stay();
    hide.current = window.setTimeout(() => {
      const box = pop.current;
      if (box && (box.matches(':hover') || box.contains(document.activeElement))) return;
      setOpen(null);
    }, 160);
  }
  function show(i: number) {
    stay();
    setOpen({ at: i, view: i });
  }
  function step(by: number) {
    stay();
    setOpen((cur) => (cur ? { ...cur, view: (cur.view + by + ids.length) % ids.length } : cur));
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') setOpen(null);
      if (ids.length < 2) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, ids.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = thumbs.current[open.at];
    const box = pop.current;
    if (!anchor || !box) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = box.getBoundingClientRect();
      const gap = 8;
      let left = a.left - gap - p.width;
      if (left < 8) left = Math.min(a.right + gap, window.innerWidth - 8 - p.width);
      let top = a.top + (a.height - p.height) / 2;
      top = Math.max(8, Math.min(top, window.innerHeight - 8 - p.height));
      box.style.left = `${Math.max(8, left)}px`;
      box.style.top = `${top}px`;
      box.style.visibility = 'visible';
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, sized]);

  if (ids.length === 0) return null;
  const many = ids.length > 1;
  const shown = open ? ids[open.view] : undefined;
  const host = open ? (thumbs.current[open.at]?.closest('dialog:modal') ?? document.body) : null;
  return (
    <span className="mt-1 flex max-w-full flex-wrap gap-1">
      {ids.map((id, i) => (
        <button
          key={id}
          type="button"
          ref={(el) => {
            thumbs.current[i] = el;
          }}
          className="block max-w-full"
          onMouseEnter={() => show(i)}
          onMouseLeave={hideSoon}
          onFocus={() => show(i)}
          onBlur={hideSoon}
        >
          <img src={pictureSrc(id)} alt="" className="max-h-[7.5rem] max-w-full object-contain" />
        </button>
      ))}
      {open &&
        host &&
        createPortal(
          <div
            id="chat-picture-pop"
            ref={pop}
            role="dialog"
            aria-label="picture"
            onMouseEnter={stay}
            onMouseLeave={hideSoon}
            className="invisible fixed left-0 top-0 z-[60] flex items-center border border-primaryStroke bg-background"
          >
            {many && (
              <button type="button" id="chat-picture-prev" aria-label="previous picture" className="px-1 text-textSecondary" onClick={() => step(-1)}>
                <RiArrowLeftSLine aria-hidden size={28} />
              </button>
            )}
            {shown && (
              <img
                src={pictureSrc(shown)}
                alt=""
                onLoad={() => setSized((n) => n + 1)}
                className="max-h-[70vh] max-w-[min(32rem,70vw)] object-contain"
              />
            )}
            {many && (
              <button type="button" id="chat-picture-next" aria-label="next picture" className="px-1 text-textSecondary" onClick={() => step(1)}>
                <RiArrowRightSLine aria-hidden size={28} />
              </button>
            )}
          </div>,
          host
        )}
    </span>
  );
}

function ServerLine({ line, mine, faces }: { line: ChatLine; mine: boolean; faces: boolean }) {
  return (
    <div
      data-id={line.id}
      data-streamer={line.streamer || undefined}
      data-verified={line.verified || undefined}
      data-bot={isBotLine(line) || undefined}
      data-groups={line.groups.length ? line.groups.map((g) => g.name).join(' ') : undefined}
      data-mine={mine || undefined}
      className="my-3 flex gap-3 [overflow-wrap:anywhere]"
    >
      {faces && <Face name={line.from} version={line.avatar} className="h-10 w-10 text-sm" />}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Speaker line={line} />
          <Marks line={line} mine={mine} />
          <time className="text-xs text-textTertiary" dateTime={line.at ? new Date(line.at).toISOString() : undefined}>
            {saidAt(line.at)}
          </time>
        </div>
        {line.text && <p className="mt-0.5 whitespace-pre-wrap">{line.text}</p>}
        <ChatImages ids={line.images} />
      </div>
    </div>
  );
}

export function ChatPanel({ name, owner = null, embedded = false, channel, className }: ChatPanelProps) {
  const server = channel !== undefined;
  const listRef = useRef<HTMLDivElement | null>(null);
  // height before the last paint, so prepending older lines can put the same pixels back
  const hold = useRef(0);
  // true while the view sits at the newest line. someone who scrolled up to read is left there.
  const stuck = useRef(true);
  const shown = useRef(0);
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lines = useAtomValue(visibleChatLinesAtom);
  const loaded = useAtomValue(chatLinesAtom).length;
  const hideBots = useAtomValue(hideBotsAtom);
  const hiddenBots = useAtomValue(hiddenBotLinesAtom);
  const faces = useAtomValue(chatFacesAtom);
  const count = useAtomValue(chatCountAtom);
  const phase = useAtomValue(chatPhaseAtom);
  const draft = useAtomValue(chatDraftAtom);
  const images = useAtomValue(chatImagesAtom);
  const notice = useAtomValue(chatNoticeAtom);
  const nick = useAtomValue(nickAtom);
  const nickOk = useAtomValue(nickIsValidAtom);
  const canSend = useAtomValue(chatCanSendAtom);
  const asStreamer = useAtomValue(chatAsStreamerAtom);
  const speaker = useAtomValue(chatSpeakerAtom);
  const me = useAtomValue(meAtom);
  const results = useAtomValue(chatResultsAtom);
  const resultsFor = useAtomValue(chatResultsForAtom);
  const pinned = useAtomValue(chatPinnedAtom);
  const behind = useAtomValue(chatBehindAtom);
  const scrollTick = useAtomValue(chatScrollAtom);

  // The inputs that change while mounted: the owner (going live) and the login.
  // Nothing opens until /api/me has answered, so the first hello is the right one.
  // A server is one socket for every channel: the channel is not one of these inputs.
  useEffect(() => {
    if (me === undefined) return;
    if (channel !== undefined) openServerChat(name, channel);
    else openChat(name, owner);
    return () => closeChat();
  }, [name, owner?.session, owner?.token, me, server]);

  // The channel on screen, for a server: a swap of what is shown, nothing opened or asked.
  useEffect(() => {
    if (channel !== undefined) showChannel(channel);
  }, [channel]);

  /** The nick box's join: the socket as this panel wants it. */
  const open = () => (channel !== undefined ? openServerChat(name, channel) : openChat(name, owner));

  // Keep the newest line in view, unless the reader has scrolled up, or a jump asked for one line.
  // A layout effect: the store fires before react has put the new lines in the dom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const plan = takeScrollPlan();
    if (plan === 'keep') {
      el.scrollTop += el.scrollHeight - hold.current;
    } else if (plan && typeof plan === 'object') {
      const node = el.querySelector(`[data-id="${CSS.escape(plan.id)}"]`);
      if (node instanceof HTMLElement) node.scrollIntoView({ block: 'center' });
      stuck.current = false;
      setChatFollowing(false);
    } else if (plan === 'bottom' || stuck.current || shown.current === 0) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true;
      setChatFollowing(true);
    }
    shown.current = lines.length;
    hold.current = el.scrollHeight;
  }, [lines, loaded, scrollTick]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
    stuck.current = atBottom;
    setChatFollowing(atBottom);
    noteChatScroll(el.scrollTop);
    if (el.scrollTop < 48) void loadOlder();
  }

  async function pickPictures(list: FileList | null) {
    const files = list ? [...list] : [];
    if (files.length === 0 || uploading) return;
    const room = MAX_CHAT_IMAGES - images.length;
    const batch = files.slice(0, Math.max(0, room));
    if (files.length > room) showNotice(`${MAX_CHAT_IMAGES} pictures at most`);
    if (batch.length === 0) return;
    setUploading(true);
    try {
      for (const file of batch) {
        const blob = await compressChatImage(file);
        const saved = await api.uploadChatImage(blob);
        addChatImage(saved.id);
      }
    } catch (err) {
      showNotice(messageOf(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    void searchRoom(query);
  }

  // the nick box stays until "join" actually opened the socket. a login never needs one.
  const needsNick = !owner && !me && phase === 'off';
  // the name the server echoes our own lines under: the stream's when we are the streamer, else the login or nick
  const myName = asStreamer ? name : speaker;

  return (
    <aside id="chat" data-phase={phase} className={embedded ? cn('flex flex-col', className) : panelClassName(cn('flex min-h-[320px] flex-col', className))}>
      {!embedded && (
        <header className="flex items-center justify-between gap-3 border-b border-primaryStroke px-4 py-2 text-base">
          <span id={server ? 'channel' : undefined} className="truncate font-semibold">
            {server ? `#${channel}` : 'chat'}
          </span>
          <span className="flex min-w-0 items-center gap-3">
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

      {!embedded && (
        <form id="chat-search-form" onSubmit={onSearch} className="flex gap-2 border-b border-primaryStroke px-3 py-2">
          <label htmlFor="chat-search" className="sr-only">
            search this room
          </label>
          <input
            id="chat-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search this room"
            autoComplete="off"
            className="min-w-0 flex-1 border border-primaryStroke bg-background px-2 py-1 text-sm"
          />
          <button id="chat-search-go" type="submit" disabled={!query.trim() || phase !== 'open'} className="shrink-0 text-sm font-semibold text-primaryBlue disabled:opacity-40">
            search
          </button>
        </form>
      )}

      {results && (
        <div id="chat-results" className="max-h-40 overflow-y-auto border-b border-primaryStroke px-3 py-1 text-sm">
          <div className="flex items-center justify-between gap-2 py-1 text-textTertiary">
            <span className="truncate">{resultsFor}</span>
            <button id="chat-results-close" type="button" onClick={clearResults} className="shrink-0 font-semibold text-textSecondary">
              close
            </button>
          </div>
          {results.length === 0 && (
            <p id="chat-results-empty" className="py-1 text-textTertiary">
              nothing
            </p>
          )}
          {results.map((line) => (
            <button key={line.id} type="button" data-id={line.id} onClick={() => void openLine(line.id)} className="block w-full truncate py-0.5 text-left [overflow-wrap:anywhere]">
              <span className="font-semibold text-primaryBlue">{line.from}</span>
              <span className="text-textSecondary">: {line.text}</span>
            </button>
          ))}
        </div>
      )}

      {pinned && (
        <button id="chat-latest" type="button" onClick={backToLatest} className="w-full border-b border-primaryStroke px-3 py-1 text-sm font-semibold text-primaryBlue">
          latest{behind > 0 ? ` · ${behind} new` : ''}
        </button>
      )}

      <div
        ref={listRef}
        onScroll={onScroll}
        id="chat-lines"
        role="log"
        aria-live="polite"
        data-faces={faces || undefined}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-base leading-snug"
      >
        {lines.length === 0 && <p className="text-textTertiary">{hiddenBots ? `only bots so far, ${hiddenBots} lines hidden.` : 'nothing yet. say something.'}</p>}
        {lines.map((line) => {
          const mine = line.from === myName;
          if (server) return <ServerLine key={line.id} line={line} mine={mine} faces={faces} />;
          return (
            <p
              key={line.id}
              data-id={line.id}
              data-streamer={line.streamer || undefined}
              data-verified={line.verified || undefined}
              data-bot={isBotLine(line) || undefined}
              data-groups={line.groups.length ? line.groups.map((g) => g.name).join(' ') : undefined}
              data-mine={mine || undefined}
              className="my-1 [overflow-wrap:anywhere]"
            >
              {/* the face: inline, one line tall, so the row stays one paragraph of text and a long line wraps under it */}
              {faces && <Face name={line.from} version={line.avatar} className="mr-1.5 inline-flex h-5 w-5 align-middle text-[11px]" />}
              <Speaker line={line} />
              <span className="ml-0.5 inline-flex items-center gap-1 align-middle">
                <Marks line={line} mine={mine} />
              </span>
              <span className="text-textSecondary">: </span>
              <span className="whitespace-pre-wrap">{line.text}</span>
              <ChatImages ids={line.images} />
            </p>
          );
        })}
      </div>

      <footer className="border-t border-primaryStroke p-3">
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
              placeholder="pick a nick"
              maxLength={24}
              autoComplete="off"
              className="min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base"
            />
            <Button id="chat-join" variant="primary" flat className="px-4 py-2 text-base" disabled={!nickOk} onClick={open}>
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
                    <img src={`/api/chat-images/${encodeURIComponent(id)}`} alt="" className="h-20 w-20 object-cover" />
                    <button
                      type="button"
                      aria-label="remove picture"
                      className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center bg-black/70 text-white"
                      onClick={() => removeChatImage(id)}
                    >
                      <RiCloseLine aria-hidden size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                id="chat-picture"
                aria-label="picture"
                title={images.length >= MAX_CHAT_IMAGES ? `${MAX_CHAT_IMAGES} pictures at most` : 'picture'}
                className="flex h-10 w-10 shrink-0 items-center justify-center text-textTertiary disabled:opacity-40"
                disabled={uploading || images.length >= MAX_CHAT_IMAGES}
                onClick={() => fileRef.current?.click()}
              >
                <RiImageAddLine size={20} aria-hidden />
              </button>
              <input
                ref={fileRef}
                id="chat-picture-file"
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => void pickPictures(e.target.files)}
              />
              <input
                id="chat-text"
                value={draft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={onKey}
                placeholder={`say something as ${asStreamer ? name : speaker}`}
                autoComplete="off"
                className="h-10 min-w-0 flex-1 border border-primaryStroke bg-background px-3 text-base"
              />
              <Button id="chat-send" variant="primary" flat className="h-10 shrink-0 px-4 text-base" disabled={!canSend} onClick={sendChat}>
                send
              </Button>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
