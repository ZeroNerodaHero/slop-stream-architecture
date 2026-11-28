export const NO_BACKING = 'none';
export const WIRE_BACKING = '#181b22';
const COLOUR = /^#[0-9a-f]{6}$/i;

export function readModelBacking(raw: unknown): string {
  if (typeof raw !== 'string' || !COLOUR.test(raw) || raw.toLowerCase() === WIRE_BACKING) return NO_BACKING;
  return raw;
}

export const isSeeThrough = (backing: string): boolean => !COLOUR.test(backing);

export const wireBackingOf = (backing: string): string => (COLOUR.test(backing) ? backing : WIRE_BACKING);

export const isStoredBacking = (raw: unknown): raw is string => typeof raw === 'string' && (raw === NO_BACKING || COLOUR.test(raw));
