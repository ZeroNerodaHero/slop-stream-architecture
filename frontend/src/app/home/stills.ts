/**
 * The one picture a home card shows for the whole visit: one of the streamer's own when they
 * put some, else one camera frame, asked for again a few times while that frame is not written
 * yet. The url builders come in as arguments, so there is no api client or React in here and
 * the same code runs under plain node.
 */

/** How many times to ask again for a camera frame that is not written yet (~6s after go-live). */
export const STILL_TRIES = 8;

type Still = { kind: 'custom'; id: number } | { kind: 'camera'; token: number; tries: number };

/** `api.streamThumbUrl` and `api.thumbUrl`. */
export interface StillUrls {
  /** One of the streamer's own pictures, by id. */
  custom: (name: string, id: number) => string;
  /** The camera frame. A new `token` is a new url, so the browser asks again. */
  camera: (name: string, token: number) => string;
}

export interface StillPictures {
  /** The one picture this name shows until the document is loaded again. */
  src: (name: string, thumbs: readonly number[]) => string;
  /**
   * The picture at `failed` was not there. A custom one that 404s falls back to one camera frame.
   * A camera frame that is not written yet gets a new url a few times, then stops. A `failed`
   * the entry has already moved past (another card of this name reported it first) is answered
   * with the current url and counts for nothing, so two cards share one budget and one picture.
   */
  missed: (name: string, failed: string) => string | null;
  /** The picture arrived, so the next misses are a fresh wait for a frame, not the tail of this one. */
  loaded: (name: string) => void;
}

/** One per page load, so a refresh can land on a different picture and a sitting page never does. */
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
      // the card is back after the stream restarted: the asks are per appearance of the frame,
      // not a quota for the visit, or the third restart left the card blank for good. the token
      // stays, so it is still the same picture
      still.tries = 0;
    }
    return still.kind === 'custom' ? urls.custom(name, still.id) : urls.camera(name, still.token);
  }

  function missed(name: string, failed: string): string | null {
    const still = stills.get(name);
    if (!still) return null;
    // the same name is on the page twice (the grid card and the followed card) and the other
    // card reported this url first: hand over where the entry is, uncounted, or two cards
    // spend two tries a round and are shown two pictures
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
