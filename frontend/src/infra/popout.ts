import { applyTextSizeTo, applyThemeTo, textSizeAtom, themeAtom } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    readonly documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export const canPopOut = typeof window !== 'undefined' && window.documentPictureInPicture !== undefined;

interface EnterDetails extends MediaSessionActionDetails {
  enterPictureInPictureReason?: string;
}

export function onTabLeft(leave: (asked: boolean) => void): () => void {
  if (!canPopOut) return () => undefined;
  const action = 'enterpictureinpicture' as string as MediaSessionAction;
  try {
    navigator.mediaSession.setActionHandler(action, (details: EnterDetails) => leave(details.enterPictureInPictureReason === 'useraction'));
  } catch {
    return () => undefined;
  }
  return () => navigator.mediaSession.setActionHandler(action, null);
}

export async function openPopout(width: number, height: number, onClose: (win: Window) => void): Promise<Window> {
  const api = window.documentPictureInPicture;
  if (!api) throw new Error('no document picture in picture here');
  const win = await api.requestWindow({ width, height });
  if (win.closed) throw new Error('the window closed as it opened');
  const doc = win.document;
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(sheet.cloneNode(true));
  const root = doc.documentElement;
  applyThemeTo(root);
  applyTextSizeTo(root);
  root.style.scrollbarGutter = 'auto';
  root.style.overflow = 'hidden';
  const unsubTheme = store.sub(themeAtom, () => applyThemeTo(root));
  const unsubSize = store.sub(textSizeAtom, () => applyTextSizeTo(root));
  win.addEventListener(
    'pagehide',
    () => {
      unsubTheme();
      unsubSize();
      onClose(win);
    },
    { once: true }
  );
  return win;
}
