import { useState } from 'react';

import { setAvatarLook } from '@/infra/atoms/publish-atoms';
import { AVATAR_SHAPES, type AvatarShape, lookOf } from '@/infra/avatar-look';
import type { Source } from '@/infra/scene';
import { ColorChip, ColorPick } from '@/shared-components/about/ColorPick';
import { Segmented } from '@/shared-components/Segmented';
import { Switch } from '@/shared-components/Switch';

const SHAPE_OPTIONS = AVATAR_SHAPES.map((value) => ({ value, label: value }));
const ROW = 'flex min-h-7 items-center gap-2';
const WORD = 'flex-1 text-xs text-textSecondary';

function themeBlue(): string {
  const parts = getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return '#4f8bff';
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function AvatarLookSettings({ source }: { source: Source }) {
  const look = lookOf(source.look);
  const [picking, setPicking] = useState(false);
  const set = (patch: Parameters<typeof setAvatarLook>[1]) => setAvatarLook(source.id, patch);
  return (
    <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <span id="avatar-shape-word" className="text-xs text-textSecondary">
          shape
        </span>
        <Segmented<AvatarShape>
          id="avatar-shape"
          label="avatar shape"
          options={SHAPE_OPTIONS}
          value={look.shape}
          onChange={(shape) => set({ shape })}
          className="w-full"
        />
      </div>
      <div className={ROW}>
        <span className={WORD}>talk border</span>
        <ColorChip id="avatar-talk-color-chip" word="color" value={look.color} open={picking} onClick={() => setPicking(!picking)} />
        <Switch id="avatar-talk-border" label="talk border" checked={look.border} onChange={(border) => set({ border })} />
      </div>
      {picking && <ColorPick id="avatar-talk-color" label="talk border" value={look.color} fallback={themeBlue()} onChange={(color) => set({ color })} />}
      <div className={ROW}>
        <span className={WORD}>talk bounce</span>
        <Switch id="avatar-talk-bounce" label="talk bounce" checked={look.bounce} onChange={(bounce) => set({ bounce })} />
      </div>
    </div>
  );
}
