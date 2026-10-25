import { RiRobot2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type KeyboardEvent, type UIEvent, useEffect, useLayoutEffect, useRef } from 'react';

import type { Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  MAX_CHAT_CHARS,
  chatAsStreamerAtom,
  chatCanSendAtom,
  chatCountAtom,
  chatDraftAtom,
  chatNoticeAtom,
  chatPhaseAtom,
  chatSpeakerAtom,
  chars,
  closeChat,
  hiddenBotLinesAtom,
  isBotLine,
  nickAtom,
  nickIsValidAtom,
  openChat,
  sendChat,
  setChatDraft,
  setNick,
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
  /** Inside another box (the corner player): no stroke, shadow or minimum height of its own. */
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
  // true while the view sits at the newest line. someone who scrolled up to read is left there.
  const stuck = useRef(true);
  const shown = useRef(0);
  const lines = useAtomValue(visibleChatLinesAtom);
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

  // The inputs that change while mounted: the owner (going live) and the login.
  // Nothing opens until /api/me has answered, so the first hello is the right one.
  useEffect(() => {
    if (me === undefined) return;
    openChat(name, owner);
    return () => closeChat();
  }, [name, owner?.session, owner?.token, me]);

  // Keep the newest line in view. A layout effect, not a store subscription: the store fires
  // before react has put the new lines in the dom, so measuring there sees the old height
  // (and on the history, the empty list). Here the lines are in, and nothing has painted yet.
  // The first history always lands at the bottom; after that only while the view is stuck there.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && (stuck.current || shown.current === 0)) el.scrollTop = el.scrollHeight;
    shown.current = lines.length;
  }, [lines]);

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STUCK_PX;
  }

  const left = MAX_CHAT_CHARS - chars(draft.trim());
  // the nick box stays until "join" actually opened the socket. a login never needs one.
  const needsNick = !owner && !me && phase === 'off';
  // the name the server echoes our own lines under: the stream's when we are the streamer, else the login or nick
  const myName = asStreamer ? name : speaker;

  return (
    <aside id="chat" className={embedded ? cn('flex flex-col', className) : panelClassName(cn('flex min-h-[320px] flex-col', className))}>
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

      <div ref={listRef} onScroll={onScroll} id="chat-lines" role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-base leading-snug">
        {lines.length === 0 && <p className="text-textTertiary">{hiddenBots ? `only bots so far, ${hiddenBots} lines hidden.` : 'nothing yet. say something.'}</p>}
        {lines.map((line) => {
          const mine = line.from === myName;
          return (
            <p
              key={line.id}
              data-streamer={line.streamer || undefined}
              data-verified={line.verified || undefined}
              data-bot={isBotLine(line) || undefined}
              data-groups={line.groups.length ? line.groups.map((g) => g.name).join(' ') : undefined}
              data-mine={mine || undefined}
              className="my-1 [overflow-wrap:anywhere]"
            >
              <span className={cn('font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue')}>{line.from}</span>
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
            <Button id="chat-join" variant="primary" className="px-4 py-2 text-base" disabled={!nickOk} onClick={() => openChat(name, owner)}>
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
              rows={2}
              placeholder={`say something as ${asStreamer ? name : speaker}`}
              className="w-full resize-none border border-primaryStroke bg-background px-3 py-2 text-base"
            />
            <div className="mt-2 flex items-center justify-between gap-2 text-sm">
              <span id="chat-notice" className="text-decrease" aria-live="polite">
                {notice}
              </span>
              <span className="flex items-center gap-3">
                <span id="chat-left" className={cn('text-textTertiary', left < 0 && 'font-semibold text-decrease')}>
                  {left}
                </span>
                <Button id="chat-send" variant="primary" className="px-4 py-2 text-base" disabled={!canSend} onClick={sendChat}>
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
