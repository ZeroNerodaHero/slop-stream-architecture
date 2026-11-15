/**
 * The popped out player: the corner player in an always-on-top window of its own, over every
 * other app, through the document picture in picture api. The window is a blank same-origin
 * document this page controls (no scripts of its own: react portals the player into it, and
 * the atoms, the chat socket and the peer stay here), dressed as this page: its stylesheets,
 * and the theme's variables and the size on its <html>, kept in step with the appearance
 * settings while it is open. Chrome, edge and firefox 151+ have the api; safari does not, and there the button is
 * not shown at all (`canPopOut`). The window never outlives the page: a load or a closed tab
 * closes it. A click opens it (the pop out button), and so does the tab being left while a
 * broadcast is up, where the browser says so (`onTabLeft`).
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

/** What the media session hands the handler of its `enterpictureinpicture` action, until that is in the dom typings. */
interface EnterDetails extends MediaSessionActionDetails {
  /** Who wants the window. `contentoccluded`: the browser, the tab was left. `useraction`: a person, on the browser's own media controls. */
  enterPictureInPictureReason?: string;
}

/**
 * Hears the tab being left, where the browser says so: chrome and edge's automatic picture in
 * picture. A tab that has the camera or the mic open (a broadcast) and is left for another tab
 * gets one call of `leave`, and inside that call `openPopout` works with no click behind it,
 * the one way to a window without a gesture. The browser closes a window opened that way by
 * itself when the tab is in front again. Whether it calls at all is the browser's and the
 * person's to say, not the page's: https pages only (so not `npm run dev` on
 * http://localhost), never in an incognito window, and the first such window carries the
 * browser's own question (on every visit, this time, or never; site settings keep the answer
 * as "automatic picture-in-picture"). `asked` is the other caller: the picture in picture
 * button of the browser's own media controls, pressed by a person, with the tab wherever it
 * is. One listener at a time: the media session keeps one handler for an action. Returns the
 * way to stop listening. Where the browser has no such action (firefox, safari), nothing is
 * ever heard.
 */
export function onTabLeft(leave: (asked: boolean) => void): () => void {
  if (!canPopOut) return () => undefined;
  // the action's name, until it is in the dom typings
  const action = 'enterpictureinpicture' as string as MediaSessionAction;
  try {
    navigator.mediaSession.setActionHandler(action, (details: EnterDetails) => leave(details.enterPictureInPictureReason === 'useraction'));
  } catch {
    // a browser that does not know the action
    return () => undefined;
  }
  return () => navigator.mediaSession.setActionHandler(action, null);
}

/**
 * A window of this size (the player's, so it opens looking just as it did in the corner),
 * dressed as this page, with nothing in its body yet. Inside a click, or inside `onTabLeft`'s
 * call: the browser wants a gesture, and refuses otherwise (the promise rejects; the caller
 * leaves the player where it is). One per tab: asking for another closes the one open.
 * `onClose` is told when it goes, whichever way: its own ×, `close()` on it, the browser
 * taking back one it gave for a tab that was left, or this page leaving.
 */
export async function openPopout(width: number, height: number, onClose: (win: Window) => void): Promise<Window> {
  const api = window.documentPictureInPicture;
  if (!api) throw new Error('no document picture in picture here');
  const win = await api.requestWindow({ width, height });
  // taken back before it was handed over (a tab left and come back to in one breath): its going was told to nobody, so it is no window
  if (win.closed) throw new Error('the window closed as it opened');
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
