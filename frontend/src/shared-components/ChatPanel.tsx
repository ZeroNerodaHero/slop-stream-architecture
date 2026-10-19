import { useAtomValue } from 'jotai';
import { type KeyboardEvent, useEffect, useRef } from 'react';

import type { Owner } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import {
  MAX_CHAT_CHARS,
  chatAsStreamerAtom,
  chatCanSendAtom,
  chatCountAtom,
  chatDraftAtom,
  chatLinesAtom,
  chatNoticeAtom,
  chatPhaseAtom,
  chatSpeakerAtom,
  chars,
  closeChat,
  nickAtom,
  nickIsValidAtom,
  openChat,
  sendChat,
  setChatDraft,
  setNick
} from '@/infra/atoms/chat-atoms';
import { store } from '@/infra/store';
import { Button } from '@/shared-components/Button';
import { cn } from '@/utils/cn';

interface ChatPanelProps {
  name: string;
  /** The streamer's own grant. With it, our lines are marked. */
  owner?: Owner | null;
  className?: string;
}

/** Enter sends, shift+enter is a new line. */
function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

/**
 * The chat next to the video. Lines newest at the bottom, a nick box until you
 * have one (or a login), a text box with a 500 countdown. Joins on mount, leaves
 * on unmount; a change of `owner` (going live, stopping) or of the login
 * reconnects through `openChat`.
 */
export function ChatPanel({ name, owner = null, className }: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const lines = useAtomValue(chatLinesAtom);
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

  // Keep the newest line in view. Imperative DOM at the data source, not a render effect.
  useEffect(() => {
    const scroll = () => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    scroll();
    return store.sub(chatLinesAtom, scroll);
  }, []);

  const left = MAX_CHAT_CHARS - chars(draft.trim());
  // the nick box stays until "join" actually opened the socket. a login never needs one.
  const needsNick = !owner && !me && phase === 'off';

  return (
    <aside id="chat" className={cn('flex min-h-[320px] flex-col rounded-xl border border-primaryStroke bg-backgroundSecondary', className)}>
      <header className="flex items-center justify-between border-b border-primaryStroke px-4 py-2 text-base">
        <span className="font-semibold">chat</span>
        <span id="chat-count" className="text-textSecondary">
          {count} here · {phase === 'open' ? 'live' : phase}
        </span>
      </header>

      <div ref={listRef} id="chat-lines" role="log" aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-2 text-base leading-snug">
        {lines.length === 0 && <p className="text-textTertiary">nothing yet. say something.</p>}
        {lines.map((line) => (
          <p key={line.id} data-streamer={line.streamer || undefined} data-verified={line.verified || undefined} className="my-1 [overflow-wrap:anywhere]">
            <span className={cn('font-semibold', line.streamer ? 'text-increase' : 'text-primaryBlue')}>{line.from}</span>
            {line.verified && (
              <span className="ml-0.5 text-increase" title="logged in as this name">
                ✓
              </span>
            )}
            {line.streamer && <span className="ml-1 rounded bg-increase/15 px-1 text-xs uppercase text-increase">streamer</span>}
            <span className="text-textSecondary">: </span>
            <span className="whitespace-pre-wrap">{line.text}</span>
          </p>
        ))}
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
              className="min-w-0 flex-1 rounded-lg border border-primaryStroke bg-background px-3 py-2 text-base"
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
              className="w-full resize-none rounded-lg border border-primaryStroke bg-background px-3 py-2 text-base"
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
