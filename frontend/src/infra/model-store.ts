export interface KeptModel {
  id: number;
  name: string;
  author: string;
  bytes: number;
  added: number;
  thumb: Blob | null;
}

export interface KeptDemo {
  id: string;
  v: string;
  bytes: number;
}
interface DemoRow extends KeptDemo {
  used: number;
}

export const MAX_KEPT = 5;
export const MAX_KEPT_DEMOS = 8;
const DB = 'models';
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

export function listKept(): Promise<KeptModel[]> {
  return withDb<KeptModel[]>([], async (db) => {
    const rows = await answer(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<KeptModel[]>);
    return rows.sort((a, b) => b.added - a.added);
  });
}

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

export function listKeptDemos(): Promise<KeptDemo[]> {
  return withDb<KeptDemo[]>([], async (db) => {
    const rows = await answer(db.transaction(DEMOS, 'readonly').objectStore(DEMOS).getAll() as IDBRequest<DemoRow[]>);
    return rows.map(({ id, v, bytes }) => ({ id, v, bytes }));
  });
}

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

export async function keepForGood(): Promise<boolean> {
  try {
    const storage = navigator.storage;
    if (!storage?.persist) return false;
    return (await storage.persisted()) || (await storage.persist());
  } catch {
    return false;
  }
}
