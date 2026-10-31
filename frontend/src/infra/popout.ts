/**
 * The popped out player: the corner player in an always-on-top window of its own, over every
 * other app, through the document picture in picture api. The window is a blank same-origin
 * document this page controls (no scripts of its own: react portals the player into it, and
 * the atoms, the chat socket and the peer stay here), dressed as this page: its stylesheets,
 * and the theme's variables and the size on its <html>, kept in step with the appearance
 * settings while it is open. Chrome, edge and firefox 151+ have the api; safari does not, and there the button is
 * not shown at all (`canPopOut`). The window never outlives the page: a load or a closed tab
 * closes it.
 */

import { applyTextSizeTo, applyThemeTo, textSizeAtom, themeAtom } from '@/infra/atoms/settings-atoms';
import { store } from '@/infra/store';

// the api, until it is in the dom typings
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  /** The window open from this page, if any. */
  readonly window: Window | null;
}

declare global {
  interface Window {
    readonly documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export const canPopOut = typeof window !== 'undefined' && window.documentPictureInPicture !== undefined;

/**
 * A window of this size (the player's, so it opens looking just as it did in the corner),
 * dressed as this page, with nothing in its body yet. Inside a click only: the browser wants a
 * gesture, and refuses otherwise (the promise rejects; the caller leaves the player where it
 * is). One per tab: asking for another closes the one open. `onClose` is told when it goes,
 * whichever way: its own ×, `close()` on it, or this page leaving.
 */
export async function openPopout(width: number, height: number, onClose: (win: Window) => void): Promise<Window> {
  const api = window.documentPictureInPicture;
  if (!api) throw new Error('no document picture in picture here');
  const win = await api.requestWindow({ width, height });
  const doc = win.document;
  // the page's stylesheets, as nodes: the fonts, tailwind's classes and the theme's tokens
  // all come along; in dev those are vite's <style> tags, in a build the one <link>
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(sheet.cloneNode(true));
  const root = doc.documentElement;
  applyThemeTo(root);
  applyTextSizeTo(root);
  // the page's <html> reserves a scrollbar gutter (globals.css); the player fills its window and scrolls nothing
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
