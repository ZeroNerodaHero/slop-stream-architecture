import type { SoundEvent } from '@/infra/sound-logic';

export interface CustomSound {
  blob: Blob;
  name: string;
}

const DB = 'slop-sounds';
const VERSION = 1;
const STORE = 'custom';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexeddb here'));
      return;
    }
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb would not open'));
    request.onblocked = () => reject(new Error('indexeddb is busy'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('indexeddb gave up'));
    });
  } finally {
    db.close();
  }
}

function isCustom(value: unknown): value is CustomSound {
  const kept = value as Partial<CustomSound> | null;
  return !!kept && typeof kept === 'object' && kept.blob instanceof Blob && typeof kept.name === 'string';
}

export async function readCustomSound(event: SoundEvent): Promise<CustomSound | null> {
  try {
    const kept = await run<unknown>('readonly', (s) => s.get(event));
    return isCustom(kept) ? kept : null;
  } catch {
    return null;
  }
}

export function keepCustomSound(event: SoundEvent, sound: CustomSound): Promise<void> {
  return run<void>('readwrite', (s) => s.put(sound, event));
}

export function dropCustomSound(event: SoundEvent): Promise<void> {
  return run<void>('readwrite', (s) => s.delete(event));
}
