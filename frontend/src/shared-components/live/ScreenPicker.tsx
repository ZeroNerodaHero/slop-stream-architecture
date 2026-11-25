import { RiCloseLine, RiComputerLine, RiWindowLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useEffect, useRef } from 'react';

import { answerScreen, type ScreenChoice, screenChoicesAtom } from '@/infra/desktop/screen-pick';
import { Button } from '@/shared-components/Button';
import { ICON_BUTTON } from '@/shared-components/live/Collapsible';
import { panelClassName } from '@/shared-components/Panel';
import { Tooltip } from '@/shared-components/Tooltip';
import { useStackedWindow } from '@/shared-components/useStackedWindow';

const LONG_NAME = 24;

function Card({ choice }: { choice: ScreenChoice }) {
  const Icon = choice.kind === 'window' ? RiWindowLine : RiComputerLine;
  const full = choice.app && choice.app !== choice.name ? `${choice.name} (${choice.app})` : choice.name;
  return (
    <Tooltip content={full.length > LONG_NAME ? full : null}>
      <Button
        id={`screen-pick-${choice.id}`}
        size="sm"
        aria-label={full}
        className="flex min-w-0 flex-col items-stretch gap-2 p-2 font-normal"
        onClick={() => answerScreen(choice)}
      >
        <span className="flex aspect-video w-full items-center justify-center overflow-hidden bg-backgroundTertiary">
          {choice.thumbnail ? (
            <img src={choice.thumbnail} alt="" className="h-full w-full object-contain" />
          ) : (
            <Icon aria-hidden size={24} className="text-textTertiary" />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-left">
          <Icon aria-hidden size={14} className="shrink-0 text-textTertiary" />
          <span className="truncate">{choice.name}</span>
        </span>
      </Button>
    </Tooltip>
  );
}

function Group({ title, choices }: { title: string; choices: ScreenChoice[] }) {
  if (choices.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-textTertiary">{title}</h3>
      <div className="grid grid-cols-3 gap-2">
        {choices.map((choice) => (
          <Card key={choice.id} choice={choice} />
        ))}
      </div>
    </section>
  );
}

export function ScreenPicker() {
  const choices = useAtomValue(screenChoicesAtom);
  const ref = useRef<HTMLElement | null>(null);
  const open = choices !== null;
  useStackedWindow(ref, 'screens', open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answerScreen(null);
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => () => answerScreen(null), []);

  if (!choices) return null;
  const screens = choices.filter((c) => c.kind === 'display');
  const windows = choices.filter((c) => c.kind === 'window');
  return (
    <section
      ref={ref}
      id="screen-picker"
      role="dialog"
      aria-labelledby="screen-picker-title"
      tabIndex={-1}
      className={panelClassName(
        'fixed left-1/2 top-1/2 flex max-h-[min(640px,calc(100dvh-4rem))] w-[min(720px,calc(100vw-2.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden text-textPrimary focus:outline-none'
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-primaryStroke px-3 py-2">
        <RiComputerLine aria-hidden size={16} className="shrink-0 text-textSecondary" />
        <h2 id="screen-picker-title" className="min-w-0 flex-1 truncate text-sm font-semibold">
          share a screen or a window
        </h2>
        <Tooltip content="close">
          <button id="screen-picker-close" type="button" aria-label="close" onClick={() => answerScreen(null)} className={ICON_BUTTON}>
            <RiCloseLine aria-hidden size={18} />
          </button>
        </Tooltip>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-3">
        {choices.length === 0 && <p className="text-sm text-textTertiary">nothing to share: no screen or window is open</p>}
        <Group title="screens" choices={screens} />
        <Group title="windows" choices={windows} />
      </div>
    </section>
  );
}
