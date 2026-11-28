import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { useState } from 'react';

import { api } from '@/infra/api';
import { setChat, streamNameAtom } from '@/infra/atoms/publish-atoms';
import { CHAT_SIZE_MAX, CHAT_SIZE_MIN, CHAT_STYLE, chatLinesOf } from '@/infra/chat-paint';
import type { Source } from '@/infra/scene';
import { type Shape, SHAPES } from '@/infra/shape';
import { CHAT_LINES_MAX, TEXT_ALIGNS, TEXT_BG, TEXT_COLOR, type TextAlign } from '@/infra/text-paint';
import { ColorChip, ColorPick } from '@/shared-components/about/ColorPick';
import { Segmented } from '@/shared-components/Segmented';
import { Tooltip } from '@/shared-components/Tooltip';

const ALIGN_OPTIONS = TEXT_ALIGNS.map((value) => ({ value, label: value }));
const SHAPE_OPTIONS = SHAPES.map((value) => ({ value, label: value }));
const ROW = 'flex min-h-7 items-center gap-2';
const WORD = 'flex-1 text-xs text-textSecondary';
const SLIDER = 'flex min-w-0 items-center gap-2 text-sm';
const SLIDER_WORD = 'w-9 shrink-0 text-xs text-textSecondary';
const SLIDER_VALUE = 'w-9 shrink-0 text-right text-xs tabular-nums text-textTertiary';
const SOURCES_STALE_MS = 30_000;

const PRIVACY_WORDS = {
  everyone: 'site, twitch and kick lines go on the stream',
  studio: 'twitch and kick stay in your studio, only site chat goes on the stream',
  off: 'only site chat goes on the stream'
} as const;

type Picking = 'color' | 'bg' | null;

export function ChatOverlaySettings({ source }: { source: Source }) {
  const name = useAtomValue(streamNameAtom);
  const answer = useQuery({ queryKey: ['chat-sources', name], queryFn: () => api.chatSources(name), enabled: !!name, staleTime: SOURCES_STALE_MS });
  const mode = answer.data?.external_chat ?? null;
  const style = source.style ?? CHAT_STYLE;
  const lines = chatLinesOf(source.chat);
  const [picking, setPicking] = useState<Picking>(null);
  const percent = Math.round(style.size * 1000) / 10;
  const shape: Shape = style.shape && style.shape !== 'default' ? style.shape : 'bubble';
  const toggle = (what: Exclude<Picking, null>) => setPicking(picking === what ? null : what);
  return (
    <div id="source-chat" className="flex min-w-0 flex-col gap-2 border-t border-primaryStroke px-3 py-2.5">
      <div className={SLIDER}>
        <span className={SLIDER_WORD}>lines</span>
        <input
          id="chat-lines"
          type="range"
          min={1}
          max={CHAT_LINES_MAX}
          step={1}
          value={lines}
          aria-label="chat lines"
          aria-valuetext={`${lines} lines`}
          onChange={(e) => setChat(source.id, { lines: e.target.valueAsNumber })}
          className="h-1 min-w-0 flex-1 accent-primaryBlue"
        />
        <span id="chat-lines-value" className={SLIDER_VALUE}>
          {lines}
        </span>
      </div>
      <div className={SLIDER}>
        <span className={SLIDER_WORD}>size</span>
        <Tooltip content={`${percent}% of the frame height`}>
          <input
            id="chat-size"
            type="range"
            min={CHAT_SIZE_MIN}
            max={CHAT_SIZE_MAX}
            step={0.0025}
            value={Math.min(CHAT_SIZE_MAX, Math.max(CHAT_SIZE_MIN, style.size))}
            aria-label="chat text size"
            aria-valuetext={`${percent}%`}
            onChange={(e) => setChat(source.id, { style: { size: e.target.valueAsNumber } })}
            className="h-1 min-w-0 flex-1 accent-primaryBlue"
          />
        </Tooltip>
        <span className={SLIDER_VALUE}>{percent}%</span>
      </div>
      <Segmented<TextAlign>
        id="chat-align"
        label="chat alignment"
        options={ALIGN_OPTIONS}
        value={style.align ?? 'left'}
        onChange={(align) => setChat(source.id, { style: { align } })}
        className="w-full"
      />
      <div className={ROW}>
        <span className={WORD}>colors</span>
        <ColorChip id="chat-color-chip" word="text" value={style.color} open={picking === 'color'} onClick={() => toggle('color')} />
        <ColorChip id="chat-bg-chip" word="background" value={style.bg ?? ''} open={picking === 'bg'} onClick={() => toggle('bg')} />
      </div>
      {picking === 'color' && (
        <ColorPick
          id="chat-color"
          label="chat text color"
          value={style.color}
          fallback={TEXT_COLOR}
          reset={{ word: 'white', tip: 'white text' }}
          onChange={(color) => setChat(source.id, { style: { color: color || TEXT_COLOR } })}
        />
      )}
      {picking === 'bg' && (
        <ColorPick
          id="chat-bg"
          label="chat background"
          value={style.bg ?? ''}
          fallback={TEXT_BG}
          reset={{ word: 'none', tip: 'no background' }}
          onChange={(bg) => setChat(source.id, { style: { bg: bg || undefined } })}
        />
      )}
      {style.bg && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id="chat-shape-word" className="text-xs text-textSecondary">
            shape
          </span>
          <Segmented<Shape>
            id="chat-shape"
            label="chat line shape"
            options={SHAPE_OPTIONS}
            value={shape}
            onChange={(next) => setChat(source.id, { style: { shape: next } })}
            className="w-full"
          />
        </div>
      )}
      {mode && (
        <p id="chat-privacy" className="text-xs text-textTertiary">
          {PRIVACY_WORDS[mode]}
        </p>
      )}
    </div>
  );
}
