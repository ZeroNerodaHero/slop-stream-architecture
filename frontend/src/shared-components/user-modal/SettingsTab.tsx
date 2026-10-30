import { RiDraggable, RiEyeOffLine, RiGroupLine, RiRobot2Line, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from 'react';

import { openInspector } from '@/infra/atoms/inspector-atoms';
import {
  type ChatSide,
  type PanelSide,
  type PipChatPlace,
  type SidebarList,
  chatFacesAtom,
  chatSideAtom,
  hideBotsAtom,
  inspectorEnabledAtom,
  moveSidebarList,
  panelSideAtom,
  pipChatPlaceAtom,
  setChatFaces,
  setChatSide,
  setHideBots,
  setInspectorEnabled,
  setPanelSide,
  setPipChatPlace,
  setSidebarListOn,
  sidebarListsAtom
} from '@/infra/atoms/settings-atoms';
import { GeneratedAvatar } from '@/shared-components/GeneratedAvatar';
import { OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** A square to tick: the theme's box, blue when on. */
const CHECKBOX = 'h-4 w-4 shrink-0 appearance-none border border-primaryStroke bg-background checked:border-primaryBlue checked:bg-primaryBlue disabled:opacity-40';
/** A word that does something on a row: up, down. No box (the buttons rule). */
const ROW_WORD = 'text-sm font-semibold text-textSecondary hover:text-textPrimary disabled:text-textTertiary disabled:opacity-40 disabled:hover:text-textTertiary';

/** The places the stream's chat can sit. The card's picture is the page. */
const CHAT_SIDE_OPTIONS: readonly { side: ChatSide; label: string; detail: string }[] = [
  { side: 'left', label: 'left of the stream', detail: 'a column on the left of the video. the chat button slides it shut' },
  { side: 'right', label: 'right of the stream', detail: 'a column on the right, the usual way. the chat button slides it shut' },
  { side: 'modal', label: 'in a window', detail: 'the video full width, the chat in a window you can move and close' }
];

const PANEL_SIDE_OPTIONS: readonly { side: PanelSide; label: string; detail: string }[] = [
  { side: 'left', label: 'left of the page', detail: 'a column beside the streams. hover it and the names cover the page' },
  { side: 'right', label: 'right of the page', detail: 'the same column on the right. hover covers the streams; the picture in picture player stays above' }
];

/** The page in miniature: the open column covering the streams from one side. */
function YouPreview({ side }: { side: PanelSide }) {
  return (
    <span aria-hidden className="relative flex h-36 min-w-0 flex-1 border border-primaryStroke bg-background">
      <span className="m-2 min-w-0 flex-1 bg-backgroundTertiary" />
      <span
        className={cn(
          'absolute inset-y-0 z-10 flex w-14 flex-col items-center gap-1 bg-background py-1',
          side === 'right' ? 'right-0 border-l border-primaryStroke' : 'left-0 border-r border-primaryStroke'
        )}
      >
        <span className="h-3 w-3 bg-backgroundTertiary" />
        <span className="relative mt-auto h-4 w-4 bg-primaryBlue">
          <span className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 bg-increase" />
        </span>
      </span>
    </span>
  );
}

/** The column's three lists (Friends.tsx), each with the icon it stands under there and a line on what it holds. */
const SIDEBAR_LIST_WORDS: Record<SidebarList, { icon: typeof RiUserHeartLine; label: string; detail: string }> = {
  friends: { icon: RiUserHeartLine, label: 'friends', detail: 'who you follow that follows you back. the chat button is on this line' },
  following: { icon: RiUserFollowLine, label: 'following', detail: 'the rest of who you follow, streaming first' },
  groups: { icon: RiGroupLine, label: 'groups', detail: 'the groups you are in, and how many in each are live' }
};

/**
 * The column's lists, top to bottom, each with a switch (`settings.sidebarLists`). A row is
 * dragged by its handle (the arrow keys on the handle do the same, a row a press; `up` and
 * `down` are the words for it), and the column behind follows at once. The last switch on is
 * disabled: one list stays, so the column is never empty by setting.
 */
function SidebarLists() {
  const choices = useAtomValue(sidebarListsAtom);
  const shown = choices.filter((c) => c.on).length;
  const rows = useRef<HTMLUListElement | null>(null);
  const drag = useRef<{ list: SidebarList; y: number; from: number; pitch: number } | null>(null);
  const [dragging, setDragging] = useState<SidebarList | null>(null);

  function startDrag(e: PointerEvent<HTMLButtonElement>, list: SidebarList, from: number) {
    const items = rows.current ? Array.from(rows.current.children) : [];
    const first = items[0]?.getBoundingClientRect();
    const second = items[1]?.getBoundingClientRect();
    if (!first) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // a row and the gap after it: the distance between two rows' tops, or the one row's height when there is one
    drag.current = { list, y: e.clientY, from, pitch: second ? second.top - first.top : first.height };
    setDragging(list);
  }
  function moveDrag(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (d) moveSidebarList(d.list, d.from + Math.round((e.clientY - d.y) / d.pitch));
  }
  function endDrag() {
    drag.current = null;
    setDragging(null);
  }
  function keyMove(e: KeyboardEvent<HTMLButtonElement>, list: SidebarList, at: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveSidebarList(list, at + (e.key === 'ArrowUp' ? -1 : 1));
  }

  return (
    <ul id="sidebar-lists" ref={rows} className="flex flex-col gap-2">
      {choices.map(({ list, on }, i) => {
        const { icon: Icon, label, detail } = SIDEBAR_LIST_WORDS[list];
        const last = on && shown <= 1;
        return (
          <li
            key={list}
            id={`sidebar-list-${list}`}
            data-on={on}
            className={cn(
              'flex items-center gap-3 border bg-background p-3 transition-[border-color] duration-150',
              dragging === list ? 'border-primaryBlue' : 'border-primaryStroke',
              !on && 'text-textTertiary'
            )}
          >
            <button
              id={`sidebar-list-${list}-drag`}
              type="button"
              aria-label={`move ${label}: drag, or the arrow keys`}
              aria-keyshortcuts="ArrowUp ArrowDown"
              title="drag to move"
              onPointerDown={(e) => startDrag(e, list, i)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={(e) => keyMove(e, list, i)}
              className={cn(
                'shrink-0 touch-none select-none border border-transparent p-0.5 text-textTertiary hover:border-primaryStroke hover:text-textSecondary focus-visible:border-primaryBlue focus-visible:outline-none',
                dragging === list ? 'cursor-grabbing' : 'cursor-grab'
              )}
            >
              <RiDraggable aria-hidden size={18} />
            </button>
            <span className={cn('shrink-0', on ? 'text-primaryBlue' : 'text-textTertiary')}>
              <Icon aria-hidden size={24} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn('font-semibold leading-tight', on ? 'text-textPrimary' : 'text-textTertiary')}>{label}</span>
              <span className={cn('text-sm', on ? 'text-textSecondary' : 'text-textTertiary')}>{detail}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <button id={`sidebar-list-${list}-up`} type="button" disabled={i === 0} onClick={() => moveSidebarList(list, i - 1)} className={ROW_WORD}>
                up
              </button>
              <button
                id={`sidebar-list-${list}-down`}
                type="button"
                disabled={i === choices.length - 1}
                onClick={() => moveSidebarList(list, i + 1)}
                className={ROW_WORD}
              >
                down
              </button>
              <label
                className={cn('flex items-center gap-2 text-xs font-semibold uppercase tracking-wider', on ? 'text-primaryBlue' : 'text-textTertiary', last ? 'cursor-default' : 'cursor-pointer')}
                title={last ? 'one list stays' : undefined}
              >
                <input
                  id={`sidebar-list-${list}-on`}
                  type="checkbox"
                  checked={on}
                  disabled={last}
                  onChange={(e) => setSidebarListOn(list, e.target.checked)}
                  className={CHECKBOX}
                />
                {on ? 'shown' : 'hidden'}
              </label>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The three places the corner player's chat can open. The card's picture is the player. */
const PIP_CHAT_OPTIONS: readonly { place: PipChatPlace; label: string; detail: string }[] = [
  { place: 'bottom', label: 'under the video', detail: 'the chat opens beneath the picture, and the player grows upward' },
  { place: 'left', label: 'left of the video', detail: 'a column on the left, as tall as the picture' },
  { place: 'right', label: 'right of the video', detail: 'a column on the right, as tall as the picture' }
];

/** The chat block in the miniature player: the word, and two lines. */
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

/** This browser's settings for the pages. The page behind the modal follows every change at once, so the cards are their own preview. */
export function SettingsTab() {
  const chatSide = useAtomValue(chatSideAtom);
  const pipChat = useAtomValue(pipChatPlaceAtom);
  const panelSide = useAtomValue(panelSideAtom);
  const inspectorOn = useAtomValue(inspectorEnabledAtom);
  const hideBots = useAtomValue(hideBotsAtom);
  const faces = useAtomValue(chatFacesAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>layout</legend>
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
        <legend className={SECTION_TITLE}>you</legend>
        <p className="mt-1 text-textSecondary">
          which side of the page the column sits on. collapsed it is pictures and the streams stay put. hover widens it over the streams. each card is the page with the
          column there.
        </p>
        <div role="presentation" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PANEL_SIDE_OPTIONS.map(({ side, label, detail }) => (
            <OptionCard
              key={side}
              id={`panel-side-${side}`}
              name="panel-side"
              checked={side === panelSide}
              onChange={() => setPanelSide(side)}
              picture={<YouPreview side={side} />}
              label={label}
              detail={detail}
            />
          ))}
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. the corner follows as you pick.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>lists in the column</legend>
        <p className="mt-1 text-textSecondary">
          what the column shows under the search box, top to bottom: friends, the rest of who you follow, the groups you are in. drag a row to move it, or switch it off
          and the column skips it. one stays on.
        </p>
        <div className="mt-4">
          <SidebarLists />
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. the column follows as you pick; a list nobody is in is skipped anyway.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>picture in picture</legend>
        <p className="mt-1 text-textSecondary">where the chat opens on the corner player. each card is the player with the chat in that place.</p>
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

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>faces in chat</legend>
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
              className={CHECKBOX}
            />
            keep the messages
          </label>
          {inspectorOn && (
            <button id="inspector-open-settings" type="button" className="text-base font-semibold text-primaryBlue" onClick={openInspector}>
              open messages
            </button>
          )}
        </div>
        <p className="mt-4 text-sm text-textTertiary">
          off, nothing is kept. on, a button sits beside the gear in the corner panel. tokens are taken out before anything is kept; nothing leaves the browser.
        </p>
      </fieldset>
    </div>
  );
}
