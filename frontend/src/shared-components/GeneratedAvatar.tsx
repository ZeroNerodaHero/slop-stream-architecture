import { useEffect, useRef } from 'react';
import { cn } from '@/utils/cn';
import {
  AVATAR_SIZE,
  REGION_MAP,
  SKIN,
  HAIR,
  CLOTHES,
  BG,
  OUTLINE,
  WHITE,
  BOW,
} from './avatar-data';

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function colorOf(name: string): string {
  return `oklch(0.55 0.14 ${hash(name) % 360})`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Map each region char to the color chosen for this name.
function paletteFor(key: string): Record<string, [number, number, number]> {
  const h = hash(key);
  return {
    '0': hexToRgb(OUTLINE),
    '1': hexToRgb(SKIN[h & 0xf]!),
    '2': hexToRgb(HAIR[(h >> 4) & 0xf]!),
    '3': hexToRgb(WHITE),
    '4': hexToRgb(BOW),
    '5': hexToRgb(CLOTHES[(h >> 8) & 0xf]!),
    '6': hexToRgb(BG[(h >> 12) & 0xf]!),
  };
}

interface GeneratedAvatarProps {
  name: string;
  className?: string;
}

export function GeneratedAvatar({ name, className }: GeneratedAvatarProps) {
  const key = name.trim().toLowerCase();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !key) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const palette = paletteFor(key);
    const img = ctx.createImageData(AVATAR_SIZE, AVATAR_SIZE);
    for (let i = 0; i < REGION_MAP.length; i++) {
      const region = REGION_MAP[i]!;
      const [r, g, b] = palette[region] ?? [0, 0, 0];
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [key]);

  if (!key) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex h-10 w-10 shrink-0 select-none items-center justify-center rounded-avatar border border-primaryStroke bg-backgroundTertiary text-lg font-semibold uppercase leading-none text-textTertiary',
          className
        )}
      >
        ?
      </span>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={AVATAR_SIZE}
      height={AVATAR_SIZE}
      aria-hidden
      className={cn(
        'h-10 w-10 shrink-0 select-none rounded-avatar border border-primaryStroke',
        className
      )}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
