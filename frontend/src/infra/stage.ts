import { AVATAR_ID, type KeptScene, type KeptSource, keptOf, readKept, type Source } from './scene.ts';
import { NO_BACKING } from './model-backing.ts';
import { cleanSourceName, readNames } from './source-settings.ts';

export interface StageImage {
  asset: number;
  label: string;
  ratio?: number;
}

export interface StageLevel {
  level: number;
  muted: boolean;
}

export interface StageSound {
  name: string;
  volume: number;
  loop: boolean;
  hear: boolean;
}

export type StageModel = { kind: 'demo'; id: string; v: string; name: string } | { kind: 'kept'; id: number; name: string };

export interface Stage {
  scene: KeptScene;
  images: Record<string, StageImage>;
  levels: Record<string, StageLevel>;
  sounds: Record<string, StageSound>;
  names: Record<string, string>;
  camera: string;
  mic: string;
  mirror: boolean;
  expressions: boolean;
  background: string;
  model: StageModel | null;
  solo: boolean;
}

export type StageGap =
  | { kind: 'screen'; slot: number }
  | { kind: 'image'; label: string }
  | { kind: 'camera' }
  | { kind: 'avatar' }
  | { kind: 'device'; what: 'camera' | 'mic' }
  | { kind: 'model'; name: string }
  | { kind: 'sound'; name: string };

const ID = /^[a-z][a-z0-9]{0,24}$/;
const COLOUR = /^#[0-9a-f]{6}$/i;
const unit = (v: number) => Math.min(1, Math.max(0, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (raw: unknown): Record<string, unknown> | null => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null);

export function stageOf(sources: readonly Source[], rest: Omit<Stage, 'scene' | 'images'>): Stage {
  const images: Record<string, StageImage> = {};
  for (const s of sources)
    if (s.kind === 'image' && s.asset !== undefined) images[s.id] = { asset: s.asset, label: s.label, ...(s.ratio !== undefined && { ratio: s.ratio }) };
  return { ...rest, scene: keptOf(sources), images };
}

export function readModelChoice(raw: unknown): StageModel | null {
  const c = record(raw);
  if (!c || typeof c.name !== 'string') return null;
  if (c.kind === 'demo' && typeof c.id === 'string' && /^[a-z0-9_-]{1,48}$/.test(c.id) && typeof c.v === 'string')
    return { kind: 'demo', id: c.id, v: c.v, name: c.name };
  if (c.kind === 'kept' && finite(c.id) && Number.isInteger(c.id) && c.id >= 0) return { kind: 'kept', id: c.id, name: c.name };
  return null;
}

function readEntries<T>(raw: unknown, read: (value: Record<string, unknown>) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(record(raw) ?? {})) {
    const v = record(value);
    const got = ID.test(id) && v ? read(v) : null;
    if (got) out[id] = got;
  }
  return out;
}

export function readStage(raw: unknown): Stage | null {
  const p = record(raw);
  if (!p) return null;
  const scene = readKept(p.scene);
  if (!scene) return null;
  const images = readEntries<StageImage>(p.images, (v) =>
    finite(v.asset) && Number.isInteger(v.asset) && v.asset >= 0
      ? { asset: v.asset, label: (typeof v.label === 'string' && cleanSourceName(v.label)) || 'picture', ...(finite(v.ratio) && v.ratio > 0 && { ratio: v.ratio }) }
      : null
  );
  const levels = readEntries<StageLevel>(p.levels, (v) => (finite(v.level) ? { level: unit(v.level), muted: v.muted === true } : null));
  const sounds = readEntries<StageSound>(p.sounds, (v) =>
    finite(v.volume)
      ? { name: (typeof v.name === 'string' && cleanSourceName(v.name)) || 'sound', volume: unit(v.volume), loop: v.loop === true, hear: v.hear !== false }
      : null
  );
  return {
    scene: Object.fromEntries(Object.entries(scene).filter(([id]) => ID.test(id))),
    images,
    levels,
    sounds,
    names: readNames(p.names),
    camera: typeof p.camera === 'string' ? p.camera : '',
    mic: typeof p.mic === 'string' ? p.mic : '',
    mirror: p.mirror !== false,
    expressions: p.expressions !== false,
    background: typeof p.background === 'string' && (COLOUR.test(p.background) || p.background === NO_BACKING) ? p.background : '',
    model: readModelChoice(p.model),
    solo: p.solo === true
  };
}

export function stagedKind(id: string, stage: Pick<Stage, 'images'>): Source['kind'] {
  if (id === 'cam') return 'camera';
  if (id === AVATAR_ID) return 'avatar';
  if (stage.images[id]) return 'image';
  return 'screen';
}

export function screenSlotOf(id: string): number | null {
  const m = /^s(\d{1,2})$/.exec(id);
  return m ? Number(m[1]) : null;
}

export interface Staged {
  sources: Source[];
  gaps: StageGap[];
}

export function stagedFrom(stage: Pick<Stage, 'scene' | 'images'>, now: readonly Source[], library: readonly number[], newId: () => string): Staged {
  const used = new Set<string>();
  const placed: Source[] = [];
  const gaps: StageGap[] = [];
  for (const [id, kept] of Object.entries(stage.scene)) {
    const image = stage.images[id];
    const match = image ? now.find((s) => s.kind === 'image' && s.asset === image.asset && !used.has(s.id)) : now.find((s) => s.id === id && s.kind !== 'image');
    if (match) {
      used.add(match.id);
      placed.push({ ...match, box: kept.box, shown: kept.shown, fit: kept.fit, ...(match.kind === 'avatar' && { look: kept.look }) });
      continue;
    }
    if (image && library.includes(image.asset)) {
      placed.push({
        id: newId(),
        kind: 'image',
        label: image.label,
        asset: image.asset,
        ...(image.ratio !== undefined && { ratio: image.ratio }),
        box: kept.box,
        shown: kept.shown,
        ...(kept.fit && { fit: kept.fit })
      });
      continue;
    }
    const kind = stagedKind(id, stage);
    const slot = kind === 'camera' ? 0 : kind === 'screen' ? screenSlotOf(id) : null;
    if ((kind === 'camera' || kind === 'screen') && slot !== null) {
      placed.push({ id, kind, label: kind, slot, box: kept.box, shown: kept.shown, ...(kept.fit && { fit: kept.fit }), waiting: true });
      continue;
    }
    if (!kept.shown) continue;
    if (kind === 'image') gaps.push({ kind: 'image', label: image?.label ?? 'picture' });
    else if (kind === 'screen') gaps.push({ kind: 'screen', slot: screenSlotOf(id) ?? 0 });
    else gaps.push({ kind });
  }
  const rest = now.filter((s) => !used.has(s.id) && s.kind !== 'image' && !s.waiting).map((s) => ({ ...s, shown: false }));
  return { sources: [...rest, ...placed], gaps };
}

export function gapWords(gaps: readonly StageGap[]): string {
  if (!gaps.length) return '';
  const words = gaps.map((g) => {
    if (g.kind === 'screen') return `screen ${g.slot}`;
    if (g.kind === 'image') return g.label;
    if (g.kind === 'device') return `${g.what} device`;
    if (g.kind === 'model' || g.kind === 'sound') return g.name;
    return g.kind;
  });
  return `skipped ${words.join(', ')}: not here now`;
}

export function withGoneScreens(before: Stage | undefined, next: Stage, seen: readonly string[]): Stage {
  if (!before) return next;
  const gone = Object.entries(before.scene).filter(([id]) => screenSlotOf(id) !== null && !seen.includes(id) && !(id in next.scene));
  if (!gone.length) return next;
  return { ...next, scene: { ...Object.fromEntries(gone), ...next.scene } };
}

const FULL_LEVEL: StageLevel = { level: 1, muted: false };

interface StageEntry {
  id: string;
  kept: KeptSource;
  image?: StageImage;
}

function entriesOf(stage: Stage): StageEntry[] {
  const count = new Map<number, number>();
  return Object.entries(stage.scene).map(([id, kept]) => {
    const image = stage.images[id];
    if (!image) return { id, kept };
    const n = (count.get(image.asset) ?? 0) + 1;
    count.set(image.asset, n);
    return { id: `@${image.asset}.${n}`, kept, image };
  });
}

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (!value || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  return Object.keys(v)
    .sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => [k, canon(v[k])]);
}

function viewOf(stage: Stage, mine: readonly StageEntry[], theirs: readonly StageEntry[], other: Stage): string {
  const there = new Set(theirs.map((e) => e.id));
  return JSON.stringify(
    canon({
      ...stage,
      scene: mine.filter((e) => e.kept.shown || there.has(e.id)),
      images: null,
      levels: Object.fromEntries([...new Set([...Object.keys(stage.levels), ...Object.keys(other.levels)])].map((id) => [id, stage.levels[id] ?? FULL_LEVEL]))
    })
  );
}

export function sameStage(a: Stage, b: Stage): boolean {
  const ea = entriesOf(a);
  const eb = entriesOf(b);
  return viewOf(a, ea, eb, b) === viewOf(b, eb, ea, a);
}

export function storedStage(stage: Stage): Stage | null {
  return readStage(JSON.parse(JSON.stringify(stage)));
}

export function stageChanged(saved: Stage, now: Stage, seen: readonly string[]): boolean {
  const next = storedStage(now);
  if (!next) return true;
  const kept = Object.entries(saved.scene).filter(([id]) => screenSlotOf(id) === null || seen.includes(id) || id in next.scene);
  return !sameStage({ ...saved, scene: Object.fromEntries(kept) }, next);
}
