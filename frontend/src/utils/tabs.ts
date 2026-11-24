import type { KeyboardEvent } from 'react';

const STEP: Record<string, number | undefined> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

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

export const TAB = '-mb-px border-b-2 px-3 py-1.5 font-semibold leading-tight transition-colors duration-150';
export const TAB_ON = 'border-primaryBlue bg-backgroundTertiary text-textPrimary';
export const TAB_OFF = 'border-transparent text-textSecondary hover:bg-backgroundTertiary/60 hover:text-textPrimary';
