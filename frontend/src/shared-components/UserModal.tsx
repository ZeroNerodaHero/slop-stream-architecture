import {
  RiBarChart2Line,
  RiChat1Line,
  RiCloseLine,
  RiGroupLine,
  RiMicLine,
  RiNotification3Line,
  RiPaletteLine,
  RiShieldKeyholeLine,
  RiSideBarLine,
  RiToolsLine,
  RiUserLine
} from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { Fragment, type KeyboardEvent, lazy, type ReactNode, type RefObject, Suspense, useEffect, useLayoutEffect, useRef } from 'react';

import { meAtom } from '@/infra/atoms/auth-atoms';
import { myPresenceAtom, PRESENCE_WORD } from '@/infra/atoms/presence-atoms';
import { myAvatarVersionAtom, myNameAtom } from '@/infra/atoms/profile-atoms';
import { DEFAULT_TAB, type UserTab, closeUserModal, pickTab, tabsFor, userModalOpenAtom, userTabAtom } from '@/infra/atoms/user-modal-atoms';
import { useKeyboard } from '@/infra/keyboard';
import { useIsMobile } from '@/infra/mobile';
import { Face } from '@/shared-components/Face';
import { SHEET_CLOSE, useSheetBack } from '@/shared-components/MobileSheet';
import { PresenceSquare } from '@/shared-components/PresenceSquare';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';
import { TAB_OFF, TAB_ON } from '@/utils/tabs';

const TabBody = lazy(() => import('@/shared-components/user-modal/TabBody').then((m) => ({ default: m.TabBody })));

const TABS: Record<UserTab, { label: string; group: string; icon: ReactNode }> = {
  profile: { label: 'profile', group: 'you', icon: <RiUserLine aria-hidden size={18} /> },
  stats: { label: 'stats', group: 'you', icon: <RiBarChart2Line aria-hidden size={18} /> },
  groups: { label: 'groups', group: 'you', icon: <RiGroupLine aria-hidden size={18} /> },
  security: { label: 'security', group: 'you', icon: <RiShieldKeyholeLine aria-hidden size={18} /> },
  notifications: { label: 'notifications', group: 'you', icon: <RiNotification3Line aria-hidden size={18} /> },
  appearance: { label: 'appearance', group: 'this browser', icon: <RiPaletteLine aria-hidden size={18} /> },
  chat: { label: 'chat', group: 'this browser', icon: <RiChat1Line aria-hidden size={18} /> },
  voice: { label: 'voice', group: 'this browser', icon: <RiMicLine aria-hidden size={18} /> },
  sidebar: { label: 'sidebar', group: 'this browser', icon: <RiSideBarLine aria-hidden size={18} /> },
  advanced: { label: 'advanced', group: 'this browser', icon: <RiToolsLine aria-hidden size={18} /> }
};

const GROUP_LABEL = 'hidden px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-textTertiary first:pt-0 sm:block';
const SIDE_TAB = cn(
  'flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-sm font-semibold leading-tight transition-colors duration-150',
  'rounded-control border-b-2 sm:w-full sm:border-b-0 sm:border-l-2 bubble:border-transparent',
  'focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue'
);

const STEP: Record<string, number | undefined> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

function roveTabs(e: KeyboardEvent<HTMLDivElement>, order: readonly UserTab[]) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const step = STEP[e.key];
  const next = step !== undefined ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  const target = order[next];
  const button = tabs[next];
  if (next < 0 || !target || !button) return;
  e.preventDefault();
  pickTab(target);
  button.focus({ preventScroll: true });
}

export function UserModal() {
  const open = useAtomValue(userModalOpenAtom);
  return open ? <UserDialog /> : null;
}

function UserDialog() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pressedBackdrop = useRef(false);
  const kept = useAtomValue(userTabAtom);
  const phone = useIsMobile();
  const tabs = tabsFor(phone);
  const tab = tabs.includes(kept) ? kept : DEFAULT_TAB;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const close = () => dialogRef.current?.close();
  useSheetBack(close);

  return (
    <dialog
      ref={dialogRef}
      id="user-modal"
      aria-labelledby={`panel-${tab}-title`}
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        closeUserModal();
      }}
      className={cn(
        'overflow-hidden bg-backgroundSecondary p-0 text-base text-textPrimary',
        'open:flex flex-col sm:flex-row',
        'm-0 h-dvh max-h-none w-full max-w-none border-0 max-md:mt-[var(--vvt,0px)] max-md:h-[var(--vvh,100dvh)]',
        'md:m-auto md:h-[min(680px,calc(100dvh-3rem))] md:w-[min(960px,calc(100vw-3rem))] md:rounded-panel md:border md:border-primaryStroke',
        'backdrop:bg-black/60 md:backdrop:backdrop-blur-sm'
      )}
    >
      <Rail tab={tab} tabs={tabs} phone={phone} />
      <Pane tab={tab} onClose={close} />
    </dialog>
  );
}

const HAND_MS = 400;

function useStripPlace(ref: RefObject<HTMLDivElement | null>, tab: UserTab, on: boolean) {
  const kept = useRef(0);
  const { height, keyboard } = useKeyboard();

  useEffect(() => {
    const strip = ref.current;
    if (!on || !strip) return;
    const open = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!open) return;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at !== open && strip.contains(at)) open.focus({ preventScroll: true });
    const pad = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
    const s = strip.getBoundingClientRect();
    const t = open.getBoundingClientRect();
    if (t.left < s.left + pad) strip.scrollLeft -= s.left + pad - t.left;
    else if (t.right > s.right - pad) strip.scrollLeft += t.right - (s.right - pad);
    kept.current = strip.scrollLeft;
  }, [ref, tab, on]);

  useEffect(() => {
    const strip = ref.current;
    if (!on || !strip) return;
    let touching = false;
    let at = 0;
    const down = () => {
      touching = true;
    };
    const up = () => {
      touching = false;
      at = performance.now();
    };
    const wheel = () => {
      at = performance.now();
    };
    const scrolled = () => {
      const now = performance.now();
      if (touching || now - at < HAND_MS) {
        if (!touching) at = now;
        kept.current = strip.scrollLeft;
      } else if (strip.scrollLeft !== kept.current) {
        strip.scrollLeft = kept.current;
      }
    };
    strip.addEventListener('touchstart', down, { passive: true });
    strip.addEventListener('touchend', up, { passive: true });
    strip.addEventListener('touchcancel', up, { passive: true });
    strip.addEventListener('wheel', wheel, { passive: true });
    strip.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      strip.removeEventListener('touchstart', down);
      strip.removeEventListener('touchend', up);
      strip.removeEventListener('touchcancel', up);
      strip.removeEventListener('wheel', wheel);
      strip.removeEventListener('scroll', scrolled);
    };
  }, [ref, on]);

  useLayoutEffect(() => {
    const strip = ref.current;
    if (on && strip && strip.scrollLeft !== kept.current) strip.scrollLeft = kept.current;
  }, [ref, on, height, keyboard]);
}

function Rail({ tab, tabs, phone }: { tab: UserTab; tabs: readonly UserTab[]; phone: boolean }) {
  const strip = useRef<HTMLDivElement | null>(null);
  useStripPlace(strip, tab, phone);
  const me = useAtomValue(meAtom);
  const name = useAtomValue(myNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  const presence = useAtomValue(myPresenceAtom);
  return (
    <div className="flex shrink-0 flex-col border-b border-primaryStroke bg-background sm:w-56 sm:border-b-0 sm:border-r bubble:border-transparent sm:bubble:m-2 sm:bubble:mr-0 sm:bubble:rounded-panel">
      <div className="hidden items-center gap-3 border-b border-primaryStroke px-3 py-3 bubble:border-transparent sm:flex">
        <span className="relative block shrink-0" title={name ? PRESENCE_WORD[presence] : undefined}>
          <Face name={name} version={avatar} className="h-9 w-9 text-base" />
          {name && <PresenceSquare id="modal-presence" status={presence} className="border-background" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-semibold leading-tight">{name || 'nobody yet'}</span>
          <span className={cn('block text-xs', me ? 'text-increase' : 'text-textTertiary')}>{me ? 'logged in ✓' : 'not logged in'}</span>
        </span>
      </div>

      <div
        ref={strip}
        id="user-tabs"
        role="tablist"
        aria-orientation="vertical"
        aria-label="sections"
        onKeyDown={(e) => roveTabs(e, tabs)}
        className="flex flex-row gap-1 overflow-x-auto p-2 max-sm:mr-12 sm:flex-col sm:gap-0 sm:overflow-visible"
      >
        {tabs.map((t, i) => {
          const { label, group, icon } = TABS[t];
          const on = t === tab;
          const before = tabs[i - 1];
          const newGroup = before === undefined || TABS[before].group !== group;
          return (
            <Fragment key={t}>
              {newGroup && (
                <span aria-hidden className={GROUP_LABEL}>
                  {group}
                </span>
              )}
              <button
                id={`tab-${t}`}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={on ? `panel-${t}` : undefined}
                tabIndex={on ? 0 : -1}
                onClick={() => pickTab(t)}
                className={cn(SIDE_TAB, on ? TAB_ON : TAB_OFF)}
              >
                {icon}
                {label}
              </button>
            </Fragment>
          );
        })}
      </div>

      <p className="mt-auto hidden px-3 py-2 text-[10px] text-textTertiary sm:block">
        <span className="select-all tabular-nums">build {__BUILD__.slice(0, 7)}</span>
      </p>
    </div>
  );
}

function Pane({ tab, onClose }: { tab: UserTab; onClose: () => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:relative">
      <div className="absolute right-3 top-3 z-10 max-sm:right-1 max-sm:top-px">
        <Tooltip content="close" at="left">
          <button
            id="user-modal-close"
            type="button"
            aria-label="close"
            aria-keyshortcuts="Escape"
            onClick={onClose}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-control border border-primaryStroke bg-backgroundSecondary text-textSecondary transition-colors duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-primaryBlue',
              SHEET_CLOSE
            )}
          >
            <RiCloseLine aria-hidden size={20} />
          </button>
        </Tooltip>
      </div>

      <div
        key={tab}
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable] sm:px-8 sm:py-5"
      >
        <div className="max-w-[760px]">
          <h2 id={`panel-${tab}-title`} className="mb-4 border-l-4 border-primaryBlue pl-3 pr-12 text-lg font-semibold leading-tight">
            {TABS[tab].label}
          </h2>
          <Suspense fallback={null}>
            <TabBody tab={tab} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
