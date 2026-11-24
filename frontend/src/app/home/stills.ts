export const STILL_TRIES = 8;

type Still = { kind: 'custom'; id: number } | { kind: 'camera'; token: number; tries: number };

export interface StillUrls {
  custom: (name: string, id: number) => string;
  camera: (name: string, token: number) => string;
}

export interface StillPictures {
  src: (name: string, thumbs: readonly number[]) => string;
  missed: (name: string, failed: string) => string | null;
  loaded: (name: string) => void;
}

export function stillPictures(urls: StillUrls): StillPictures {
  const pagePick = Math.floor(Math.random() * 0x7fffffff);
  const stills = new Map<string, Still>();

  function pickIndex(name: string, length: number): number {
    let n = pagePick;
    for (let i = 0; i < name.length; i++) n = (n + name.charCodeAt(i)) >>> 0;
    return n % length;
  }

  function src(name: string, thumbs: readonly number[]): string {
    let still = stills.get(name);
    if (!still) {
      const id = thumbs.length > 0 ? thumbs[pickIndex(name, thumbs.length)] : undefined;
      still = id !== undefined ? { kind: 'custom', id } : { kind: 'camera', token: pagePick, tries: 0 };
      stills.set(name, still);
    } else if (still.kind === 'camera') {
      still.tries = 0;
    }
    return still.kind === 'custom' ? urls.custom(name, still.id) : urls.camera(name, still.token);
  }

  function missed(name: string, failed: string): string | null {
    const still = stills.get(name);
    if (!still) return null;
    const current = still.kind === 'custom' ? urls.custom(name, still.id) : urls.camera(name, still.token);
    if (failed !== current) return current;
    if (still.kind === 'custom') {
      const camera: Still = { kind: 'camera', token: pagePick, tries: 0 };
      stills.set(name, camera);
      return urls.camera(name, camera.token);
    }
    if (still.tries >= STILL_TRIES) return null;
    still.tries += 1;
    still.token += 1;
    return urls.camera(name, still.token);
  }

  function loaded(name: string) {
    const still = stills.get(name);
    if (still?.kind === 'camera') still.tries = 0;
  }

  return { src, missed, loaded };
}
