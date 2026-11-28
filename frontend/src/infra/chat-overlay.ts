import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useEffect, useMemo } from 'react';

import { api, type ChatSources, type Owner } from '@/infra/api';
import { type ChatLine, chatRoomFor } from '@/infra/atoms/chat-atoms';
import { burnablePlatforms, type OverlayLine, overlayLinesOf } from '@/infra/chat-paint';
import { platformsOf } from '@/infra/chat-source';
import { plainEmotes } from '@/infra/emotes';
import { queryClient } from '@/infra/query-client';
import { store } from '@/infra/store';

const SOURCES_STALE_MS = 30_000;
const sourcesKey = (name: string) => ['chat-sources', name];

function allowedOf(data: ChatSources | undefined) {
  return burnablePlatforms(platformsOf(data?.sources), data?.external_chat);
}

export function useChatOverlay(name: string, owner: Owner | null, count: number): readonly OverlayLine[] {
  const room = chatRoomFor(name);
  useEffect(() => (name ? room.join(owner) : undefined), [room, name, owner?.session, owner?.token]);
  const lines = useAtomValue(room.linesAtom);
  const answer = useQuery({ queryKey: sourcesKey(name), queryFn: () => api.chatSources(name), enabled: !!name, staleTime: SOURCES_STALE_MS });
  const data = answer.data;
  return useMemo(() => (name ? overlayLinesOf(lines, allowedOf(data), count, plainEmotes) : []), [name, lines, data, count]);
}

interface Kept {
  lines: readonly ChatLine[];
  data: ChatSources | undefined;
  count: number;
  out: readonly OverlayLine[];
}

const kept = new Map<string, Kept>();

export function stageChatLines(name: string, count: number): readonly OverlayLine[] {
  if (!name) return [];
  const lines = store.get(chatRoomFor(name).linesAtom);
  const data = queryClient.getQueryData<ChatSources>(sourcesKey(name));
  const was = kept.get(name);
  if (was && was.lines === lines && was.data === data && was.count === count) return was.out;
  const out = overlayLinesOf(lines, allowedOf(data), count, plainEmotes);
  kept.set(name, { lines, data, count, out });
  return out;
}
