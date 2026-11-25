import { type RefObject, useLayoutEffect } from 'react';

import { dropWindow, raiseWindow, type StackId, stackZ, subscribeStack } from '@/infra/window-stack';

export function useStackedWindow(ref: RefObject<HTMLElement | null>, id: StackId, on = true) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const paint = () => {
      const z = String(stackZ(id));
      if (el.style.zIndex !== z) el.style.zIndex = z;
    };
    const front = () => raiseWindow(id);
    const unsubscribe = subscribeStack(paint);
    el.addEventListener('pointerdown', front, true);
    raiseWindow(id);
    paint();
    return () => {
      el.removeEventListener('pointerdown', front, true);
      unsubscribe();
      dropWindow(id);
      el.style.removeProperty('z-index');
    };
  }, [ref, id, on]);
}
