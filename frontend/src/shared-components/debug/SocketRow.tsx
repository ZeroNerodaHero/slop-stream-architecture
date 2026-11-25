import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';

import { socketDetails, socketLine, SQUARE } from '@/infra/debug/socket-words';
import { socketList } from '@/infra/debug/sockets';
import { eventsTransportAtom } from '@/infra/events';
import { rtOn, rtTransportAtom } from '@/infra/rt/client';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const WAY = { worker: 'one socket for the browser', tab: 'a socket for this tab' } as const;

export function SocketRow() {
  const [now, setNow] = useState(() => Date.now());
  const events = useAtomValue(eventsTransportAtom);
  const rt = useAtomValue(rtTransportAtom);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const way: Record<string, string | null> = {
    events: rtOn ? `carried by rt${rt !== 'none' ? ` · ${WAY[rt]}` : ''}` : events !== 'none' ? WAY[events] : null,
    rt: rt !== 'none' ? WAY[rt] : null,
    chat: rtOn ? 'rooms are carried by rt' : null
  };
  return (
    <div id="inspector-sockets" className="flex flex-wrap gap-x-3 border-b border-primaryStroke px-3 py-1 font-mono text-[11px] leading-4">
      {socketList().map((s) => {
        const tip = [...socketDetails(s, now), way[s.name]].filter(Boolean);
        return (
          <Tooltip
            key={s.name}
            content={
              <span className="flex flex-col font-mono font-normal">
                {tip.map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            }
          >
            <span data-socket={s.name} data-state={s.state} tabIndex={0} className="flex items-center gap-1 focus-visible:outline-none">
              <span aria-hidden className={cn('h-2 w-2 shrink-0', SQUARE[s.state])} />
              <span className="text-textSecondary">{s.name}</span>
              <span className={s.state === 'error' ? 'text-decrease' : 'text-textTertiary'}>{socketLine(s, now)}</span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
