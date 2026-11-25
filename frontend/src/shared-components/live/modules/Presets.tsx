import { RiAddLine, RiChat3Line, RiCloseLine, RiEqualizerLine, type RemixiconComponentType, RiShieldLine, RiStackLine, RiStarLine, RiVidiconLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';

import { applyPreset, forgetMine, HOTKEY_PRESETS, liveMineAtom, livePresetAtom, type PresetId, PRESET_WORDS, saveMine } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const PRESET_ICONS: Record<PresetId, RemixiconComponentType> = {
  full: RiEqualizerLine,
  camera: RiVidiconLine,
  sources: RiStackLine,
  chat: RiChat3Line,
  safe: RiShieldLine,
  mine: RiStarLine
};

export function PresetsModule({ strip = false }: { strip?: boolean }) {
  const current = useAtomValue(livePresetAtom);
  const mine = useAtomValue(liveMineAtom);
  const ids: PresetId[] = mine ? [...HOTKEY_PRESETS, 'mine'] : [...HOTKEY_PRESETS];
  if (strip)
    return (
      <div role="group" aria-label="presets" className="flex flex-col items-center gap-1.5 border-b border-primaryStroke py-2">
        {ids.map((id, i) => {
          const Icon = PRESET_ICONS[id];
          const on = id === current;
          const key = id === 'mine' ? '' : ` (${i + 1})`;
          return (
            <Tooltip key={id} content={`${PRESET_WORDS[id].name}${key}`}>
              <button
                id={`live-preset-${id}`}
                type="button"
                aria-label={PRESET_WORDS[id].name}
                aria-pressed={on}
                onClick={() => applyPreset(id)}
                className={cn(FOLD_BUTTON, on ? 'border-primaryBlue text-primaryBlue' : 'border-transparent bg-transparent')}
              >
                <Icon aria-hidden size={16} />
              </button>
            </Tooltip>
          );
        })}
      </div>
    );
  return (
    <section id="live-presets" aria-labelledby="live-presets-title" className="flex flex-col gap-1 px-3 py-2.5">
      <h2 id="live-presets-title" className="flex h-6 items-center text-xs font-semibold uppercase tracking-wider text-textTertiary">
        presets
      </h2>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {ids.map((id, i) => {
          const Icon = PRESET_ICONS[id];
          const on = id === current;
          return (
            <li key={id} className="relative flex items-center">
              <button
                id={`live-preset-${id}`}
                type="button"
                aria-pressed={on}
                aria-keyshortcuts={id === 'mine' ? undefined : String(i + 1)}
                onClick={() => applyPreset(id)}
                className={cn(
                  'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-card border px-1.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue',
                  on ? 'border-primaryBlue bg-primaryBlue/10' : 'border-transparent hover:bg-backgroundTertiary'
                )}
              >
                <span
                  aria-hidden
                  className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-avatar', on ? 'bg-primaryBlue text-background' : 'bg-backgroundTertiary text-textSecondary')}
                >
                  <Icon size={15} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('truncate text-sm leading-tight', on ? 'font-semibold text-textPrimary' : 'text-textPrimary')}>{PRESET_WORDS[id].name}</span>
                  <span className="truncate text-[11px] leading-tight text-textTertiary">{PRESET_WORDS[id].what}</span>
                </span>
                {id !== 'mine' && (
                  <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control border border-primaryStroke px-1 font-sans text-[11px] text-textTertiary">
                    {i + 1}
                  </kbd>
                )}
                {id === 'mine' && <span className="w-6 shrink-0" />}
              </button>
              {id === 'mine' && (
                <Tooltip content="forget yours">
                  <button
                    id="live-preset-forget"
                    type="button"
                    aria-label="forget yours"
                    onClick={forgetMine}
                    className="absolute right-1.5 flex h-6 w-6 items-center justify-center rounded-control border border-transparent text-textTertiary hover:border-decrease hover:text-decrease focus-visible:border-primaryBlue focus-visible:outline-none"
                  >
                    <RiCloseLine aria-hidden size={14} />
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
      <Tooltip content="keep this layout and these folds as yours">
        <Button id="live-preset-save" size="sm" variant="outline" className="mt-1 h-7 gap-1 self-start px-2.5 py-0 text-xs max-md:min-h-0" onClick={saveMine}>
          <RiAddLine aria-hidden size={14} />
          save current
        </Button>
      </Tooltip>
    </section>
  );
}
