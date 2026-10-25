import { RiEyeOffLine, RiLayoutBottomLine, RiLayoutRightLine, RiRobot2Line } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import { openInspector } from '@/infra/atoms/inspector-atoms';
import { type ChatSide, chatSideAtom, hideBotsAtom, inspectorEnabledAtom, setChatSide, setHideBots, setInspectorEnabled } from '@/infra/atoms/settings-atoms';
import { Button } from '@/shared-components/Button';
import { OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';

/** The two places the chat can be, as the pictures on the two cards. */
const CHAT_SIDE_OPTIONS: readonly { side: ChatSide; label: string; detail: string; icon: ReactNode }[] = [
  { side: 'right', label: 'right of the stream', detail: 'a column next to the video, the usual way', icon: <RiLayoutRightLine aria-hidden size={28} /> },
  { side: 'below', label: 'below the stream', detail: 'the video full width, the chat under it', icon: <RiLayoutBottomLine aria-hidden size={28} /> }
];

/** The bots' lines: on screen, or not. */
const BOT_OPTIONS: readonly { hide: boolean; id: string; label: string; detail: string; icon: ReactNode }[] = [
  {
    hide: false,
    id: 'bots-show',
    label: 'show the bots',
    detail: 'every line, the fake streams\u2019 chatters too. each wears a BOT badge',
    icon: <RiRobot2Line aria-hidden size={28} />
  },
  {
    hide: true,
    id: 'bots-hide',
    label: 'hide the bots',
    detail: 'their lines stay off the screen. the chat header says how many',
    icon: <RiEyeOffLine aria-hidden size={28} />
  }
];

/** This browser's settings for the pages. The page behind the modal follows every change at once, so the cards are their own preview. */
export function SettingsTab() {
  const chatSide = useAtomValue(chatSideAtom);
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  const hideBots = useAtomValue(hideBotsAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>layout</legend>
        <p className="mt-1 text-textSecondary">where the chat sits next to a stream, on the watch page and the go live page.</p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CHAT_SIDE_OPTIONS.map(({ side, label, detail, icon }) => (
            <OptionCard
              key={side}
              id={`chat-side-${side}`}
              name="chat-side"
              checked={side === chatSide}
              onChange={() => setChatSide(side)}
              picture={icon}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. the page behind follows as you pick.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>bots in chat</legend>
        <p className="mt-1 text-textSecondary">
          the fake streams have pretend chatters, there to show the chat works. their lines wear the <span className="font-semibold">bot</span> badge; the robot in the
          chat header is this same switch.
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {BOT_OPTIONS.map(({ hide, id, label, detail, icon }) => (
            <OptionCard key={id} id={id} name="bots" checked={hide === hideBots} onChange={() => setHideBots(hide)} picture={icon} label={label} detail={detail} />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser, for every room.</p>
      </fieldset>

      {/* the messages inspector (docs/status.md): the frames this browser gets, in the browser. a
          shared worker's socket does not show in a tab's devtools, and a phone has no devtools */}
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>debugging</legend>
        <p className="mt-1 text-textSecondary">the messages the pages send and get: the events socket, the chat, the video setup. the last 1000, with a filter.</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-base">
            <input
              id="inspector"
              type="checkbox"
              checked={inspectorOn}
              onChange={(e) => setInspectorEnabled(e.target.checked)}
              className="h-4 w-4 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue"
            />
            keep the messages
          </label>
          {inspectorOn && (
            <Button id="inspector-open-settings" className="px-4 py-2 text-base" onClick={openInspector}>
              open messages
            </Button>
          )}
        </div>
        <p className="mt-4 text-sm text-textTertiary">
          off, nothing is kept. on, a button sits beside the gear in the corner panel. tokens are taken out before anything is kept; nothing leaves the browser.
        </p>
      </fieldset>
    </div>
  );
}
