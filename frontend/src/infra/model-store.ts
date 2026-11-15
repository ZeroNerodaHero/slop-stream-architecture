/**
 * The models this browser keeps (docs/vtuber.md), in indexeddb: the streamer's own model files,
 * so the one they wore last is there on the next visit and the picker can offer the others
 * again, and the site's demo models as they were downloaded, so one worn before opens at once,
 * with nothing to download and with the server away. Nothing here goes to the api: a person's
 * own model stays on their machine.
 *
 * Indexeddb and not the browser's http cache (which drops a big file whenever it likes), the
 * cache api (made for answers to requests, which a picked file is not) or the private file
 * system (no better for a file read whole, and missing in some private windows): it takes a
 * file as it is, it is in every browser, and the three share one quota anyway.
 *
 * Three stores, so listing the models never reads their megabytes. `meta` is the streamer's
 * own: a name, an author, a size and a small picture each. `demos` is the demo models kept: an
 * id, which version of the file, a size, when it was last worn. `files` is the bytes of both:
 * under the number `meta` gave for their own, under `demo:<id>` for a demo. A browser with no
 * indexeddb (some private windows) keeps nothing: every function here then answers as an empty
 * shelf would, and the model still works for the visit.
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

/** One of the site's demo models as this browser keeps it: which version of the file (the api's `v`), and its size. */
export interface KeptDemo {
  id: string;
  v: string;
  bytes: number;
}
/** A demo's row: `used` is when it was last worn, unix ms. */
interface DemoRow extends KeptDemo {
  used: number;
}

/** How many of their own are kept. The oldest goes when one more comes. */
export const MAX_KEPT = 5;
/** How many demo models are kept. The one not worn for the longest goes when one more comes: it is one download away. */
export const MAX_KEPT_DEMOS = 8;
const DB = 'models';
/** 2: the `demos` store. A browser that has 1 gets the store added and keeps what it had. */
const VERSION = 2;
const META = 'meta';
const DEMOS = 'demos';
const FILES = 'files';
const demoKey = (id: string) => `demo:${id}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexeddb here'));
      return;
    }
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(DEMOS)) db.createObjectStore(DEMOS, { keyPath: 'id' });
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

/** `work` on an open database, which is closed after it. `otherwise` where nothing can be kept, or the browser said no. */
async function withDb<T>(otherwise: T, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  try {
    const db = await open();
    try {
      return await work(db);
    } finally {
      db.close();
    }
  } catch {
    return otherwise;
  }
}

// ---- their own ---------------------------------------------------------------------------------

/** The kept models, newest first. Empty where nothing can be kept. */
export function listKept(): Promise<KeptModel[]> {
  return withDb<KeptModel[]>([], async (db) => {
    const rows = await answer(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<KeptModel[]>);
    return rows.sort((a, b) => b.added - a.added);
  });
}

/**
 * `file` kept under `about`. One already kept with that name and that size is the same file
 * picked again, and is replaced; past `MAX_KEPT` the oldest goes. `null` when this browser
 * could not keep it (no indexeddb, no room): the caller still has the bytes for this visit.
 */
export function keepModel(file: Blob, about: { name: string; author: string }, thumb: Blob | null): Promise<KeptModel | null> {
  return withDb<KeptModel | null>(null, async (db) => {
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
  });
}

/** A kept model's bytes, or `null` when it is not kept any more (the browser made room, or it was forgotten in another tab). */
export function keptFile(id: number): Promise<ArrayBuffer | null> {
  return withDb<ArrayBuffer | null>(null, async (db) => {
    const file = await answer(db.transaction(FILES, 'readonly').objectStore(FILES).get(id) as IDBRequest<Blob | undefined>);
    return file ? await file.arrayBuffer() : null;
  });
}

export function forgetKept(id: number): Promise<void> {
  return withDb<void>(undefined, async (db) => {
    const tx = db.transaction([META, FILES], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(FILES).delete(id);
    await finished(tx);
  });
}

// ---- the site's demo models ----------------------------------------------------------------------

/** The demo models this browser keeps. Empty where nothing can be kept. */
export function listKeptDemos(): Promise<KeptDemo[]> {
  return withDb<KeptDemo[]>([], async (db) => {
    const rows = await answer(db.transaction(DEMOS, 'readonly').objectStore(DEMOS).getAll() as IDBRequest<DemoRow[]>);
    return rows.map(({ id, v, bytes }) => ({ id, v, bytes }));
  });
}

/** Demo model `id`'s bytes when this browser keeps version `v` of it, else `null`: it is downloaded. Reading it is wearing it: it is the last to go. */
export function keptDemoFile(id: string, v: string): Promise<ArrayBuffer | null> {
  return withDb<ArrayBuffer | null>(null, async (db) => {
    const tx = db.transaction([DEMOS, FILES], 'readwrite');
    const demos = tx.objectStore(DEMOS);
    const done = finished(tx);
    const row = await answer(demos.get(id) as IDBRequest<DemoRow | undefined>);
    const file = row?.v === v ? await answer(tx.objectStore(FILES).get(demoKey(id)) as IDBRequest<Blob | undefined>) : undefined;
    if (row && file) demos.put({ ...row, used: Date.now() });
    await done;
    return file ? await file.arrayBuffer() : null;
  });
}

/** Demo model `id`, version `v`, kept: an older version of it is replaced, and past `MAX_KEPT_DEMOS` the one worn longest ago goes. False when it could not be kept. */
export function keepDemo(id: string, v: string, file: Blob): Promise<boolean> {
  return withDb(false, async (db) => {
    const tx = db.transaction([DEMOS, FILES], 'readwrite');
    const demos = tx.objectStore(DEMOS);
    const files = tx.objectStore(FILES);
    const done = finished(tx);
    const others = (await answer(demos.getAll() as IDBRequest<DemoRow[]>)).filter((row) => row.id !== id).sort((a, b) => b.used - a.used);
    for (const row of others.slice(MAX_KEPT_DEMOS - 1)) {
      demos.delete(row.id);
      files.delete(demoKey(row.id));
    }
    const row: DemoRow = { id, v, bytes: file.size, used: Date.now() };
    demos.put(row);
    files.put(file, demoKey(id));
    await done;
    return true;
  });
}

/** The api's list of demo models, just read: a kept one that is not in it any more, or is another version there, goes. What is left is returned. */
export function pruneKeptDemos(listed: readonly { id: string; v: string }[]): Promise<KeptDemo[]> {
  return withDb<KeptDemo[]>([], async (db) => {
    const tx = db.transaction([DEMOS, FILES], 'readwrite');
    const demos = tx.objectStore(DEMOS);
    const files = tx.objectStore(FILES);
    const done = finished(tx);
    const rows = await answer(demos.getAll() as IDBRequest<DemoRow[]>);
    const kept = rows.filter((row) => listed.some((model) => model.id === row.id && model.v === row.v));
    for (const row of rows) {
      if (kept.includes(row)) continue;
      demos.delete(row.id);
      files.delete(demoKey(row.id));
    }
    await done;
    return kept.map(({ id, v, bytes }) => ({ id, v, bytes }));
  });
}

/**
 * Ask the browser to keep this site's storage for good. Without it what is kept here is "best
 * effort": the browser may clear it when the disk runs low (and safari does after a week of no
 * visits). A browser decides on its own or asks the person; either may say no, and the models
 * are kept all the same for as long as there is room.
 */
export async function keepForGood(): Promise<boolean> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return false;
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return false;
  }
}
