import { atom } from 'jotai';

import {
  applySceneStage,
  cameraDeviceAtom,
  cameraOnlyAtom,
  faceExpressionsAtom,
  faceMirrorAtom,
  masterRowAtom,
  micDeviceAtom,
  mixRowsAtom,
  modelAtom,
  modelBackgroundAtom,
  placeArrivalsFrom,
  sceneStageNow,
  sourcesAtom
} from '@/infra/atoms/publish-atoms';
import { setSoundHear, setSoundLoop, setSoundVolume, setSourceNames, soundsAtom, sourceNamesAtom } from '@/infra/atoms/source-atoms';
import { activatePreset, addPreset, deletePreset, livePresetAtom, livePresetsAtom, PRESETS_MAX, type PresetId, presetOf, savePresetStage } from '@/infra/live-dock';
import { gapWords, type Stage, stageChanged, type StageGap, storedStage, withGoneScreens } from '@/infra/stage';
import { store } from '@/infra/store';

export const presetNoticeAtom = atom('');
export const presetBusyAtom = atom(false);
export const presetDirtyAtom = atom(false);
export const presetsFullAtom = atom((get) => get(livePresetsAtom).list.length >= PRESETS_MAX);

export const DIRTY_MS = 120;

let turn = 0;
let ready = false;
let applying = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let baseline: Stage | null = null;
const seen = new Set<string>();

export function stageNow(): Stage {
  const stage = sceneStageNow();
  stage.sounds = Object.fromEntries(store.get(soundsAtom).map((s) => [s.id, { name: s.name, volume: s.volume, loop: s.loop, hear: s.hear }]));
  stage.names = { ...store.get(sourceNamesAtom) };
  return stage;
}

function checkDirty() {
  if (timer) clearTimeout(timer);
  timer = null;
  const saved = ready && !applying ? (presetOf(store.get(livePresetAtom))?.stage ?? baseline) : null;
  store.set(presetDirtyAtom, saved ? stageChanged(saved, stageNow(), [...seen]) : false);
}

function checkSoon() {
  if (!ready || applying) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(checkDirty, DIRTY_MS);
}

function settled() {
  baseline = presetOf(store.get(livePresetAtom))?.stage ? null : storedStage(stageNow());
  checkDirty();
}

function stageSounds(stage: Stage, gaps: StageGap[]) {
  const here = store.get(soundsAtom);
  for (const [id, saved] of Object.entries(stage.sounds)) {
    const sound = here.find((s) => s.id === id);
    if (!sound) {
      gaps.push({ kind: 'sound', name: saved.name });
      continue;
    }
    if (sound.volume !== saved.volume) setSoundVolume(id, saved.volume);
    if (sound.loop !== saved.loop) setSoundLoop(id, saved.loop);
    if (sound.hear !== saved.hear) setSoundHear(id, saved.hear);
  }
}

async function applyStage(stage: Stage | undefined): Promise<void> {
  const mine = ++turn;
  store.set(presetNoticeAtom, '');
  if (!stage) {
    applying = false;
    store.set(presetBusyAtom, false);
    settled();
    return;
  }
  applying = true;
  store.set(presetBusyAtom, true);
  try {
    const gaps = await applySceneStage(stage);
    if (mine !== turn) return;
    stageSounds(stage, gaps);
    setSourceNames(stage.names);
    store.set(presetNoticeAtom, gapWords(gaps));
  } catch {
    return;
  } finally {
    if (mine === turn) {
      applying = false;
      store.set(presetBusyAtom, false);
      settled();
    }
  }
}

export async function pickPreset(id: PresetId): Promise<void> {
  const preset = activatePreset(id);
  if (preset) await applyStage(preset.stage);
}

export function saveActivePreset() {
  if (applying) return;
  const id = store.get(livePresetAtom);
  savePresetStage(id, withGoneScreens(presetOf(id)?.stage, stageNow(), [...seen]));
  baseline = null;
  checkDirty();
}

export function newPreset(): PresetId | null {
  if (applying) return null;
  const id = addPreset(stageNow());
  store.set(presetNoticeAtom, id ? '' : `${PRESETS_MAX} presets at most`);
  if (id) baseline = null;
  checkDirty();
  return id;
}

export async function removePreset(id: PresetId): Promise<void> {
  const was = store.get(livePresetAtom) === id;
  deletePreset(id);
  if (was) await applyStage(presetOf(store.get(livePresetAtom))?.stage);
  else checkDirty();
}

const WATCHED = [
  sourcesAtom,
  masterRowAtom,
  mixRowsAtom,
  soundsAtom,
  sourceNamesAtom,
  faceMirrorAtom,
  faceExpressionsAtom,
  modelBackgroundAtom,
  modelAtom,
  cameraOnlyAtom,
  cameraDeviceAtom,
  micDeviceAtom,
  livePresetsAtom
] as const;

export function watchPresets(): () => void {
  ready = false;
  applying = false;
  baseline = null;
  seen.clear();
  store.set(presetDirtyAtom, false);
  placeArrivalsFrom(() => presetOf(store.get(livePresetAtom))?.stage?.scene ?? null);
  let restoring = false;
  const restore = () => {
    if (ready || restoring || store.get(sourcesAtom).length === 0) return;
    restoring = true;
    void applyStage(presetOf(store.get(livePresetAtom))?.stage).finally(() => {
      ready = true;
      settled();
    });
  };
  const look = () => store.get(sourcesAtom).forEach((s) => seen.add(s.id));
  const stops = WATCHED.map((a) =>
    store.sub(a, () => {
      look();
      if (ready) checkSoon();
      else restore();
    })
  );
  look();
  restore();
  return () => {
    stops.forEach((stop) => stop());
    if (timer) clearTimeout(timer);
    timer = null;
    ready = false;
    baseline = null;
    store.set(presetDirtyAtom, false);
    placeArrivalsFrom(null);
  };
}
