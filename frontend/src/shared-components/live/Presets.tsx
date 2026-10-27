import { RiCloseLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { applyPresetNamed, forgetPreset, livePanelsAtom, savedPresetsAtom, savePreset, setLivePanel, sourcesAtom } from '@/infra/atoms/publish-atoms';
import { type Preset, PRESETS, rolesOf } from '@/infra/scene';
import { Button } from '@/shared-components/Button';
import { Collapsible } from '@/shared-components/live/Collapsible';
import { cn } from '@/utils/cn';

/** A preset's name as an id: `screen + face` is `preset-screen-face`. */
export const presetId = (name: string) =>
  `preset-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;

function Chip({ preset, whole, saved }: { preset: Preset; whole: boolean; saved: boolean }) {
  return (
    <span className="group/chip relative inline-flex">
      <Button
        id={presetId(preset.name)}
        flat
        title={whole ? undefined : 'not every picture this one places is here yet'}
        className={cn('px-3 py-1.5 text-sm', !whole && 'opacity-60')}
        onClick={() => applyPresetNamed(preset.name)}
      >
        {preset.name}
      </Button>
      {saved && (
        <button
          id={`${presetId(preset.name)}-forget`}
          type="button"
          aria-label={`forget the preset ${preset.name}`}
          onClick={() => forgetPreset(preset.name)}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center border border-primaryStroke bg-backgroundSecondary text-textSecondary opacity-0 transition-opacity duration-150 hover:border-decrease hover:text-decrease focus-visible:opacity-100 focus-visible:outline-none group-hover/chip:opacity-100"
        >
          <RiCloseLine aria-hidden size={10} />
        </button>
      )}
    </span>
  );
}

/**
 * The presets, under the preview: arrangements by role (`infra/scene.ts`), the built in ones
 * and the ones this browser saved. A click lays one onto the sources there are; one that places
 * a picture not here yet is dimmed, and still a click. `save as preset` keeps the arrangement on
 * the stream now under a name, in this browser.
 */
export function Presets() {
  const sources = useAtomValue(sourcesAtom);
  const saved = useAtomValue(savedPresetsAtom);
  const open = useAtomValue(livePanelsAtom).presets;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const roles = rolesOf(sources);
  const whole = (p: Preset) => p.boxes.every((b) => roles.has(b.role));
  const save = () => {
    if (name.trim()) savePreset(name);
    setName('');
    setNaming(false);
  };
  return (
    <Collapsible id="presets" title="presets" open={open} onToggle={() => setLivePanel('presets', !open)} className="mt-3">
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        {PRESETS.map((p) => (
          <Chip key={p.name} preset={p} whole={whole(p)} saved={false} />
        ))}
        {saved.map((p) => (
          <Chip key={p.name} preset={p} whole={whole(p)} saved />
        ))}
        {naming ? (
          <span className="flex items-center gap-2">
            <input
              id="preset-name"
              value={name}
              autoFocus
              maxLength={32}
              placeholder="a name"
              aria-label="the preset's name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setNaming(false);
              }}
              className="h-8 w-36 border border-primaryStroke bg-background px-2 text-sm text-textPrimary"
            />
            <Button id="preset-save" flat variant="primary" className="px-3 py-1.5 text-sm" onClick={save}>
              save
            </Button>
          </span>
        ) : (
          <Button id="save-preset" flat className="px-3 py-1.5 text-sm" onClick={() => setNaming(true)}>
            save as preset
          </Button>
        )}
        <span className="text-xs text-textTertiary">kept in this browser</span>
      </div>
    </Collapsible>
  );
}
