import { RiRobot2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, type KeyboardEvent, type UIEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  MAX_CHAT_CHARS,
  backToLatest,
  chatAsStreamerAtom,
  chatBehindAtom,
  chatCanSendAtom,
  chatCountAtom,
  chatDraftAtom,
  chatLinesAtom,
  chatNoticeAtom,
  chatPhaseAtom,
  chatPinnedAtom,
  chatResultsAtom,
  chatResultsForAtom,
  chatScrollAtom,
  chatSpeakerAtom,
  chars,
  clearResults,
  closeChat,
  hiddenBotLinesAtom,
  isBotLine,
  loadOlder,
  nickAtom,
  nickIsValidAtom,
  noteChatScroll,
  openChat,
  openLine,
  searchRoom,
  sendChat,
  setChatDraft,
  setChatFollowing,
  setNick,
  showSpeaker,
  takeScrollPlan,
  visibleChatLinesAtom
} from '@/infra/atoms/chat-atoms';
import { hideBotsAtom, setHideBots } from '@/infra/atoms/settings-atoms';
import { Badge } from '@/shared-components/Badge';
import { Button } from '@/shared-components/Button';
import { panelClassName } from '@/shared-components/Panel';
import { cn } from '@/utils/cn';

/** Within this many px of the newest line counts as "at the bottom", so a one-line gap after a font swap does not unstick the view. */
const STUCK_PX = 40;

interface ChatPanelProps {
  name: string;
  /** The streamer's own grant. With it, our lines are marked. */
  owner?: Owner | null;
  /** Inside another box (the corner player): no stroke, shadow or minimum height of its own, and no header or search box, which a panel this small has no room for. The lines and the text box alone. */
  embedded?: boolean;
  className?: string;
}

/** Enter sends, shift+enter is a new line. The enter that picks an ime candidate is neither (safari says it with keyCode 229). */
function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendChat();
  }
}

/**
 * The chat next to the video. Lines newest at the bottom, a nick box until you
 * have one (or a login), a text box with a 500 countdown. Each line wears its
 * speaker's group badges; the robot in the header hides the bots' lines (a setting
 * of this browser, the settings tab has it too). Joins on mount, leaves on
 * unmount; a change of `owner` (going live, stopping) or of the login reconnects
 * through `openChat`. One at a time: the chat atoms hold one room, and the ids
 * here are the ones the tests key on.
 */
export function ChatPanel({ name, owner = null, embedded = false, className }: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // height before the last paint, so prepending older lines can put the same pixels back
  const hold = useRef(0);
  // true while the view sits at the newest line. someone who scrolled up to read is left there.
  const stuck = useRef(true);
  const shown = useRef(0);
  const [query, setQuery] = useState('');
  const lines = useAtomValue(visibleChatLinesAtom);
  const loaded = useAtomValue(chatLinesAtom).length;
  const hideBots = useAtomValue(hideBotsAtom);
  const hiddenBots = useAtomValue(hiddenBotLinesAtom);
  const count = useAtomValue(chatCountAtom);
  const phase = useAtomValue(chatPhaseAtom);
  const draft = useAtomValue(chatDraftAtom);
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
  useEffect(() => {
    if (me === undefined) return;
    openChat(name, owner);
    return () => closeChat();
  }, [name, owner?.session, owner?.token, me]);

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

  function onSearch(e: FormEvent) {
    e.preventDefault();
    void searchRoom(query);
  }

  const left = MAX_CHAT_CHARS - chars(draft.trim());
  // the nick box stays until "join" actually opened the socket. a login never needs one.
  const needsNick = !owner && !me && phase === 'off';
  // the name the server echoes our own lines under: the stream's when we are the streamer, else the login or nick
  const myName = asStreamer ? name : speaker;

  return (
    <aside id="chat" data-phase={phase} className={embedded ? cn('flex flex-col', className) : panelClassName(cn('flex min-h-[320px] flex-col', className))}>
      {!embedded && (
        <header className="flex items-center justify-between gap-3 border-b border-primaryStroke px-4 py-2 text-base">
          <span className="font-semibold">chat</span>
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

      <div ref={listRef} onScroll={onScroll} id="chat-lines" role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-base leading-snug">
        {lines.length === 0 && <p className="text-textTertiary">{hiddenBots ? `only bots so far, ${hiddenBots} lines hidden.` : 'nothing yet. say something.'}</p>}
        {lines.map((line) => {
          const mine = line.from === myName;
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
              {line.verified ? (
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
                  className={cn('cursor-pointer font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue')}
                >
                  {line.from}
                </span>
              ) : (
                <span className={cn('font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue')}>{line.from}</span>
              )}
              {line.verified && (
                <span className="ml-0.5 text-increase" title="logged in as this name">
                  ✓
                </span>
              )}
              {line.groups.map((group) => (
                <Badge key={group.name} group={group} className="ml-1" />
              ))}
              {line.streamer && <span className="ml-1 bg-increase/15 px-1 text-xs uppercase text-increase">streamer</span>}
              {mine && <span className="ml-1 bg-primaryBlue/15 px-1 text-xs uppercase text-primaryBlue">you</span>}
              <span className="text-textSecondary">: </span>
              <span className="whitespace-pre-wrap">{line.text}</span>
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
                if (e.key === 'Enter' && nickOk) openChat(name, owner);
              }}
              placeholder="pick a nick"
              maxLength={24}
              autoComplete="off"
              className="min-w-0 flex-1 border border-primaryStroke bg-background px-3 py-2 text-base"
            />
            <Button id="chat-join" variant="primary" flat className="px-4 py-2 text-base" disabled={!nickOk} onClick={() => openChat(name, owner)}>
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
            <textarea
              id="chat-text"
              value={draft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              placeholder={`say something as ${asStreamer ? name : speaker}`}
              // block: an inline textarea sits on the text baseline and leaves descender space under itself, a gap on top of the margin
              className="block w-full resize-none border border-primaryStroke bg-background px-3 py-2 text-base"
            />
            <div className="mt-1 flex items-center justify-between gap-2 text-sm">
              <span id="chat-notice" className="text-decrease" aria-live="polite">
                {notice}
              </span>
              <span className="flex items-center gap-3">
                <span id="chat-left" className={cn('text-textTertiary', left < 0 && 'font-semibold text-decrease')}>
                  {left}
                </span>
                <Button id="chat-send" variant="primary" flat className="px-4 py-2 text-base" disabled={!canSend} onClick={sendChat}>
                  send
                </Button>
              </span>
            </div>
          </>
        )}
      </footer>
    </aside>
  );
}
