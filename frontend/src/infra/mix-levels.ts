export interface KeptLevel {
  level: number;
  muted: boolean;
}

export interface FaderRow extends KeptLevel {
  id: string;
  label: string;
}

export function keptLevel(raw: unknown, id: string): KeptLevel | null {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[id] : null;
  if (!row || typeof row !== 'object') return null;
  const { level, muted } = row as Record<string, unknown>;
  return typeof level === 'number' && Number.isFinite(level) ? { level: Math.min(1, Math.max(0, level)), muted: muted === true } : null;
}

export function keepLevel(raw: unknown, id: string, row: KeptLevel): Record<string, unknown> {
  return { ...(raw && typeof raw === 'object' ? raw : {}), [id]: { level: row.level, muted: row.muted } };
}

export function faderRows(mixing: boolean, rows: FaderRow[], raw: unknown): FaderRow[] {
  if (mixing) return rows;
  return [{ id: 'mic', label: 'mic', level: 1, muted: false, ...keptLevel(raw, 'mic') }];
}

export function faderMaster(mixing: boolean, master: FaderRow, raw: unknown): FaderRow {
  return mixing ? master : { ...master, ...keptLevel(raw, master.id) };
}
