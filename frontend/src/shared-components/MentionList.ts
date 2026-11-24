import type { createElement, ReactNode, RefObject, useEffect, useLayoutEffect, useState } from 'react';

import type { Mention } from '@/infra/api';
import {
  askMentions,
  cachedMentions,
  cacheMentions,
  localMentions,
  MENTION_LIMIT,
  type MentionLine,
  mentionRows,
  mergeMentions,
  moveMention,
  nearMentions
} from '@/infra/mentions';
import type { MentionLink } from '@/shared-components/MentionComplete';

const DEBOUNCE_MS = 150;

export interface MentionKit {
  h: typeof createElement;
  useState: typeof useState;
  useEffect: typeof useEffect;
  useLayoutEffect: typeof useLayoutEffect;
}

export interface MentionListProps {
  id: string;
  at: { start: number; query: string };
  value: string;
  caret: number;
  onChange: (next: string) => void;
  input: RefObject<HTMLInputElement | null>;
  setCaret: (caret: number | null) => void;
  server: string | null;
  me: string | null | undefined;
  first: Mention | string | null;
  lines: readonly MentionLine[];
  hide?: string;
  search: (ctx: string, q: string, limit: number, signal?: AbortSignal) => Promise<Mention[]>;
  face: (m: Mention) => ReactNode;
  link: MentionLink;
}

const hold = (e: { preventDefault: () => void }) => e.preventDefault();

export function mentionList({ h, useState, useEffect, useLayoutEffect }: MentionKit) {
  return function MentionList({ id, at, value, caret, onChange, input, setCaret, server, me, first, lines, hide, search, face, link }: MentionListProps) {
    const [sel, setSel] = useState({ key: '', at: 0 });
    const [shut, setShut] = useState('');
    const [, setGot] = useState(0);
    const query = at.query;
    const local = localMentions(lines, query, { first, me, hide });
    const map = server && askMentions(server, me, query, local.length) ? link.cache(server) : null;
    const known = map ? cachedMentions(map, query) : undefined;
    const asked = !map || known !== undefined;

    useEffect(() => {
      if (asked || !server || !map) return;
      const stop = new AbortController();
      const wait = setTimeout(() => {
        search(server, query, MENTION_LIMIT, stop.signal).then(
          (found) => {
            cacheMentions(map, query, found);
            setGot((n) => n + 1);
          },
          () => undefined
        );
      }, DEBOUNCE_MS);
      return () => {
        clearTimeout(wait);
        stop.abort();
      };
    }, [asked, server, query, map, search]);

    const fresh = known ?? (map ? nearMentions(map, query) : []);
    const found = mergeMentions(local, fresh);
    const key = `${at.start}:${query}`;
    const open = found.length > 0 && key !== shut;
    const lit = sel.key === key ? Math.min(sel.at, found.length - 1) : 0;

    function pick(m: Mention) {
      const word = `@${m.name} `;
      const to = at.start + word.length;
      onChange(value.slice(0, at.start) + word + value.slice(caret));
      setCaret(to);
      requestAnimationFrame(() => input.current?.setSelectionRange(to, to));
    }

    useLayoutEffect(() => {
      link.bind(
        (e) => {
          if (e.nativeEvent.isComposing) return false;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            setSel({ key, at: moveMention(lit, e.key, found.length) });
            return true;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            const m = found[lit];
            if (!m) return false;
            e.preventDefault();
            pick(m);
            return true;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setShut(key);
            return true;
          }
          return false;
        },
        open ? lit : null
      );
    });

    useLayoutEffect(() => () => link.bind(null, null), [link]);

    if (!open) return null;

    return h(
      'div',
      {
        id: `${id}-panel`,
        'data-mention-complete': true,
        onPointerDown: hold,
        onMouseDown: hold,
        className: 'absolute bottom-full left-0 right-0 z-30 mb-1 border border-primaryStroke bg-backgroundSecondary py-1 text-sm'
      },
      h('p', { className: 'px-2.5 pb-1 text-xs text-textTertiary' }, 'people matching ', h('span', { className: 'font-semibold text-textSecondary' }, '@', query)),
      h(
        'ul',
        { id, role: 'listbox', 'aria-label': 'people' },
        mentionRows(found.length).map((i) => {
          const m = found[i];
          if (!m) return null;
          return h(
            'li',
            {
              key: m.name,
              id: `${id}-${i}`,
              role: 'option',
              'aria-selected': i === lit,
              'data-mention-option': m.name,
              'data-rank': i + 1,
              onPointerEnter: () => setSel({ key, at: i }),
              onClick: () => pick(m),
              className: `flex cursor-pointer items-center gap-2.5 px-2.5 py-1 ${i === lit ? 'bg-primaryBlue/15 text-textPrimary' : 'text-textSecondary'}`
            },
            h('span', { className: 'flex h-6 w-6 shrink-0 bg-backgroundTertiary' }, face(m)),
            h('span', { className: 'min-w-0 flex-1 truncate font-semibold' }, m.name),
            h('span', { 'aria-hidden': true, className: 'shrink-0 text-xs tabular-nums text-textTertiary' }, i + 1)
          );
        })
      )
    );
  };
}
