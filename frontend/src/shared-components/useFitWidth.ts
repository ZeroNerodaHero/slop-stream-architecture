import { useLayoutEffect, useRef, useState } from 'react';

const FIT_MIN = 240;

export function useFitWidth(on: boolean) {
  const cell = useRef<HTMLDivElement | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = cell.current;
    const main = box?.closest('main');
    if (!on || !box || !main) return;
    const measure = () => {
      const player = box.firstElementChild;
      if (!player) return;
      const end = tail.current ?? player;
      const top = box.getBoundingClientRect().top + window.scrollY;
      const below = end.getBoundingClientRect().bottom - player.getBoundingClientRect().bottom;
      const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      const room = document.documentElement.clientHeight - top - below - pad;
      const fit = Math.max(FIT_MIN, Math.floor((room * 16) / 9));
      setWidth(fit < box.clientWidth ? fit : null);
    };
    let frame = 0;
    const soon = () => {
      if (!frame)
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
    };
    measure();
    const watcher = new ResizeObserver(soon);
    watcher.observe(box);
    if (tail.current) watcher.observe(tail.current);
    const header = main.querySelector('header');
    if (header) watcher.observe(header);
    window.addEventListener('resize', soon);
    return () => {
      window.cancelAnimationFrame(frame);
      watcher.disconnect();
      window.removeEventListener('resize', soon);
    };
  }, [on]);
  return [cell, tail, on ? width : null] as const;
}
