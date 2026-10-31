import { RiExternalLinkLine, RiEyeOffLine, RiRobot2Line, RiShieldCheckLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import type { ReactNode } from 'react';

import {
  type ChatSide,
  type PipChatPlace,
  chatFacesAtom,
  chatSideAtom,
  hideBotsAtom,
  linkWarningAtom,
  pipChatPlaceAtom,
  setChatFaces,
  setChatSide,
  setHideBots,
  setLinkWarning,
  setPipChatPlace
} from '@/infra/atoms/settings-atoms';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** The places the stream's chat can sit. The card's picture is the page. */
const CHAT_SIDE_OPTIONS: readonly { side: ChatSide; label: string; detail: string }[] = [
  { side: 'left', label: 'left of the stream', detail: 'a column on the left of the video. the chat button slides it shut' },
  { side: 'right', label: 'right of the stream', detail: 'a column on the right, the usual way. the chat button slides it shut' },
  { side: 'modal', label: 'in a window', detail: 'the video full width, the chat in a window you can move and close' }
];

/** The three places the corner player's chat can open. The card's picture is the player. */
const PIP_CHAT_OPTIONS: readonly { place: PipChatPlace; label: string; detail: string }[] = [
  { place: 'bottom', label: 'under the video', detail: 'the chat opens beneath the picture, and the player grows upward' },
  { place: 'left', label: 'left of the video', detail: 'a column on the left, as tall as the picture' },
  { place: 'right', label: 'right of the video', detail: 'a column on the right, as tall as the picture' }
];

/** The chat block in a miniature: the word, and two lines. */
function PreviewChat({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-h-0 flex-col gap-1 overflow-hidden bg-backgroundTertiary px-1.5 py-1', className)}>
      <span className="text-[10px] font-semibold uppercase leading-none tracking-wider text-textSecondary">chat</span>
      <span className="h-px w-4/5 bg-textTertiary" />
      <span className="h-px w-2/3 bg-primaryBlue" />
    </span>
  );
}

/** The watch page in miniature: the picture, and the chat in a column or in a window over it. */
function StreamChatPreview({ side }: { side: ChatSide }) {
  if (side === 'modal') {
    return (
      <span aria-hidden className="relative flex h-36 min-w-0 flex-1 items-center justify-center border border-primaryStroke bg-background p-2">
        <span className="absolute inset-2 bg-black" />
        <span className="relative flex h-[78%] w-[58%] flex-col border border-primaryStroke bg-backgroundSecondary">
          <PreviewChat className="min-h-0 flex-1" />
        </span>
      </span>
    );
  }
  return (
    <span aria-hidden className="flex h-36 min-w-0 flex-1 border border-primaryStroke bg-background p-2">
      <span className="flex min-h-0 w-full flex-row">
        {side === 'left' && <PreviewChat className="w-[42%] border-r border-primaryStroke" />}
        <span className="min-w-0 flex-1 bg-black" />
        {side === 'right' && <PreviewChat className="w-[42%] border-l border-primaryStroke" />}
      </span>
    </span>
  );
}

/**
 * The corner player in miniature, with its chat where this choice puts it. The picture is
 * 16:9 with a footer, the chat a column beside it or a strip under it, so the card shows
 * the arrangement and not just its name.
 */
function PipChatPreview({ place }: { place: PipChatPlace }) {
  const side = place === 'left' || place === 'right';
  return (
    <span aria-hidden className="flex h-36 min-w-0 flex-1 items-center justify-center border border-primaryStroke bg-background p-2">
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

/** The faces: before every name, or not. */
const FACE_OPTIONS: readonly { on: boolean; id: string; label: string; detail: string }[] = [
  {
    on: true,
    id: 'chat-faces-on',
    label: 'show the faces',
    detail: 'the picture before every name: a login\u2019s, or the streamer\u2019s. a name without one gets its letter'
  },
  { on: false, id: 'chat-faces-off', label: 'names only', detail: 'the name and the words alone. a little more room for the words' }
];

/** A link in a line: a word first, or the new tab at once. */
const LINK_OPTIONS: readonly { ask: boolean; id: string; label: string; detail: string; icon: ReactNode }[] = [
  {
    ask: true,
    id: 'links-ask',
    label: 'ask before leaving',
    detail: 'a link in a line opens in a new tab, after a word that says which site it goes to',
    icon: <RiShieldCheckLine aria-hidden size={28} />
  },
  {
    ask: false,
    id: 'links-open',
    label: 'open at once',
    detail: 'a link opens in a new tab with no word first. \u201cdon\u2019t ask again\u201d on the word is this same choice',
    icon: <RiExternalLinkLine aria-hidden size={28} />
  }
];

/** The three lines the faces cards draw: a name for the letter and its colour, a width for the words. */
const PREVIEW_LINES: readonly { name: string; words: string }[] = [
  { name: 'ann', words: 'w-3/5' },
  { name: 'bob', words: 'w-2/5' },
  { name: 'cy', words: 'w-1/2' }
];

/** The chat in miniature: three lines, each a face (or not), a name and some words. */
function FacesPreview({ on }: { on: boolean }) {
  return (
    <span aria-hidden className="flex h-24 min-w-0 flex-1 flex-col justify-center gap-2.5 border border-primaryStroke bg-background px-3">
      {PREVIEW_LINES.map(({ name, words }) => (
        <span key={name} className="flex items-center gap-1.5">
          {on && <GeneratedAvatar name={name} className="h-4 w-4 text-[9px]" />}
          <span className="h-1.5 w-8 shrink-0 bg-primaryBlue" />
          <span className={cn('h-1.5 bg-textTertiary', words)} />
        </span>
      ))}
    </span>
  );
}

/**
 * This browser's settings for the chat: where it sits on the watch page and the go live page,
 * where it opens on the corner player, whether the bots' lines show, whether the lines wear
 * faces, whether a link asks before it opens. The chat behind the modal follows every change
 * at once, so the cards are their own preview.
 */
export function ChatTab() {
  const chatSide = useAtomValue(chatSideAtom);
  const pipChat = useAtomValue(pipChatPlaceAtom);
  const hideBots = useAtomValue(hideBotsAtom);
  const faces = useAtomValue(chatFacesAtom);
  const linkWarning = useAtomValue(linkWarningAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>on the watch page</legend>
        <p className="mt-1 text-textSecondary">where the chat sits on the watch page and the go live page. each card is the page with the chat in that place.</p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CHAT_SIDE_OPTIONS.map(({ side, label, detail }) => (
            <OptionCard
              key={side}
              id={`chat-side-${side}`}
              name="chat-side"
              checked={side === chatSide}
              onChange={() => setChatSide(side)}
              picture={<StreamChatPreview side={side} />}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">
          kept in this browser. the page behind follows as you pick. on a narrow screen a column sits under the video. the chat button on the video closes it and opens
          it again.
        </p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>on the corner player</legend>
        <p className="mt-1 text-textSecondary">where the chat opens on the corner player, picture in picture. each card is the player with the chat in that place.</p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {PIP_CHAT_OPTIONS.map(({ place, label, detail }) => (
            <OptionCard
              key={place}
              id={`pip-chat-${place}`}
              name="pip-chat-place"
              checked={place === pipChat}
              onChange={() => setPipChatPlace(place)}
              picture={<PipChatPreview place={place} />}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. a player that is up follows as you pick.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>bots</legend>
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

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>faces</legend>
        <p className="mt-1 text-textSecondary">
          each line can start with its speaker's face: the picture a login or the streamer has on their page, else the letter their name makes, the same stand-in the
          lists use. a nick with no account always gets the letter.
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FACE_OPTIONS.map(({ on, id, label, detail }) => (
            <OptionCard
              key={id}
              id={id}
              name="chat-faces"
              checked={on === faces}
              onChange={() => setChatFaces(on)}
              picture={<FacesPreview on={on} />}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser, for every room. a chat that is open follows as you pick.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>links</legend>
        <p className="mt-1 text-textSecondary">
          a link somebody puts in a line is drawn as one and opens in a new tab. it goes where they said, not anywhere this site chose; so, first, a word that says which
          site that is.
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {LINK_OPTIONS.map(({ ask, id, label, detail, icon }) => (
            <OptionCard key={id} id={id} name="links" checked={ask === linkWarning} onChange={() => setLinkWarning(ask)} picture={icon} label={label} detail={detail} />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser, for every room and for direct messages.</p>
      </fieldset>
    </div>
  );
}
