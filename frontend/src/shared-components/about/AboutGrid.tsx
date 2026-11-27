import { type CSSProperties, type ReactNode, useLayoutEffect, useState } from 'react';

import { type AboutBlock, phoneColumns } from '@/infra/about-blocks';
import { cn } from '@/utils/cn';

export const PHONE_AT = 560;

export function useWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const check = () => setWidth(el.getBoundingClientRect().width);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

export function useNarrow(el: HTMLElement | null, at = PHONE_AT): boolean {
  const width = useWidth(el);
  return width > 0 && width < at;
}

export function cellStyle(b: AboutBlock, phone: boolean): CSSProperties {
  const n = phone ? Math.max(1, phoneColumns(b.phone)) : b.span;
  return { gridColumn: `span ${n} / span ${n}` };
}

export function shownOn(b: AboutBlock, phone: boolean): boolean {
  return !phone || b.phone !== 'hide';
}

export function GridFrame({ phone, children, className }: { phone: boolean; children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-2', phone ? 'grid-cols-2' : 'grid-cols-12', className)}>{children}</div>;
}
