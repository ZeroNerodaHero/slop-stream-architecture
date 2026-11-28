import { useState } from 'react';

import { setText } from '@/infra/atoms/publish-atoms';
import { AVATAR_SHAPES, type AvatarShape } from '@/infra/avatar-look';
import type { Source } from '@/infra/scene';
import { alignOf, kindOfStyle, TEXT_ALIGNS, TEXT_BG, TEXT_COLOR, TEXT_KINDS, TEXT_MAX, type TextAlign, textStyleOf } from '@/infra/text-paint';
import { Button } from '@/shared-components/Button';
import { ColorChip, ColorPick } from '@/shared-components/about/ColorPick';
import { INPUT } from '@/shared-components/input';
import { Segmented } from '@/shared-components/Segmented';
import { Tooltip } from '@/shared-components/Tooltip';
import { cn } from '@/utils/cn';

const ALIGN_OPTIONS = TEXT_ALIGNS.map((value) => ({ value, label: value }));
const SHAPE_OPTIONS = AVATAR_SHAPES.map((value) => ({ value, label: value }));
const ROW = 'flex min-h-7 items-center gap-2';
const WORD = 'flex-1 text-xs text-textSecondary';
const SIZE_MIN = 0.02;
const SIZE_MAX = 0.2;

type Picking = 'color' | 'bg' | null;

export function TextSettings({ source }: { source: Source }) {
  const style = textStyleOf(source.style);
  const kind = kindOfStyle(style);
  const [picking, setPicking] = useState<Picking>(null);
  const text = source.text ?? '';
  const percent = Math.round(style.size * 1000) / 10;
  const toggle = (what: Exclude<Picking, null>) => setPicking(picking === what ? null : what);
  return (
    <div id="source-text" className="flex min-w-0 flex-col gap-2 border-t border-primaryStroke px-3 py-2.5">
      <label htmlFor="text-words" className="text-xs text-textSecondary">
        words
      </label>
      <textarea
        id="text-words"
        value={text}
        rows={2}
        maxLength={TEXT_MAX * 2}
        placeholder="text"
        spellCheck={false}
        aria-describedby="text-words-hint"
        onChange={(e) => setText(source.id, { text: e.target.value })}
        className={cn(INPUT, 'min-h-14 resize-y text-sm max-md:text-[length:max(1rem,16px)]')}
      />
      <p id="text-words-hint" className="-mt-1 text-xs text-textTertiary">
        {text.trim() ? `${[...text].length}/${TEXT_MAX}` : 'empty text stays off the stream'}
      </p>
      <div id="text-kind" role="group" aria-label="text kind" className="flex flex-wrap gap-1.5">
        {TEXT_KINDS.map((k) => (
          <Button
            key={k}
            id={`text-kind-${k.replace(' ', '-')}`}
            size="sm"
            aria-pressed={kind === k}
            onClick={() => setText(source.id, { kind: k })}
            className={cn(kind === k && 'border-primaryBlue text-primaryBlue')}
          >
            {k}
          </Button>
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="w-9 shrink-0 text-xs text-textSecondary">size</span>
        <Tooltip content={`${percent}% of the frame height`}>
          <input
            id="text-size"
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={0.005}
            value={Math.min(SIZE_MAX, Math.max(SIZE_MIN, style.size))}
            aria-label="text size"
            aria-valuetext={`${percent}%`}
            onChange={(e) => setText(source.id, { style: { size: e.target.valueAsNumber } })}
            className="h-1 min-w-0 flex-1 accent-primaryBlue"
          />
        </Tooltip>
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-textTertiary">{percent}%</span>
      </div>
      <Segmented<TextAlign>
        id="text-align"
        label="text alignment"
        options={ALIGN_OPTIONS}
        value={alignOf(style)}
        onChange={(align) => setText(source.id, { style: { align } })}
        className="w-full"
      />
      <div className={ROW}>
        <span className={WORD}>colors</span>
        <ColorChip id="text-color-chip" word="text" value={style.color} open={picking === 'color'} onClick={() => toggle('color')} />
        <ColorChip id="text-bg-chip" word="background" value={style.bg ?? ''} open={picking === 'bg'} onClick={() => toggle('bg')} />
      </div>
      {picking === 'color' && (
        <ColorPick
          id="text-color"
          label="text color"
          value={style.color}
          fallback={TEXT_COLOR}
          reset={{ word: 'white', tip: 'white text' }}
          onChange={(color) => setText(source.id, { style: { color: color || TEXT_COLOR } })}
        />
      )}
      {picking === 'bg' && (
        <ColorPick
          id="text-bg"
          label="text background"
          value={style.bg ?? ''}
          fallback={TEXT_BG}
          reset={{ word: 'none', tip: 'no background' }}
          onChange={(bg) => setText(source.id, { style: { bg: bg || undefined } })}
        />
      )}
      {style.bg && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="text-shape-word" className="text-xs text-textSecondary">
            shape
          </span>
          <Segmented<AvatarShape>
            id="text-shape"
            label="text background shape"
            options={SHAPE_OPTIONS}
            value={style.shape ?? 'default'}
            onChange={(shape) => setText(source.id, { style: { shape } })}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}
