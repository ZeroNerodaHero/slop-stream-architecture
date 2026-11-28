import { atom, useAtomValue } from 'jotai';
import { useState } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { type ChatLine, chatRoomFor } from '@/infra/atoms/chat-atoms';
import { profileForAtom, profileWelcomeAtom } from '@/infra/atoms/profile-atoms';
import { chatRoomAtom, ownerAtom } from '@/infra/atoms/publish-atoms';
import { type Place, unreadAfter, unreadWords } from '@/infra/live-dock';
import { ChatModActions } from '@/shared-components/ChatMod';
import { ChatPanel } from '@/shared-components/ChatPanel';
import { ChatSlot } from '@/shared-components/ChatSlot';
import { ChatSourcePicker } from '@/shared-components/ChatSource';
import { DockPanel } from '@/shared-components/live/Dock';
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

export function ChatBody({ className, embedded = true, sourcesAbove = false }: { className: string; embedded?: boolean; sourcesAbove?: boolean }) {
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
      sourcesAbove={sourcesAbove}
      lineActions={me && me === chatRoom ? (line) => <ChatModActions name={chatRoom} line={line} me={me} /> : undefined}
      embedMod={me && me === chatRoom ? () => true : undefined}
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

export function ChatModule({ place, className = 'h-full min-h-0 flex-1' }: { place: Place; className?: string }) {
  const chatRoom = useAtomValue(chatRoomAtom);
  const inHead = place !== 'phone';
  return (
    <DockPanel tab="chat" place={place} aside={inHead && chatRoom ? <ChatSourcePicker name={chatRoom} /> : undefined}>
      <ChatBody className={className} sourcesAbove={inHead} />
    </DockPanel>
  );
}
