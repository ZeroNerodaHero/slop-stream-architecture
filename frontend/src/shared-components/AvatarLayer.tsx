import { type CSSProperties, useRef } from 'react';

import { api } from '@/infra/api';
import { AVATAR_FILL, AVATAR_GROW, AVATAR_LIFT, type AvatarLook, radiusVar } from '@/infra/avatar-look';
import { type VoiceDraw, type VoiceSource, useVoiceLevel } from '@/infra/use-voice-level';
import { isSpeaking, PULSE_GROW, pulseStep, pulseTarget, voiceOf } from '@/infra/voice-level';
import { colorOf } from '@/shared-components/GeneratedAvatar';
import { cn } from '@/utils/cn';

export interface AvatarVoice extends VoiceSource {
  name: string;
  version: number | null;
  pulse?: boolean;
  look?: AvatarLook;
}

const PULSE_FILL = 0.96 / (1 + PULSE_GROW);

interface AvatarLayerProps {
  id: string;
  wide: boolean;
  voice: AvatarVoice;
}

const stillIn = (win: Window) => win.matchMedia('(prefers-reduced-motion: reduce)').matches;

const speakingOn = (el: HTMLElement, voice: number) => {
  if (isSpeaking(voice)) el.dataset.speaking = '';
  else delete el.dataset.speaking;
};

const nod = (el: HTMLElement, win: Window) => nodding(el, stillIn(win));
const steady = (el: HTMLElement) => nodding(el, true);

function nodding(el: HTMLElement, still: boolean): VoiceDraw {
  let shown = -1;
  return (level) => {
    const v = voiceOf(level);
    const pct = Math.round(v * 100);
    if (pct === shown) return;
    shown = pct;
    if (!still) el.style.transform = `translateY(${-AVATAR_LIFT * 100 * v}%) scale(${1 + AVATAR_GROW * v})`;
    el.dataset.voice = String(pct);
    speakingOn(el, v);
  };
}

function pulse(el: HTMLElement, win: Window): VoiceDraw {
  const still = stillIn(win);
  let scale = 1;
  let at = 0;
  let shown = '';
  let pct = -1;
  return (level, now, instant) => {
    const v = voiceOf(level);
    const target = pulseTarget(v);
    scale = instant || !at ? target : pulseStep(scale, target, now - at);
    at = now;
    const next = still ? '1' : scale.toFixed(3);
    if (next !== shown) {
      shown = next;
      el.style.setProperty('--voice-scale', next);
    }
    const heard = Math.round(v * 100);
    if (heard === pct) return;
    pct = heard;
    el.dataset.voice = String(heard);
    speakingOn(el, v);
  };
}

export function AvatarLayer(props: AvatarLayerProps) {
  const bounce = props.voice.look?.bounce !== false;
  return <AvatarPic key={bounce ? 'bounce' : 'still'} {...props} bounce={bounce} />;
}

function AvatarPic({ id, wide, voice, bounce }: AvatarLayerProps & { bounce: boolean }) {
  const pic = useRef<HTMLDivElement | null>(null);
  const { name, version, look } = voice;
  const pulsing = !!voice.pulse;
  useVoiceLevel(pic, voice, pulsing ? pulse : bounce ? nod : steady);

  const key = name.trim().toLowerCase();
  const fill = (pulsing ? PULSE_FILL : AVATAR_FILL) * 100;
  const talkBorder = look?.border !== false;
  const style: CSSProperties = {
    ...(wide ? { height: `${fill}%` } : { width: `${fill}%` }),
    ...({ '--r-avatar': look && radiusVar(look), '--talk-color': look?.color || undefined } as CSSProperties)
  };
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div
        ref={pic}
        id={id}
        aria-hidden
        data-voice="0"
        data-pulse={pulsing || undefined}
        data-shape={look?.shape}
        data-bounce={look ? bounce : undefined}
        data-talk-border={look ? talkBorder : undefined}
        style={style}
        className={cn(
          'aspect-square overflow-hidden rounded-avatar border-2 border-primaryStroke bg-backgroundTertiary',
          pulsing
            ? '[transform:scale(var(--voice-scale,1))] data-[speaking]:outline data-[speaking]:outline-increase data-[speaking]:[outline-width:calc(2px/var(--voice-scale,1))]'
            : cn(
                'transition-[transform,border-color] duration-75 motion-reduce:transition-none',
                talkBorder && (look?.color ? 'data-[speaking]:[border-color:var(--talk-color)]' : 'data-[speaking]:border-primaryBlue')
              )
        )}
      >
        {version !== null ? (
          <img src={api.avatarUrl(name, version)} alt="" draggable={false} className="block h-full w-full object-cover" />
        ) : (
          <svg viewBox="0 0 100 100" className="block h-full w-full" style={key ? { backgroundColor: colorOf(key) } : undefined}>
            <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize="56" fontWeight="600" fill={key ? 'white' : 'currentColor'}>
              {key ? [...key][0]!.toUpperCase() : '?'}
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}
