export const POLL_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 15 * 1000;

export interface NativeUpdate {
  version: string;
  install: (onProgress: (done: number, total: number | null) => void) => Promise<void>;
}

export function newerBuild(running: string, body: unknown): string | null {
  if (running === 'dev' || !body || typeof body !== 'object') return null;
  const build = (body as { build?: unknown }).build;
  if (typeof build !== 'string' || build === '' || build === 'dev') return null;
  return build === running ? null : build;
}

export function progressText(done: number, total: number | null): string {
  if (total && total > 0) return `downloading ${Math.min(100, Math.floor((done / total) * 100))}%`;
  if (done > 0) return `downloading ${(done / (1024 * 1024)).toFixed(1)} MB`;
  return 'downloading';
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function checkWeb(running: string): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return newerBuild(running, await res.json());
  } catch {
    return null;
  }
}

async function checkNative(): Promise<NativeUpdate | null> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      async install(onProgress) {
        let done = 0;
        let total: number | null = null;
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? null;
          if (event.event === 'Progress') done += event.data.chunkLength;
          onProgress(done, total);
        });
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      }
    };
  } catch {
    return null;
  }
}

export function watchUpdates(running: string, onWeb: (build: string) => void, onNative: (update: NativeUpdate) => void): () => void {
  const web = running !== 'dev';
  const native = inTauri();
  if (!web && !native) return () => {};

  let stopped = false;
  let last = 0;
  let nativeFound = false;

  const run = async () => {
    const now = Date.now();
    if (now - last < MIN_GAP_MS) return;
    last = now;
    if (native && !nativeFound) {
      const update = await checkNative();
      if (update && !stopped) {
        nativeFound = true;
        onNative(update);
      }
    }
    if (web) {
      const build = await checkWeb(running);
      if (build && !stopped) onWeb(build);
    }
  };
  const whenVisible = () => {
    if (document.visibilityState === 'visible') void run();
  };

  void run();
  const timer = setInterval(whenVisible, POLL_MS);
  document.addEventListener('visibilitychange', whenVisible);
  window.addEventListener('focus', whenVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', whenVisible);
    window.removeEventListener('focus', whenVisible);
  };
}
