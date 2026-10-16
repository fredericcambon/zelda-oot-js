// Keeps the game's save memory (the cartridge SRAM) in IndexedDB so it survives a reload.

export interface SaveStore {
  load(): Promise<Uint8Array | null>;
  store(bytes: Uint8Array): Promise<void>;
}

const DB_NAME = 'zelda-oot-js';
const OBJECT_STORE = 'saves';
const KEY = 'sram';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbStore(factory: IDBFactory = indexedDB): SaveStore {
  const open = (): Promise<IDBDatabase> => {
    const opening = factory.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(OBJECT_STORE);
    return request(opening);
  };
  return {
    async load() {
      const db = await open();
      try {
        const v = await request(db.transaction(OBJECT_STORE).objectStore(OBJECT_STORE).get(KEY));
        return v instanceof Uint8Array ? new Uint8Array(v) : null;
      } finally {
        db.close();
      }
    },
    async store(bytes) {
      const db = await open();
      try {
        const tx = db.transaction(OBJECT_STORE, 'readwrite');
        tx.objectStore(OBJECT_STORE).put(bytes.slice(), KEY);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

/** Whether the page's server keeps saves on disk (the dev and preview servers do; a static copy of the page does not). */
export async function serverHasSaves(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetcher('/api/saves/ping')).status === 204;
  } catch {
    return false;
  }
}

/** The save memory in the server's shared folder; any build of the game reads what another wrote. */
export function serverStore(fetcher: typeof fetch = fetch): SaveStore {
  return {
    async load() {
      const r = await fetcher('/api/saves/sram');
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`could not read the save: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async store(bytes) {
      const r = await fetcher('/api/saves/sram', { method: 'PUT', body: bytes.slice() });
      if (!r.ok) throw new Error(`could not store the save: ${r.status}`);
    },
  };
}

/** The save memory of a running game, as the host sees it. */
export interface SaveMemory {
  /** Replaces the start of the save memory. */
  write(bytes: Uint8Array): void;
  /** A copy of the save memory when the game wrote it since the last call, else null. */
  takeIfDirty(): Uint8Array | null;
}

/** Copies the stored save into the game before it runs, then writes it back after the game changes it. */
export class SaveSync {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly memory: SaveMemory, private readonly saves: SaveStore) {}

  /** Returns whether a stored save existed. */
  async restore(): Promise<boolean> {
    const bytes = await this.saves.load();
    if (bytes) this.memory.write(bytes);
    return bytes !== null;
  }

  /** Call once per frame; queues a write when the game has written the memory. Resolves when the queued writes are done. */
  flush(): Promise<void> {
    const bytes = this.memory.takeIfDirty();
    if (!bytes) return this.pending;
    // A failed write must not block the later ones: each write starts from a settled chain, and only its own failure is reported.
    const write = this.pending.catch(() => {}).then(() => this.saves.store(bytes));
    this.pending = write.catch(() => {});
    return write;
  }
}
