/**
 * The models this browser keeps (docs/vtuber.md): a streamer's own .vrm files, in indexeddb, so
 * the one they wore last is there on the next visit and the picker can offer the others again.
 * Nothing here goes to the api: a person's own model stays on their machine.
 *
 * Two stores, so listing five models never reads their fifty megabytes: `meta` is a name, an
 * author, a size and a small picture each; `files` is the bytes, by the same id. A browser with
 * no indexeddb (some private windows) keeps nothing: every function here then answers as an
 * empty shelf would, and the model still works for the visit.
 */

/** One kept model, without its bytes. */
export interface KeptModel {
  id: number;
  /** The model's own name, or the file's when it has none. */
  name: string;
  author: string;
  /** The file's size. */
  bytes: number;
  /** When it was kept, unix ms. */
  added: number;
  /** A small picture of it: its own thumbnail, cut down. `null` when it has none. */
  thumb: Blob | null;
}

/** How many are kept. The oldest goes when one more comes. */
export const MAX_KEPT = 5;
const DB = 'models';
const META = 'meta';
const FILES = 'files';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexeddb here'));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb would not open'));
    request.onblocked = () => reject(new Error('indexeddb is busy'));
  });
}

const answer = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb said no'));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('indexeddb gave up'));
  });

/** The kept models, newest first. Empty where nothing can be kept. */
export async function listKept(): Promise<KeptModel[]> {
  try {
    const db = await open();
    try {
      const rows = await answer(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<KeptModel[]>);
      return rows.sort((a, b) => b.added - a.added);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * `file` kept under `about`. One already kept with that name and that size is the same file
 * picked again, and is replaced; past `MAX_KEPT` the oldest goes. `null` when this browser
 * could not keep it (no indexeddb, no room): the caller still has the bytes for this visit.
 */
export async function keepModel(file: Blob, about: { name: string; author: string }, thumb: Blob | null): Promise<KeptModel | null> {
  try {
    const db = await open();
    try {
      const tx = db.transaction([META, FILES], 'readwrite');
      const meta = tx.objectStore(META);
      const files = tx.objectStore(FILES);
      const done = finished(tx);
      const rows = (await answer(meta.getAll() as IDBRequest<KeptModel[]>)).sort((a, b) => b.added - a.added);
      const same = rows.filter((row) => row.name === about.name && row.bytes === file.size);
      const others = rows.filter((row) => !same.includes(row));
      for (const row of [...same, ...others.slice(MAX_KEPT - 1)]) {
        meta.delete(row.id);
        files.delete(row.id);
      }
      const row: Omit<KeptModel, 'id'> = { name: about.name, author: about.author, bytes: file.size, added: Date.now(), thumb };
      const id = Number(await answer(meta.add(row)));
      files.put(file, id);
      await done;
      return { ...row, id };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** A kept model's bytes, or `null` when it is not kept any more (the browser made room, or it was forgotten in another tab). */
export async function keptFile(id: number): Promise<ArrayBuffer | null> {
  try {
    const db = await open();
    try {
      const file = await answer(db.transaction(FILES, 'readonly').objectStore(FILES).get(id) as IDBRequest<Blob | undefined>);
      return file ? await file.arrayBuffer() : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function forgetKept(id: number): Promise<void> {
  try {
    const db = await open();
    try {
      const tx = db.transaction([META, FILES], 'readwrite');
      tx.objectStore(META).delete(id);
      tx.objectStore(FILES).delete(id);
      await finished(tx);
    } finally {
      db.close();
    }
  } catch {
    // nothing kept, nothing to forget
  }
}
