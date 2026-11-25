import { RiArrowRightUpLine, RiExternalLinkLine, RiEyeOffLine, RiProfileLine, RiRobot2Line, RiShieldCheckLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import {
  type ChatSide,
  type ChatStyle,
  type PipChatPlace,
  chatSideAtom,
  chatStyleAtom,
  hideBotsAtom,
  linkWarningAtom,
  pipChatPlaceAtom,
  profilePopupEnabledAtom,
  setChatSide,
  setChatStyle,
  setHideBots,
  setLinkWarning,
  setPipChatPlace,
  setProfilePopupEnabled,
  setShowEmbeds,
  showEmbedsAtom
} from '@/infra/atoms/settings-atoms';
import { setShowWelcomes, showWelcomesAtom } from '@/infra/atoms/welcome-atoms';
import { useIsMobile } from '@/infra/mobile';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { CHECKBOX, FIELDSET, Info, OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

const CHAT_SIDE_OPTIONS: readonly { side: ChatSide; label: string }[] = [
  { side: 'left', label: 'left of the stream' },
  { side: 'right', label: 'right of the stream' },
  { side: 'modal', label: 'in a window' }
];

const PIP_CHAT_OPTIONS: readonly { place: PipChatPlace; label: string }[] = [
  { place: 'bottom', label: 'under the video' },
  { place: 'left', label: 'left of the video' },
  { place: 'right', label: 'right of the video' }
];

function PreviewChat({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-h-0 flex-col gap-1 overflow-hidden bg-backgroundTertiary px-1.5 py-1', className)}>
      <span className="text-[10px] font-semibold uppercase leading-none tracking-wider text-textSecondary">chat</span>
      <span className="h-px w-4/5 bg-textTertiary" />
      <span className="h-px w-2/3 bg-primaryBlue" />
    </span>
  );
}

function StreamChatPreview({ side }: { side: ChatSide }) {
  if (side === 'modal') {
    return (
      <span aria-hidden className="relative flex h-36 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-card border border-primaryStroke bg-background p-2">
        <span className="absolute inset-2 bg-black" />
        <span className="relative flex h-[78%] w-[58%] flex-col border border-primaryStroke soft:rounded-[4px] bubble:rounded-[8px] bg-backgroundSecondary">
          <PreviewChat className="min-h-0 flex-1" />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden className="flex h-36 min-w-0 flex-1 overflow-hidden rounded-card border border-primaryStroke bg-background p-2">
      <span className="flex min-h-0 w-full flex-row">
        {side === 'left' && <PreviewChat className="w-[42%] border-r border-primaryStroke" />}
        <span className="min-w-0 flex-1 bg-black" />
        {side === 'right' && <PreviewChat className="w-[42%] border-l border-primaryStroke" />}
      </span>
    </span>
  );
}

function PipChatPreview({ place }: { place: PipChatPlace }) {
  const side = place === 'left' || place === 'right';
  return (
    <span aria-hidden className="flex h-36 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-card border border-primaryStroke bg-background p-2">
      <span className={cn('flex max-h-full', side ? 'w-full flex-row' : 'w-[72%] flex-col')}>
        {place === 'left' && <PreviewChat className="w-[46%] border-r border-primaryStroke" />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="relative aspect-video bg-black">
            <span className="absolute bottom-1 left-1 h-1 w-3 bg-white" />
            <span className="absolute right-1 top-1 text-[9px] leading-none text-white">×</span>
          </span>
          <span className="flex items-center justify-between border-t border-primaryStroke bg-backgroundSecondary px-1 py-1">
            <span className="h-1 w-5 bg-textSecondary" />
            <span className="h-1 w-3 bg-increase" />
          </span>
        </span>
        {place === 'right' && <PreviewChat className="w-[46%] border-l border-primaryStroke" />}
        {place === 'bottom' && <PreviewChat className="h-10 shrink-0 border-t border-primaryStroke" />}
      </span>
    </span>
  );
}

const BOT_OPTIONS: readonly { hide: boolean; id: string; label: string; icon: ReactNode }[] = [
  {
    hide: false,
    id: 'bots-show',
    label: 'show the bots',
    icon: <RiRobot2Line aria-hidden size={28} />
  },
  {
    hide: true,
    id: 'bots-hide',
    label: 'hide the bots',
    icon: <RiEyeOffLine aria-hidden size={28} />
  }
];

const LINK_OPTIONS: readonly { ask: boolean; id: string; label: string; icon: ReactNode }[] = [
  {
    ask: true,
    id: 'links-ask',
    label: 'ask before leaving',
    icon: <RiShieldCheckLine aria-hidden size={28} />
  },
  {
    ask: false,
    id: 'links-open',
    label: 'open at once',
    icon: <RiExternalLinkLine aria-hidden size={28} />
  }
];

const PEOPLE_OPTIONS: readonly { popup: boolean; id: string; label: string; icon: ReactNode }[] = [
  {
    popup: true,
    id: 'people-popup',
    label: 'show them in a popup',
    icon: <RiProfileLine aria-hidden size={28} />
  },
  {
    popup: false,
    id: 'people-page',
    label: 'go to their page',
    icon: <RiArrowRightUpLine aria-hidden size={28} />
  }
];

const STYLE_OPTIONS: readonly { style: ChatStyle; label: string }[] = [
  { style: 'log', label: 'a log' },
  {
    style: 'bubbles',
    label: 'bubbles'
  },
  {
    style: 'blocks',
    label: 'blocks'
  }
];

const PREVIEW_LINES: readonly { mine: boolean; words: string }[] = [
  { mine: false, words: 'w-3/5' },
  { mine: true, words: 'w-2/5' },
  { mine: true, words: 'w-1/2' }
];

function PreviewClock({ shown = true }: { shown?: boolean }) {
  return <span className={cn('h-1 w-4 shrink-0', shown && 'bg-textTertiary')} />;
}

function PreviewName({ mine }: { mine: boolean }) {
  return <span className={cn('h-1.5 w-8 shrink-0', mine ? 'bg-primaryBlue' : 'bg-textSecondary')} />;
}

function StylePreview({ style }: { style: ChatStyle }) {
  if (style === 'bubbles') {
    return (
      <span aria-hidden className="flex h-24 min-w-0 flex-1 flex-col justify-center gap-1.5 overflow-hidden rounded-card border border-primaryStroke bg-background px-3">
        {PREVIEW_LINES.map(({ mine, words }, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <PreviewClock shown={PREVIEW_LINES[i - 1]?.mine !== mine} />
            <span className={cn('flex min-w-0 flex-1', mine ? 'justify-end' : 'justify-start')}>
              <span
                className={cn(
                  'flex h-5 items-center rounded-control border px-1.5',
                  words,
                  mine ? 'border-primaryBlue bg-primaryBlue/10' : 'border-primaryStroke bg-backgroundTertiary'
                )}
              >
                <span className="h-1.5 w-full bg-textTertiary" />
              </span>
            </span>
          </span>
        ))}
      </span>
    );
  }
  if (style === 'blocks') {
    return (
      <span aria-hidden className="flex h-24 min-w-0 flex-1 flex-col justify-center gap-1.5 overflow-hidden rounded-card border border-primaryStroke bg-background px-3">
        {PREVIEW_LINES.map(({ mine, words }, i) => {
          const first = PREVIEW_LINES[i - 1]?.mine !== mine;
          return (
            <span key={i} className="flex items-start gap-1.5">
              {first ? <GeneratedAvatar name={mine ? 'bob' : 'ann'} className="h-4 w-4 text-[9px]" /> : <span className="h-4 w-4 shrink-0" />}
              <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                {first && (
                  <span className="flex items-center gap-1.5">
                    <PreviewName mine={mine} />
                    <span className="h-1 w-4 bg-textTertiary" />
                  </span>
                )}
                <span className={cn('h-1.5 bg-textTertiary', words)} />
              </span>
            </span>
          );
        })}
      </span>
    );
  }
  return (
    <span aria-hidden className="flex h-24 min-w-0 flex-1 flex-col justify-center gap-2.5 overflow-hidden rounded-card border border-primaryStroke bg-background px-3">
      {PREVIEW_LINES.map(({ mine, words }, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <PreviewClock />
          <PreviewName mine={mine} />
          <span className={cn('h-1.5 bg-textTertiary', words)} />
        </span>
      ))}
    </span>
  );
}

export function ChatTab() {
  const chatSide = useAtomValue(chatSideAtom);
  const pipChat = useAtomValue(pipChatPlaceAtom);
  const hideBots = useAtomValue(hideBotsAtom);
  const chatStyle = useAtomValue(chatStyleAtom);
  const profilePopup = useAtomValue(profilePopupEnabledAtom);
  const linkWarning = useAtomValue(linkWarningAtom);
  const showWelcomes = useAtomValue(showWelcomesAtom);
  const showEmbeds = useAtomValue(showEmbedsAtom);
  const mobile = useIsMobile();
  return (
    <div className="divide-y divide-primaryStroke">
      {!mobile && (
        <fieldset className={FIELDSET}>
          <legend className={SECTION_TITLE}>on the watch page</legend>
          <div role="presentation" className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {CHAT_SIDE_OPTIONS.map(({ side, label }) => (
              <OptionCard
                key={side}
                id={`chat-side-${side}`}
                name="chat-side"
                checked={side === chatSide}
                onChange={() => setChatSide(side)}
                picture={<StreamChatPreview side={side} />}
                label={label}
              />
            ))}
          </div>
        </fieldset>
      )}

      {!mobile && (
        <fieldset className={FIELDSET}>
          <legend className={SECTION_TITLE}>on the corner player</legend>
          <div role="presentation" className="mt-2 grid grid-cols-3 gap-2 sm:gap-4">
            {PIP_CHAT_OPTIONS.map(({ place, label }) => (
              <OptionCard
                key={place}
                id={`pip-chat-${place}`}
                name="pip-chat-place"
                checked={place === pipChat}
                onChange={() => setPipChatPlace(place)}
                picture={
                  <span className="contents max-md:[&>span]:[zoom:0.6]">
                    <PipChatPreview place={place} />
                  </span>
                }
                compact
                label={label}
              />
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>the lines</legend>
        <div role="presentation" className="mt-2 grid grid-cols-3 gap-2 sm:gap-4">
          {STYLE_OPTIONS.map(({ style, label }) => (
            <OptionCard
              key={style}
              id={`chat-style-${style}`}
              name="chat-style"
              checked={style === chatStyle}
              onChange={() => setChatStyle(style)}
              picture={
                <span className="contents max-md:[&>span]:[zoom:0.6]">
                  <StylePreview style={style} />
                </span>
              }
              compact
              label={label}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>people</legend>
        <div role="presentation" className="mt-2 grid grid-cols-2 gap-2 sm:gap-4">
          {PEOPLE_OPTIONS.map(({ popup, id, label, icon }) => (
            <OptionCard
              key={id}
              id={id}
              name="people"
              checked={popup === profilePopup}
              onChange={() => setProfilePopupEnabled(popup)}
              compact
              picture={icon}
              label={label}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>links</legend>
        <div role="presentation" className="mt-2 grid grid-cols-2 gap-2 sm:gap-4">
          {LINK_OPTIONS.map(({ ask, id, label, icon }) => (
            <OptionCard key={id} id={id} name="links" checked={ask === linkWarning} onChange={() => setLinkWarning(ask)} picture={icon} label={label} compact />
          ))}
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>hide bots</legend>
        <div role="presentation" className="mt-2 grid grid-cols-2 gap-2 sm:gap-4">
          {BOT_OPTIONS.map(({ hide, id, label, icon }) => (
            <OptionCard key={id} id={id} name="bots" checked={hide === hideBots} onChange={() => setHideBots(hide)} picture={icon} label={label} compact />
          ))}
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>embeds</legend>
        <div className="flex items-center gap-2 py-1.5 text-sm font-semibold text-textPrimary">
          <input id="show-embeds" type="checkbox" checked={showEmbeds} onChange={(e) => setShowEmbeds(e.target.checked)} className={CHECKBOX} />
          <label htmlFor="show-embeds">show embeds</label>
          <Info tip="a player under a youtube, twitch, vimeo or video file link in a line. the player loads only when you press play" />
        </div>
      </fieldset>

      <fieldset className={FIELDSET}>
        <legend className={SECTION_TITLE}>welcome</legend>
        <div className="flex items-center gap-2 py-1.5 text-sm font-semibold text-textPrimary">
          <input id="show-welcomes" type="checkbox" checked={showWelcomes} onChange={(e) => setShowWelcomes(e.target.checked)} className={CHECKBOX} />
          <label htmlFor="show-welcomes">show welcome messages</label>
          <Info tip="the line Eques says when you open a stream's chat. hiding the bots hides it too" />
        </div>
      </fieldset>
    </div>
  );
}
