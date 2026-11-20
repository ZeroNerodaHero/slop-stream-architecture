import { RiGroupLine, RiUserFollowLine, RiUserHeartLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { type PanelSide, type SidebarList, moveSidebarList, panelSideAtom, setPanelSide, setSidebarListOn, sidebarListsAtom } from '@/infra/atoms/settings-atoms';
import { useIsMobile } from '@/infra/mobile';
import { DragHandle, useReorder } from '@/shared-components/Reorderable';
import { CHECKBOX, OptionCard, SECTION_TITLE } from '@/shared-components/user-modal/parts';
import { cn } from '@/utils/cn';

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
  friends: { icon: RiUserHeartLine, label: 'friends', detail: 'who you follow that follows you back. each has a chat button, with what is new on it' },
  following: { icon: RiUserFollowLine, label: 'following', detail: 'the rest of who you follow, streaming first' },
  groups: { icon: RiGroupLine, label: 'groups', detail: 'the groups you are in, and how many in each are live' }
};

/**
 * The column's lists, top to bottom, each with a switch (`settings.sidebarLists`). A row is
 * dragged by its handle (Reorderable: space and the arrow keys on it do the same), and the
 * column behind follows at once. The last switch on is disabled: one list stays, so the
 * column is never empty by setting.
 */
function SidebarLists() {
  const choices = useAtomValue(sidebarListsAtom);
  const shown = choices.filter((c) => c.on).length;
  const byList = new Map(choices.map((c) => [c.list, c]));
  // live: the column behind the modal follows the row as it goes
  const reorder = useReorder({
    keys: choices.map((c) => c.list),
    name: (list) => SIDEBAR_LIST_WORDS[list].label,
    onMove: moveSidebarList,
    live: true
  });

  return (
    <div className="relative">
      <ul id="sidebar-lists" {...reorder.list} className="flex flex-col gap-2">
        {reorder.order.map((list) => {
          const on = byList.get(list)?.on ?? false;
          const { icon: Icon, label, detail } = SIDEBAR_LIST_WORDS[list];
          const last = on && shown <= 1;
          return (
            <li
              key={list}
              id={`sidebar-list-${list}`}
              data-on={on}
              {...reorder.item(list)}
              className={cn(
                'flex items-center gap-3 border bg-background p-3 transition-[border-color] duration-150',
                reorder.held === list ? 'border-primaryBlue' : 'border-primaryStroke',
                !on && 'text-textTertiary'
              )}
            >
              <DragHandle id={`sidebar-list-${list}-drag`} {...reorder.handle(list)} />
              <span className={cn('shrink-0', on ? 'text-primaryBlue' : 'text-textTertiary')}>
                <Icon aria-hidden size={24} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('font-semibold leading-tight', on ? 'text-textPrimary' : 'text-textTertiary')}>{label}</span>
                <span className={cn('text-sm', on ? 'text-textSecondary' : 'text-textTertiary')}>{detail}</span>
              </span>
              <label
                className={cn(
                  'flex shrink-0 items-center gap-2 text-xs font-semibold uppercase tracking-wider',
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
            </li>
          );
        })}
      </ul>
      {reorder.status}
    </div>
  );
}

/**
 * This browser's settings for the column beside every page (Friends.tsx, docs/follows.md):
 * which side it sits on, and which of its lists it shows in what order. The column behind the
 * modal follows every change at once, so the cards are their own preview.
 */
export function SidebarTab() {
  const panelSide = useAtomValue(panelSideAtom);
  // a phone's column is a drawer from the left (SwipeDrawer.tsx), whichever side is picked: only its lists apply there
  const mobile = useIsMobile();
  return (
    <div className="divide-y divide-primaryStroke">
      {!mobile && (
        <fieldset className="m-0 border-0 p-0 py-6 first:pt-0 last:pb-0">
          <legend className={SECTION_TITLE}>where it sits</legend>
          <p className="mt-1 text-textSecondary">
            which side of the page the column sits on. collapsed it is pictures and the streams stay put. hover widens it over the streams. each card is the page with
            the column there.
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
      )}

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
