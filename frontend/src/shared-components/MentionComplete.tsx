import { useAtomValue } from 'jotai';
import { createElement, type KeyboardEvent, lazy, type ReactNode, type RefObject, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api, type Mention } from '@/infra/api';
import { meAtom } from '@/infra/atoms/auth-atoms';
import { mentionQueryAt } from '@/infra/mention-query';
import type { MentionLine } from '@/infra/mentions';
import { Avatar } from '@/shared-components/Avatar';
import type { EmoteCompleteBox, useEmoteComplete } from '@/shared-components/EmoteComplete';

const MentionList = lazy(() =>
  import('@/shared-components/MentionList').then((m) => ({ default: m.mentionList({ h: createElement, useState, useEffect, useLayoutEffect }) }))
);

export type MentionKeys = ((e: KeyboardEvent<HTMLInputElement>) => boolean) | null;

export interface MentionLink {
  cache: (room: string) => Map<string, Mention[]>;
  bind: (keys: MentionKeys, lit: number | null) => void;
}

export function useMentionComplete({
  value,
  onChange,
  input,
  id,
  emotes,
  ctx,
  first = null,
  lines = [],
  hide
}: {
  value: string;
  onChange: (next: string) => void;
  input: RefObject<HTMLInputElement | null>;
  id: string;
  emotes: ReturnType<typeof useEmoteComplete>;
  ctx: string | null;
  first?: Mention | string | null;
  lines?: readonly MentionLine[];
  hide?: string;
}): { box: EmoteCompleteBox; list: ReactNode } {
  const me = useAtomValue(meAtom);
  const keys = useRef<MentionKeys>(null);
  const cache = useRef<{ ctx: string; map: Map<string, Mention[]> } | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  const [link] = useState<MentionLink>(() => ({
    cache: (room: string) => {
      if (cache.current?.ctx !== room) cache.current = { ctx: room, map: new Map() };
      return cache.current.map;
    },
    bind: (fn: MentionKeys, rank: number | null) => {
      keys.current = fn;
      setLit(rank);
    }
  }));
  const caret = emotes.caret;
  const at = caret === null || emotes.open ? null : mentionQueryAt(value, caret);

  const box: EmoteCompleteBox =
    lit === null
      ? emotes.box
      : { ...emotes.box, onKeyDown: (e) => keys.current?.(e) ?? false, 'aria-expanded': true, 'aria-controls': id, 'aria-activedescendant': `${id}-${lit}` };

  const list = at && caret !== null && (
    <Suspense fallback={null}>
      <MentionList
        id={id}
        at={at}
        value={value}
        caret={caret}
        onChange={onChange}
        input={input}
        setCaret={emotes.setCaret}
        server={me ? ctx : null}
        me={me}
        first={first}
        lines={lines}
        hide={hide}
        search={api.mentions}
        face={(m) => <Avatar name={m.name} version={m.avatar} className="mr-0 h-6 w-6 border-0" />}
        link={link}
      />
    </Suspense>
  );

  return { box, list };
}
