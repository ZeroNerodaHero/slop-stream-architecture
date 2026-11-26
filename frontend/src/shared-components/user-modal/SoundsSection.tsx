import { RiPlayLine } from '@remixicon/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useRef, useState } from 'react';

import {
  customSoundNamesAtom,
  dropCustom,
  keepCustom,
  loadCustomSoundNames,
  setSoundChoice,
  setSoundVolume,
  soundChoiceAtoms,
  soundVolumeAtoms
} from '@/infra/atoms/sound-atoms';
import { BELLS, type SoundChoice, type SoundEvent } from '@/infra/sound-logic';
import { checkCustomFile, previewSound } from '@/infra/sounds';
import { Button } from '@/shared-components/Button';
import { Select, type SelectOption } from '@/shared-components/Select';
import { Tooltip } from '@/shared-components/Tooltip';
import { FIELDSET, SECTION_TITLE, Status } from '@/shared-components/user-modal/parts';

const EVENTS: readonly { event: SoundEvent; label: string; id: string }[] = [
  { event: 'notification', label: 'notifications', id: 'notification' },
  { event: 'voiceJoin', label: 'someone joins voice', id: 'voice-join' },
  { event: 'voiceLeave', label: 'someone leaves voice', id: 'voice-leave' }
];

const OPTIONS: readonly SelectOption<SoundChoice>[] = [
  ...BELLS.map((b) => ({ value: b.id, label: b.label })),
  { value: 'custom', label: 'custom' },
  { value: 'none', label: 'none' }
];

export function SoundsSection() {
  useEffect(() => {
    void loadCustomSoundNames();
  }, []);

  return (
    <fieldset id="settings-sounds" className={FIELDSET}>
      <legend className={SECTION_TITLE}>sounds</legend>
      <ul className="mt-2 flex flex-col gap-3">
        {EVENTS.map((row) => (
          <SoundRow key={row.event} {...row} />
        ))}
      </ul>
    </fieldset>
  );
}

function SoundRow({ event, label, id }: { event: SoundEvent; label: string; id: string }) {
  const choice = useAtomValue(soundChoiceAtoms[event]);
  const volume = useAtomValue(soundVolumeAtoms[event]);
  const fileName = useAtomValue(customSoundNamesAtom)[event];
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const silent = choice === 'none' || (choice === 'custom' && !fileName);

  async function pick(chosen: File | undefined) {
    if (!chosen) return;
    setBusy(true);
    setNote('');
    try {
      const refusal = await checkCustomFile(chosen);
      if (refusal) return setNote(refusal);
      await keepCustom(event, chosen, chosen.name);
    } catch {
      setNote('not saved: this browser would not keep the file');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setNote('');
    try {
      await dropCustom(event);
    } catch {
      setNote('not removed: this browser would not let go of the file');
    }
  }

  return (
    <li id={`sound-${id}`} className="flex flex-col gap-3 rounded-card border border-primaryStroke bg-background p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span aria-hidden className="min-w-0 flex-1 basis-40 font-semibold leading-tight text-textPrimary">
          {label}
        </span>
        <div className="flex min-w-0 items-center gap-2 max-md:w-full">
          <Select
            id={`sound-${id}-choice`}
            label={`${label} sound`}
            value={choice}
            options={OPTIONS}
            onChange={(next) => {
              setNote('');
              setSoundChoice(event, next);
            }}
            className="w-40 min-w-0 max-md:flex-1"
          />
          <Tooltip content="preview">
            <Button
              id={`sound-${id}-preview`}
              size="sm"
              aria-label="preview"
              disabled={silent || volume === 0}
              onClick={() => previewSound(event, volume)}
              className="max-md:min-w-11"
            >
              <RiPlayLine aria-hidden size={16} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`sound-${id}-volume`} className="text-sm font-semibold text-textSecondary">
            volume
          </label>
          <span id={`sound-${id}-volume-value`} className="text-sm tabular-nums text-textTertiary">
            {volume}%
          </span>
        </div>
        <input
          id={`sound-${id}-volume`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          disabled={choice === 'none'}
          onChange={(e) => setSoundVolume(event, e.target.valueAsNumber)}
          className="range-box w-full disabled:opacity-40"
          style={{ '--pct': `${volume}%` } as CSSProperties}
        />
      </div>

      {choice === 'custom' && (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span id={`sound-${id}-file`} className="min-w-0 flex-1 basis-40 truncate text-sm text-textSecondary">
              {fileName ?? 'no file yet'}
            </span>
            <input
              ref={file}
              id={`sound-${id}-upload`}
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                void pick(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button id={`sound-${id}-upload-button`} size="sm" variant="outline" disabled={busy} onClick={() => file.current?.click()}>
              {fileName ? 'replace file' : 'upload file'}
            </Button>
            {fileName && (
              <Button id={`sound-${id}-remove`} size="sm" variant="outline-danger" onClick={() => void remove()}>
                remove
              </Button>
            )}
          </div>
          <p className="text-sm text-textTertiary">an audio file, 1 MB and 5 seconds at most</p>
          <Status id={`sound-${id}-note`} text={note} quiet />
        </div>
      )}
    </li>
  );
}
