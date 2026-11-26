import { RiPhoneLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { acceptDmCall, declineDmCall, dmRingAtom } from '@/infra/atoms/dm-call-atoms';
import { useIsMobile } from '@/infra/mobile';
import { Button } from '@/shared-components/Button';
import { Face } from '@/shared-components/Face';
import { useStackedWindow } from '@/shared-components/useStackedWindow';
import { cn } from '@/utils/cn';

export function CallRing() {
  const ring = useAtomValue(dmRingAtom);
  const mobile = useIsMobile();
  const ref = useRef<HTMLElement | null>(null);

  useStackedWindow(ref, 'ring', ring !== null);

  if (!ring) return null;
  return createPortal(
    <section
      ref={ref}
      id="call-ring"
      role="alertdialog"
      aria-label={`${ring.from} is calling you`}
      aria-describedby="call-ring-word"
      data-call-id={ring.id}
      className={cn(
        'fixed flex items-center gap-3 rounded-panel border border-primaryStroke bg-backgroundSecondary p-3 text-sm',
        mobile ? 'inset-x-2 top-[calc(env(safe-area-inset-top)+0.5rem)]' : 'right-6 top-6 w-80'
      )}
    >
      <Face name={ring.from} version={ring.avatar} className="h-10 w-10 text-base" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span id="call-ring-name" className="truncate font-semibold text-textPrimary">
          {ring.from}
        </span>
        <span id="call-ring-word" className="flex items-center gap-1 text-xs text-textTertiary">
          <RiPhoneLine aria-hidden size={12} />
          calling you
        </span>
      </span>
      <Button id="call-ring-decline" size="sm" variant="outline-danger" onClick={declineDmCall}>
        decline
      </Button>
      <Button id="call-ring-accept" size="sm" variant="outline" onClick={() => void acceptDmCall()}>
        accept
      </Button>
    </section>,
    document.body
  );
}
