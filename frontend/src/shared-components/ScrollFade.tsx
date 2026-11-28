import { type RefObject, useEffect, useState } from 'react';

import { cn } from '@/utils/cn';

const EDGE_SLOP = 2;
const FADE_PX = 16;
const SOLID = 'rgb(var(--chat-fade, var(--background-secondary)))';
const CLEAR = 'rgb(var(--chat-fade, var(--background-secondary)) / 0)';
const FADE = 'pointer-events-none absolute inset-x-0 h-4 transition-opacity duration-150';

interface Edges {
  top: number;
  bottom: number;
  atTop: boolean;
  atBottom: boolean;
}

const sameEdges = (a: Edges | null, b: Edges) => !!a && a.top === b.top && a.bottom === b.bottom && a.atTop === b.atTop && a.atBottom === b.atBottom;
const scrollerIn = (box: HTMLElement) => box.querySelector<HTMLElement>('[data-virtuoso-scroller]') ?? box;

export function useScrollEdges(target: RefObject<HTMLElement | null>): Edges | null {
  const [edges, setEdges] = useState<Edges | null>(null);
  useEffect(() => {
    const box = target.current;
    if (!box) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = scrollerIn(box);
      const next = {
        top: box.offsetTop,
        bottom: box.offsetTop + box.offsetHeight,
        atTop: el.scrollTop <= EDGE_SLOP,
        atBottom: el.scrollHeight - el.clientHeight - el.scrollTop <= EDGE_SLOP
      };
      setEdges((prev) => (sameEdges(prev, next) ? prev : next));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    box.addEventListener('scroll', soon, { capture: true, passive: true });
    const sizes = new ResizeObserver(soon);
    sizes.observe(box);
    const changes = new MutationObserver(soon);
    changes.observe(box, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      box.removeEventListener('scroll', soon, { capture: true });
      sizes.disconnect();
      changes.disconnect();
    };
  }, [target]);
  return edges;
}

export function ScrollFades({ target, off = false }: { target: RefObject<HTMLElement | null>; off?: boolean }) {
  const edges = useScrollEdges(target);
  if (!edges || off) return null;
  return (
    <>
      <div
        aria-hidden
        data-scroll-fade="top"
        className={cn(FADE, edges.atTop && 'opacity-0')}
        style={{ top: edges.top, backgroundImage: `linear-gradient(to bottom, ${SOLID}, ${CLEAR})` }}
      />
      <div
        aria-hidden
        data-scroll-fade="bottom"
        className={cn(FADE, edges.atBottom && 'opacity-0')}
        style={{ top: edges.bottom - FADE_PX, backgroundImage: `linear-gradient(to top, ${SOLID}, ${CLEAR})` }}
      />
    </>
  );
}
