import { RiArrowLeftSLine } from '@remixicon/react';
import { atom, useAtomValue } from 'jotai';
import { useState } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, chatRoomFor } from '@/infra/atoms/chat-atoms';
import { profileForAtom, profileWelcomeAtom } from '@/infra/atoms/profile-atoms';
import { chatRoomAtom, ownerAtom } from '@/infra/atoms/publish-atoms';
import { livePanelsAtom, liveLockedAtom, type Place, setLivePanel, unreadAfter, unreadWords } from '@/infra/live-dock';
import { ChatModActions } from '@/shared-components/ChatMod';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { ChatSlot } from '@/shared-components/ChatSlot';
import { DockPanel } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { ChatIcon } from '@/shared-components/VideoControls';
import { cn } from '@/utils/cn';

const noLinesAtom = atom<ChatLine[]>([]);
const noLoadAtom = atom(false);

export function useUnread(name: string, shut: boolean): number {
  const room = name ? chatRoomFor(name) : null;
  const lines = useAtomValue(room?.linesAtom ?? noLinesAtom);
  const loaded = useAtomValue(room?.loadedAtom ?? noLoadAtom);
  const me = useAtomValue(meAtom);
  const [seen, setSeen] = useState<string | null>(null);
  if (!shut && seen !== null) setSeen(null);
  else if (shut && seen === null && (loaded || lines.length > 0)) setSeen(lines[lines.length - 1]?.id ?? '');
  return shut ? unreadAfter(lines, seen, me ?? null) : 0;
}

export function Unread({ count, id }: { count: number; id?: string }) {
  if (count <= 0) return null;
  return (
    <span id={id} className="min-w-5 rounded-control bg-primaryBlue px-1 text-center text-xs font-semibold normal-case leading-5 tracking-normal text-background">
      <span className="sr-only">, unread: </span>
      {unreadWords(count)}
    </span>
  );
}

export function ChatBody({ className, embedded = true }: { className: string; embedded?: boolean }) {
  const chatRoom = useAtomValue(chatRoomAtom);
  const owner = useAtomValue(ownerAtom);
  const me = useAtomValue(meAtom);
  const profileFor = useAtomValue(profileForAtom);
  const profileWelcome = useAtomValue(profileWelcomeAtom);
  const welcome = profileFor === chatRoom ? profileWelcome : null;
  if (!chatRoom)
    return (
      <aside id="chat" className={cn('flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-textTertiary', className)}>
        pick a name and the chat opens here. once you are live, your lines are marked.
      </aside>
    );
  return (
    <ChatPanel
      name={chatRoom}
      owner={owner}
      welcome={welcome}
      embedded={embedded}
      lineActions={me && me === chatRoom ? (line) => <ChatModActions name={chatRoom} line={line} me={me} /> : undefined}
      className={className}
    />
  );
}

export function ChatWindow() {
  return (
    <ChatSlot>
      <ChatBody className="h-full min-h-0 flex-1 border-0" embedded={false} />
    </ChatSlot>
  );
}

interface ChatModuleProps {
  place: Place;
  className?: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

export function ChatModule({ place, className = 'h-full min-h-0 flex-1', open: shown, onToggle }: ChatModuleProps) {
  const kept = useAtomValue(livePanelsAtom).chat;
  const open = shown ?? kept;
  const locked = useAtomValue(liveLockedAtom);
  const room = useAtomValue(chatRoomAtom);
  const unread = useUnread(room, place !== 'phone' && !open);
  const strip = (
    <Tooltip content="open the chat" at="left">
      <button
        id="live-chat-strip"
        type="button"
        aria-label={unread > 0 ? `open the chat, ${unread} unread` : 'open the chat'}
        aria-expanded={false}
        aria-controls="live-chat-body"
        disabled={locked}
        onClick={() => (onToggle ? onToggle(true) : setLivePanel('chat', true))}
        className="flex h-full w-full flex-col items-center gap-2 py-2 text-textSecondary transition-colors duration-150 hover:text-primaryBlue focus-visible:text-primaryBlue focus-visible:outline-none"
      >
        <RiArrowLeftSLine aria-hidden size={16} />
        <ChatIcon />
        <Unread count={unread} id="live-chat-unread" />
        <span aria-hidden className="text-xs font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
          chat
        </span>
      </button>
    </Tooltip>
  );
  return (
    <DockPanel tab="chat" place={place} open={shown} onToggle={onToggle} aside={!open && place !== 'side' ? <Unread id="live-chat-unread" count={unread} /> : undefined} strip={strip}>
      <ChatBody className={className} />
    </DockPanel>
  );
}
