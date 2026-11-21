import { RiDeleteBinLine, RiForbidLine, RiTimerLine } from '@remixicon/react';
import { type ReactNode, useState } from 'react';

import { api, messageOf } from '@/infra/api';
import { type ChatLine, chatRoomFor } from '@/infra/atoms/chat-atoms';
import { BAR_BUTTON } from '@/shared-components/ChatLine';
import { ConfirmDialog } from '@/shared-components/ConfirmDialog';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

/** The timeout a line's button hands out. Longer, or shorter, from the mod tab's lists is not a thing yet: lift it and give another. */
export const LINE_TIMEOUT_SECS = 600;

type Ask = 'delete' | 'timeout' | 'ban';

/**
 * A janny's buttons on a stream chat's line (docs/jannies.md): delete, and for a login's line time
 * out (10 minutes) and ban, each after a yes. Not on the streamer's lines, nor on my own: the api
 * refuses anyone of my rank or above anyway, and says so under the box. A nick has no account to
 * ban, so their lines get the delete alone.
 */
export function ChatModActions({ name, line, me }: { name: string; line: ChatLine; me: string | null }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  if (line.streamer || (me !== null && line.verified && line.from === me)) return null;
  const room = chatRoomFor(name);
  const run = async (what: Ask) => {
    try {
      if (what === 'delete') {
        await api.deleteChatLine(name, line.id);
        // the room's `delete` frame says the same a moment later; gone from here now
        room.removeLine(line.id);
      } else if (what === 'timeout') {
        await api.timeoutInChat(name, line.from, LINE_TIMEOUT_SECS);
        room.showNotice(`${line.from} is timed out for 10 minutes`);
      } else {
        await api.banFromChat(name, line.from);
        room.showNotice(`${line.from} is banned from this chat`);
      }
    } catch (err) {
      room.showNotice(messageOf(err), 5000);
    }
  };
  const words: Record<Ask, { title: string; message: string; yes: string }> = {
    delete: { title: `delete ${line.from}'s line?`, message: 'it goes for everyone, for good. a copy stays in the mod log.', yes: 'yes, delete' },
    timeout: { title: `time out ${line.from}?`, message: 'no lines or reactions from them in this chat for 10 minutes.', yes: 'yes, time out' },
    ban: { title: `ban ${line.from}?`, message: 'no lines or reactions from them in this chat until the ban is lifted (the mod tab).', yes: 'yes, ban' }
  };
  const button = (what: Ask, label: string, icon: ReactNode) => (
    <Tooltip content={label}>
      <button type="button" aria-label={label} data-line-action={`mod-${what}`} onClick={() => setAsk(what)} className={cn(BAR_BUTTON, 'hover:text-decrease')}>
        {icon}
      </button>
    </Tooltip>
  );
  return (
    <>
      {button('delete', 'delete line', <RiDeleteBinLine aria-hidden size={14} />)}
      {line.verified && button('timeout', 'time out 10 minutes', <RiTimerLine aria-hidden size={14} />)}
      {line.verified && button('ban', 'ban from this chat', <RiForbidLine aria-hidden size={14} />)}
      {ask && (
        <ConfirmDialog
          id={`chat-mod-${ask}`}
          {...words[ask]}
          onYes={() => {
            const what = ask;
            setAsk(null);
            void run(what);
          }}
          onNo={() => setAsk(null)}
        />
      )}
    </>
  );
}
