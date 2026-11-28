import { atom } from 'jotai';

import { applySceneStage, sceneStageNow } from '@/infra/atoms/publish-atoms';
import { setSoundHear, setSoundLoop, setSoundVolume, setSourceNames, soundsAtom, sourceNamesAtom } from '@/infra/atoms/source-atoms';
import { applyPreset, type PresetId, saveMine } from '@/infra/live-dock';
import { gapWords, type Stage, type StageGap } from '@/infra/stage';
import { store } from '@/infra/store';

export const presetNoticeAtom = atom('');
export const presetBusyAtom = atom(false);

let turn = 0;

export function stageNow(): Stage {
  const stage = sceneStageNow();
  stage.sounds = Object.fromEntries(store.get(soundsAtom).map((s) => [s.id, { name: s.name, volume: s.volume, loop: s.loop, hear: s.hear }]));
  stage.names = { ...store.get(sourceNamesAtom) };
  return stage;
}

export function savePreset() {
  turn++;
  saveMine(stageNow());
  store.set(presetNoticeAtom, '');
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

export async function pickPreset(id: PresetId): Promise<void> {
  const mine = ++turn;
  const preset = applyPreset(id);
  store.set(presetNoticeAtom, '');
  const stage = preset?.stage;
  if (!stage) return;
  store.set(presetBusyAtom, true);
  try {
    const gaps = await applySceneStage(stage);
    if (mine !== turn) return;
    stageSounds(stage, gaps);
    setSourceNames(stage.names);
    store.set(presetNoticeAtom, gapWords(gaps));
  } finally {
    if (mine === turn) store.set(presetBusyAtom, false);
  }
}
