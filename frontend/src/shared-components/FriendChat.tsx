import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { closeDm, dmAtom } from '@/infra/atoms/dm-atoms';
import { panelSideAtom } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { panelClassName } from '@/shared-components/Panel';
import { Who } from '@/shared-components/PersonRow';
import { INPUT } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

interface Line {
  mine: boolean;
  text: string;
}

/** The one line a new window starts with: this is not a room, and nothing leaves the browser. */
const SEED: Line = { mine: false, text: 'not connected yet. what you type stays in this window.' };

/**
 * A direct chat with one friend, opened from the sidebar. The lines live in this window
 * for the visit and are never sent: there is no route for them yet. Closing it forgets nothing
 * until the name changes out from under a closed window; opening the same friend again shows
 * what was typed.
 */
export function FriendChat() {
  const dm = useAtomValue(dmAtom);
  const side = useAtomValue(panelSideAtom);
  const [threads, setThreads] = useState<Record<string, Line[]>>({});
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const name = dm?.name;
  const lines = (name && threads[name]) || [];

  useEffect(() => {
    if (!name) return;
    setDraft('');
    setThreads((prev) => (prev[name] ? prev : { ...prev, [name]: [SEED] }));
    input.current?.focus();
  }, [name]);

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, name]);

  if (!dm || !name) return null;

  function send(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!name || !text) return;
    setThreads((prev) => ({ ...prev, [name]: [...(prev[name] ?? [SEED]), { mine: true, text }] }));
    setDraft('');
  }

  return (
    <section
      id="friend-chat"
      role="dialog"
      aria-label={`chat with ${name}`}
      data-with={name}
      className={panelClassName(
        cn(
          'fixed bottom-6 z-50 flex max-h-[min(420px,70vh)] w-[min(320px,calc(100vw-3rem))] flex-col text-base',
          // just inside the page, clear of the open sidebar
          side === 'right' ? 'right-96' : 'left-96'
        )
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-primaryStroke px-2.5 py-2">
        <Face name={name} version={dm.avatar} className="h-8 w-8 text-sm" />
        <span className="min-w-0 flex-1">
          <Who name={name} verified={dm.verified} />
          <span className="block text-sm leading-tight text-textTertiary">not connected</span>
        </span>
        <button
          id="friend-chat-close"
          type="button"
          aria-label="close chat"
          title="close"
          onClick={closeDm}
          className="shrink-0 border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke hover:text-textPrimary focus-visible:border-primaryBlue focus-visible:outline-none"
        >
          <RiCloseLine aria-hidden size={16} />
        </button>
      </header>
      <div id="friend-chat-log" ref={log} className="flex min-h-[180px] flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        {lines.map((line, i) => (
          <p key={i} className={cn('text-sm leading-snug', line.mine ? 'text-right' : 'text-left')}>
            <span className="font-semibold">{line.mine ? 'you' : name}</span>
            <span className="mt-0.5 block text-textSecondary">{line.text}</span>
          </p>
        ))}
      </div>
      <form onSubmit={send} className="flex items-center gap-2 border-t border-primaryStroke p-2">
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
              closeDm();
            }
          }}
          placeholder={`message ${name}`}
          maxLength={500}
          autoComplete="off"
          className={cn(INPUT, 'py-1.5 text-sm')}
        />
        <Button id="friend-chat-send" type="submit" className="px-3 py-1.5 text-sm" disabled={!draft.trim()}>
          send
        </Button>
      </form>
    </section>
  );
}
