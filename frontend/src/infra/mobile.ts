import { useSyncExternalStore } from 'react';
import { cn } from '@/utils/cn';

export const MOBILE_QUERY = '(max-width: 767.98px)';

function subscribe(changed: () => void): () => void {
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener('change', changed);
  return () => list.removeEventListener('change', changed);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
}

const STRIP_EASE = 'duration-200 ease-out motion-reduce:transition-none';

const PAGE_WIDTH = '(100vw - env(safe-area-inset-left) - env(safe-area-inset-right))';

const STRIP_SCALE = 0.4;

export function keyboardStrip(strip: boolean) {
  return {
    style: { height: `calc(${PAGE_WIDTH} * 9 / 16 * ${strip ? STRIP_SCALE : 1})` },
    box: `overflow-hidden bg-black transition-[height] ${STRIP_EASE}`,
    frame: cn(`origin-top transition-transform ${STRIP_EASE}`, strip && 'scale-[0.4]'),
    overlay: cn('transition-[opacity,transform,visibility] delay-0 duration-200 motion-reduce:transition-none', strip && 'pointer-events-none invisible opacity-0')
  };
}

export const CHAT_MOBILE =
  'min-h-0 border-0 bg-background [&>header]:px-3 [&_#chat-lines]:px-3 [&>footer]:px-3 [&>footer]:pt-2 [&>footer]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] group-data-[keyboard=true]/phone:[&>footer]:pb-2';
