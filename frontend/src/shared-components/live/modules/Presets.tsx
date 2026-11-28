import { RiAddLine, RiCloseLine, RiPencilLine, RiSaveLine, RiStackLine, RiStarLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { myAvatarVersionAtom } from '@/infra/atoms/profile-atoms';
import { newPreset, pickPreset, presetDirtyAtom, presetNoticeAtom, presetsFullAtom, removePreset, saveActivePreset } from '@/infra/atoms/preset-atoms';
import { streamNameAtom } from '@/infra/atoms/publish-atoms';
import { DEFAULT_PRESET, livePresetAtom, livePresetsAtom, movePreset, openRailAt, PRESETS_MAX, type PresetId, presetName, renamePreset } from '@/infra/live-dock';
import { Face } from '@/shared-components/Face';
import { FOLD_BUTTON } from '@/shared-components/live/Dock';
import { RailSection } from '@/shared-components/live/RailSection';
import { NameEdit } from '@/shared-components/live/SourceSettings';
import { DragHandle, useReorder } from '@/shared-components/Reorderable';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

export const HOLD_MS = 300;

export function PresetIcon({ id, size, on = false, className }: { id: PresetId; size: number; on?: boolean; className?: string }) {
  const name = useAtomValue(streamNameAtom);
  const avatar = useAtomValue(myAvatarVersionAtom);
  if (id === DEFAULT_PRESET) return <Face name={name} version={avatar} className={cn('h-5 w-5 text-[10px]', on && 'border-primaryBlue', className)} />;
  return <RiStarLine aria-hidden size={size} className={className} />;
}

const ROW =
  'flex h-9 w-full min-w-0 flex-1 items-center gap-2.5 rounded-card border px-1.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primaryBlue';

const ROW_ICON = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-avatar';

const ROW_BUTTON =
  'absolute flex h-6 w-6 items-center justify-center rounded-control border border-transparent text-textTertiary focus-visible:border-primaryBlue focus-visible:outline-none';

const ON_HOVER = 'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/preset:opacity-100 [@media(hover:none)]:opacity-100';

const HEAD_BUTTON = cn(FOLD_BUTTON, 'relative h-6 w-6');

function RowIcon({ id, on }: { id: PresetId; on: boolean }) {
  if (id === DEFAULT_PRESET) return <PresetIcon id={id} size={15} on={on} className="h-6 w-6 text-[11px]" />;
  return (
    <span aria-hidden className={cn(ROW_ICON, on ? 'bg-primaryBlue text-background' : 'bg-backgroundTertiary text-textSecondary')}>
      <PresetIcon id={id} size={15} />
    </span>
  );
}

function HeaderButtons({ onNew }: { onNew: (id: PresetId) => void }) {
  const { list, active } = useAtomValue(livePresetsAtom);
  const full = useAtomValue(presetsFullAtom);
  const dirty = useAtomValue(presetDirtyAtom);
  const saveWords = `save to ${presetName(list.find((p) => p.id === active))}`;
  const newWords = full ? `${PRESETS_MAX} presets at most` : 'new preset';
  return (
    <>
      <Tooltip content={saveWords}>
        <button id="live-preset-save" type="button" aria-label={saveWords} onClick={saveActivePreset} className={HEAD_BUTTON}>
          <RiSaveLine aria-hidden size={14} />
          {dirty && <span id="live-preset-dirty" aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-avatar bg-primaryBlue" />}
        </button>
      </Tooltip>
      <Tooltip content={newWords}>
        <button
          id="live-preset-new"
          type="button"
          aria-label="new preset"
          aria-disabled={full || undefined}
          onClick={() => {
            if (full) return;
            const id = newPreset();
            if (id) onNew(id);
          }}
          className={cn(HEAD_BUTTON, full && 'opacity-50')}
        >
          <RiAddLine aria-hidden size={14} />
        </button>
      </Tooltip>
    </>
  );
}

export function PresetsModule({ strip = false }: { strip?: boolean }) {
  const current = useAtomValue(livePresetAtom);
  const { list } = useAtomValue(livePresetsAtom);
  const notice = useAtomValue(presetNoticeAtom);
  const [renaming, setRenaming] = useState<PresetId | null>(null);
  const reorder = useReorder({
    keys: list.map((p) => p.id),
    name: (id) => presetName(list.find((p) => p.id === id)),
    onMove: movePreset,
    hold: HOLD_MS
  });
  if (strip)
    return (
      <div className="flex flex-col items-center border-b border-primaryStroke py-2">
        <Tooltip content="presets">
          <button id="live-presets-mini" type="button" aria-label="open the presets" onClick={() => openRailAt('presets')} className={FOLD_BUTTON}>
            <RiStackLine aria-hidden size={16} />
          </button>
        </Tooltip>
      </div>
    );
  return (
    <RailSection
      section="presets"
      id="live-presets"
      title="presets"
      aside={<HeaderButtons onNew={setRenaming} />}
      className="px-3 py-2.5"
      bodyClassName="flex flex-col gap-1 pt-1"
    >
      <div className="relative">
        <ul id="live-preset-list" {...reorder.list} className={cn('m-0 flex list-none flex-col gap-0.5 p-0', reorder.held && 'cursor-grabbing')}>
          {reorder.order.map((id, i) => {
            const preset = list.find((p) => p.id === id);
            if (!preset) return null;
            const on = id === current;
            const held = reorder.held === id;
            return (
              <li
                key={id}
                {...reorder.item(id)}
                data-preset={id}
                className={cn('group/preset relative flex items-center gap-1 rounded-card', held && 'opacity-50 outline-dashed outline-1 outline-primaryBlue')}
              >
                <DragHandle id={`live-preset-drag-${id}`} {...reorder.handle(id)} />
                {renaming === id ? (
                  <div className={cn(ROW, on ? 'border-primaryBlue bg-primaryBlue/10' : 'border-transparent')}>
                    <RowIcon id={id} on={on} />
                    <NameEdit
                      id="live-preset-name"
                      label="preset name"
                      name={presetName(preset)}
                      onSave={(name) => {
                        renamePreset(id, name);
                        setRenaming(null);
                      }}
                      onCancel={() => setRenaming(null)}
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
                    <RowIcon id={id} on={on} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('truncate text-sm leading-tight', on ? 'font-semibold text-textPrimary' : 'text-textPrimary')}>{presetName(preset)}</span>
                    </span>
                    <span className="w-[3.25rem] shrink-0" />
                    <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control border border-primaryStroke px-1 font-sans text-[11px] text-textTertiary">
                      {i + 1}
                    </kbd>
                  </button>
                )}
                {renaming !== id && !reorder.held && (
                  <>
                    <Tooltip content="rename">
                      <button
                        id={`live-preset-rename-${id}`}
                        type="button"
                        aria-label="rename"
                        onClick={() => setRenaming(id)}
                        className={cn(ROW_BUTTON, 'right-[3.75rem]', ON_HOVER, 'hover:border-primaryBlue hover:text-primaryBlue')}
                      >
                        <RiPencilLine aria-hidden size={14} />
                      </button>
                    </Tooltip>
                    <Tooltip content="delete">
                      <button
                        id={`live-preset-delete-${id}`}
                        type="button"
                        aria-label="delete"
                        onClick={() => void removePreset(id)}
                        className={cn(ROW_BUTTON, 'right-8', ON_HOVER, 'hover:border-decrease hover:text-decrease')}
                      >
                        <RiCloseLine aria-hidden size={14} />
                      </button>
                    </Tooltip>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {reorder.status}
      </div>
      {notice && (
        <p id="live-preset-notice" role="status" className="m-0 text-[11px] leading-tight text-textTertiary">
          {notice}
        </p>
      )}
    </RailSection>
  );
}
