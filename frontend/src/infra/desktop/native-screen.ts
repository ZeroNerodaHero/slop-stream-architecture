import { Channel, invoke } from '@tauri-apps/api/core';

import { bytesOf, errorText } from '@/infra/desktop/native-audio';
import { askScreen, type ScreenChoice } from '@/infra/desktop/screen-pick';

const FPS = 30;

export class ListFailed extends Error {
  override name = 'ListFailed';
}

export interface NativeScreen {
  stream: MediaStream;
  surface: 'monitor' | 'window';
}

export async function pickNativeScreen(): Promise<NativeScreen | null> {
  let choices: ScreenChoice[];
  try {
    choices = await invoke<ScreenChoice[]>('list_capture_sources');
  } catch (err) {
    throw new ListFailed(errorText(err), { cause: err });
  }
  const choice = await askScreen(choices);
  if (!choice) return null;
  return { stream: await startScreen(choice.id), surface: choice.kind === 'window' ? 'window' : 'monitor' };
}

async function startScreen(id: string): Promise<MediaStream> {
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

  const release = () => {
    if (ended) return;
    ended = true;
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
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        paint.drawImage(bitmap, 0, 0);
        bitmap.close();
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
    handle = await invoke<number>('start_screen_capture', { id, channel });
  } catch (err) {
    ended = true;
    stopTrack();
    throw new Error(errorText(err), { cause: err });
  }
  if (ended) void invoke('stop_screen_capture', { handle }).catch(() => undefined);
  return stream;
}
