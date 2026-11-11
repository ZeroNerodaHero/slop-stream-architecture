import type { KeyboardEvent } from 'react';

const STEP: Record<string, number | undefined> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The keys of a `role="tablist"` whose tabs are buttons that open on a click: arrows move the
 * focus along the tabs and open the one landed on, Home and End go to the ends. The tablist's
 * `onKeyDown`. The watch page's tabs and the profile popup's; the user modal's do the same
 * from its own list of tabs.
 */
export function roveTabs(e: KeyboardEvent<HTMLElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const i = tabs.indexOf(e.target as HTMLButtonElement);
  if (i < 0) return;
  const step = STEP[e.key];
  const next = step !== undefined ? (i + step + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
  const button = tabs[next];
  if (next < 0 || !button) return;
  e.preventDefault();
  button.click();
  button.focus();
}
