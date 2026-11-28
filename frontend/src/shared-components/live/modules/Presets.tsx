import { RiAddLine, RiEqualizerLine, RiPencilLine, type RemixiconComponentType } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { pickPreset, presetNoticeAtom, savePreset } from '@/infra/atoms/preset-atoms';
import { HOTKEY_PRESETS, liveDefaultAtom, livePresetAtom, type PresetId, presetName, renamePreset } from '@/infra/live-dock';
import { Button } from '@/shared-components/Button';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
import { NameEdit } from '@/shared-components/live/SourceSettings';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const PRESET_ICONS: Record<PresetId, RemixiconComponentType> = {
  default: RiEqualizerLine
};

const ROW =
  'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-card border px-1.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue';

const ROW_ICON = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-avatar';

const ROW_BUTTON =
  'absolute flex h-6 w-6 items-center justify-center rounded-control border border-transparent text-textTertiary focus-visible:border-primaryBlue focus-visible:outline-none';

export function PresetsModule({ strip = false }: { strip?: boolean }) {
  const current = useAtomValue(livePresetAtom);
  const saved = useAtomValue(liveDefaultAtom);
  const notice = useAtomValue(presetNoticeAtom);
  const [renaming, setRenaming] = useState(false);
  const ids: PresetId[] = [...HOTKEY_PRESETS];
  if (strip)
    return (
      <div role="group" aria-label="presets" className="flex flex-col items-center gap-1.5 border-b border-primaryStroke py-2">
        {ids.map((id, i) => {
          const Icon = PRESET_ICONS[id];
          const on = id === current;
          return (
            <Tooltip key={id} content={`${presetName(id, saved)} (${i + 1})`}>
              <button
                id={`live-preset-${id}`}
                type="button"
                aria-label={presetName(id, saved)}
                aria-pressed={on}
                onClick={() => void pickPreset(id)}
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
    <RailSection section="presets" id="live-presets" title="presets" className="px-3 py-2.5" bodyClassName="flex flex-col gap-1 pt-1">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {ids.map((id, i) => {
          const Icon = PRESET_ICONS[id];
          const on = id === current;
          return (
            <li key={id} className="group/preset relative flex items-center">
              {renaming ? (
                <div className={cn(ROW, on ? 'border-primaryBlue bg-primaryBlue/10' : 'border-transparent')}>
                  <span aria-hidden className={cn(ROW_ICON, on ? 'bg-primaryBlue text-background' : 'bg-backgroundTertiary text-textSecondary')}>
                    <Icon size={15} />
                  </span>
                  <NameEdit
                    id="live-preset-name"
                    label="preset name"
                    name={presetName(id, saved)}
                    onSave={(name) => {
                      renamePreset(name);
                      setRenaming(false);
                    }}
                    onCancel={() => setRenaming(false)}
                    className="mr-7"
                  />
                </div>
              ) : (
                <button
                  id={`live-preset-${id}`}
                  type="button"
                  aria-pressed={on}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => void pickPreset(id)}
                  className={cn(ROW, on ? 'border-primaryBlue bg-primaryBlue/10' : 'border-transparent hover:bg-backgroundTertiary')}
                >
                  <span aria-hidden className={cn(ROW_ICON, on ? 'bg-primaryBlue text-background' : 'bg-backgroundTertiary text-textSecondary')}>
                    <Icon size={15} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate text-sm leading-tight', on ? 'font-semibold text-textPrimary' : 'text-textPrimary')}>{presetName(id, saved)}</span>
                  </span>
                  <span className="w-6 shrink-0" />
                  <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control border border-primaryStroke px-1 font-sans text-[11px] text-textTertiary">
                    {i + 1}
                  </kbd>
                </button>
              )}
              {!renaming && (
                <Tooltip content="rename">
                  <button
                    id="live-preset-rename"
                    type="button"
                    aria-label="rename"
                    onClick={() => setRenaming(true)}
                    className={cn(
                      ROW_BUTTON,
                      'right-8 opacity-0 transition-opacity duration-150 hover:border-primaryBlue hover:text-primaryBlue focus-visible:opacity-100 group-hover/preset:opacity-100 [@media(hover:none)]:opacity-100'
                    )}
                  >
                    <RiPencilLine aria-hidden size={14} />
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
      <Tooltip content="save these sources and levels as default">
        <Button id="live-preset-save" size="sm" variant="outline" className="mt-1 h-7 gap-1 self-start px-2.5 py-0 text-xs max-md:min-h-0" onClick={savePreset}>
          <RiAddLine aria-hidden size={14} />
          save current
        </Button>
      </Tooltip>
      {notice && (
        <p id="live-preset-notice" role="status" className="m-0 text-[11px] leading-tight text-textTertiary">
          {notice}
        </p>
      )}
    </RailSection>
  );
}
