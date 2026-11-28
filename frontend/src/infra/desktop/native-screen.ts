import { Channel, invoke } from '@tauri-apps/api/core';

import { bytesOf, errorText } from '@/infra/desktop/native-audio';
import { askScreen, type ScreenChoice } from '@/infra/desktop/screen-pick';
import { capBounds, fitWithin, type ScreenCap } from '@/infra/screen-cap';

const FPS = 30;

export class ListFailed extends Error {
  override name = 'ListFailed';
}

export interface NativeScreen {
  stream: MediaStream;
  surface: 'monitor' | 'window';
  resize: (cap: ScreenCap) => Promise<void>;
}

interface Started {
  stream: MediaStream;
  resize: (cap: ScreenCap) => Promise<void>;
}

const boundsOf = (cap: ScreenCap) => {
  const { width, height } = capBounds(cap);
  return { maxWidth: width, maxHeight: height };
};

export async function pickNativeScreen(cap: ScreenCap): Promise<NativeScreen | null> {
  let choices: ScreenChoice[];
  try {
    choices = await invoke<ScreenChoice[]>('list_capture_sources');
  } catch (err) {
    throw new ListFailed(errorText(err), { cause: err });
  }
  const choice = await askScreen(choices);
  if (!choice) return null;
  const started = await startScreen(choice.id, cap);
  return { ...started, surface: choice.kind === 'window' ? 'window' : 'monitor' };
}

async function startScreen(id: string, cap: ScreenCap): Promise<Started> {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const paint = canvas.getContext('2d');
  if (!paint) throw new Error('no canvas to draw the screen on');
  const stream = canvas.captureStream(FPS);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('no track out of the canvas');
  const stopTrack = track.stop.bind(track);
  let handle: number | null = null;
  let ended = false;
  let drawing = false;
  let waiting: ArrayBuffer | null = null;
  let wanted = cap;
  let last: ImageBitmap | null = null;

  const paintLast = () => {
    if (!last) return;
    const size = fitWithin(last.width, last.height, wanted);
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
    }
    paint.imageSmoothingQuality = 'high';
    paint.drawImage(last, 0, 0, size.width, size.height);
  };

  const release = () => {
    if (ended) return;
    ended = true;
    last?.close();
    last = null;
    if (handle !== null) void invoke('stop_screen_capture', { handle }).catch(() => undefined);
  };
  track.stop = () => {
    stopTrack();
    release();
  };

  const draw = async (frame: ArrayBuffer) => {
    drawing = true;
    let next: ArrayBuffer | null = frame;
    while (next) {
      if (ended) break;
      waiting = null;
      try {
        const bitmap = await createImageBitmap(new Blob([next], { type: 'image/jpeg' }));
        if (ended) {
          bitmap.close();
          break;
        }
        last?.close();
        last = bitmap;
        paintLast();
      } catch {
        break;
      }
      next = waiting;
    }
    drawing = false;
  };

  const channel = new Channel<unknown>((raw) => {
    const frame = bytesOf(raw);
    if (!frame || ended) return;
    if (frame.byteLength === 0) {
      track.stop();
      track.dispatchEvent(new Event('ended'));
      return;
    }
    if (drawing) waiting = frame;
    else void draw(frame);
  });

  try {
    handle = await invoke<number>('start_screen_capture', { id, channel, ...boundsOf(cap) });
  } catch (err) {
    ended = true;
    stopTrack();
    throw new Error(errorText(err), { cause: err });
  }
  if (ended) void invoke('stop_screen_capture', { handle }).catch(() => undefined);
  const resize = async (next: ScreenCap) => {
    wanted = next;
    paintLast();
    if (ended || handle === null) return;
    await invoke('resize_screen_capture', { handle, ...boundsOf(next) }).catch(() => undefined);
  };
  return { stream, resize };
}
