import { RiDraggable, RiGroupLine, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';

import { type PanelSide, type SidebarList, moveSidebarList, panelSideAtom, setPanelSide, setSidebarListOn, sidebarListsAtom } from '@/infra/atoms/settings-atoms';
import { CHECKBOX, OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

/** A word that does something on a row: up, down. No box (the buttons rule). */
const ROW_WORD = 'text-sm font-semibold text-textSecondary hover:text-textPrimary disabled:text-textTertiary disabled:opacity-40 disabled:hover:text-textTertiary';

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
  const drag = useRef<{ pointerId: number; list: SidebarList; y: number; from: number; pitch: number } | null>(null);
  const [dragging, setDragging] = useState<SidebarList | null>(null);

  function startDrag(e: PointerEvent<HTMLButtonElement>, list: SidebarList, from: number) {
    // the primary button only, and one drag at a time: a second finger on another handle takes nothing over
    if (e.button !== 0 || drag.current) return;
    const ul = rows.current;
    const items = ul ? Array.from(ul.children) : [];
    const first = items[0]?.getBoundingClientRect();
    const second = items[1]?.getBoundingClientRect();
    if (!ul || !first) return;
    e.preventDefault();
    // the list holds the pointer, not the handle: a row dragged down is taken out of the document and put back
    // by the reorder, and the browser lets go of a node that leaves. the drag ends with the capture, whatever ends it
    ul.setPointerCapture(e.pointerId);
    // a row and the gap after it: the distance between two rows' tops, or the one row's height when there is one
    drag.current = { pointerId: e.pointerId, list, y: e.clientY, from, pitch: second ? second.top - first.top : first.height };
    setDragging(list);
  }
  function moveDrag(e: PointerEvent<HTMLUListElement>) {
    const d = drag.current;
    // the drag is the pointer's that began it: another finger resting on the list neither steers nor ends it
    if (!d || e.pointerId !== d.pointerId) return;
    moveSidebarList(d.list, d.from + Math.round((e.clientY - d.y) / d.pitch));
  }
  function endDrag(e: PointerEvent<HTMLUListElement>) {
    if (drag.current && e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    setDragging(null);
  }
  function keyMove(e: KeyboardEvent<HTMLButtonElement>, list: SidebarList, at: number) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    moveSidebarList(list, at + (e.key === 'ArrowUp' ? -1 : 1));
  }

  return (
    <ul
      id="sidebar-lists"
      ref={rows}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      className="flex flex-col gap-2"
    >
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
                className={cn(
                  'flex items-center gap-2 text-xs font-semibold uppercase tracking-wider',
                  on ? 'text-primaryBlue' : 'text-textTertiary',
                  last ? 'cursor-default' : 'cursor-pointer'
                )}
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

/**
 * This browser's settings for the column beside every page (Friends.tsx, docs/follows.md):
 * which side it sits on, and which of its lists it shows in what order. The column behind the
 * modal follows every change at once, so the cards are their own preview.
 */
export function SidebarTab() {
  const panelSide = useAtomValue(panelSideAtom);
  return (
    <div className="divide-y divide-primaryStroke">
      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>where it sits</legend>
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
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. the column follows as you pick.</p>
      </fieldset>

      <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
        <legend className={SECTION_TITLE}>its lists</legend>
        <p className="mt-1 text-textSecondary">
          what the column shows under the search box, top to bottom: friends, the rest of who you follow, the groups you are in. drag a row to move it, or switch it off
          and the column skips it. one stays on.
        </p>
        <div className="mt-4">
          <SidebarLists />
        </div>
        <p className="mt-4 text-sm text-textTertiary">kept in this browser. the column follows as you pick; a list nobody is in is skipped anyway.</p>
      </fieldset>
    </div>
  );
}
