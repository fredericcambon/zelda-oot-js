// Save states: the complete state of the running game kept in IndexedDB, one per slot, next to the build that took it.

export const SLOT_COUNT = 4;

export interface StateRecord {
  /** Identifies the build of the game module (the hash of its wasm file); a state only loads into the same build. */
  build: string;
  savedAt: number;
  data: Uint8Array;
}

export interface StateStore {
  get(slot: number): Promise<StateRecord | null>;
  put(slot: number, record: StateRecord): Promise<void>;
}

/** The running game as the slots see it. */
export interface StateSource {
  /** Takes the state of the game between two frames. */
  capture(): Promise<Uint8Array>;
  /** Puts a state back; rejects when it cannot be loaded. */
  apply(data: Uint8Array): Promise<void>;
}

const DB_NAME = 'zelda-oot-js-states';
const OBJECT_STORE = 'states';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbStates(factory: IDBFactory = indexedDB): StateStore {
  const open = (): Promise<IDBDatabase> => {
    const opening = factory.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(OBJECT_STORE);
    return request(opening);
  };
  return {
    async get(slot) {
      const db = await open();
      try {
        const v: unknown = await request(db.transaction(OBJECT_STORE).objectStore(OBJECT_STORE).get(slot));
        return isRecord(v) ? v : null;
      } finally {
        db.close();
      }
    },
    async put(slot, record) {
      const db = await open();
      try {
        const tx = db.transaction(OBJECT_STORE, 'readwrite');
        tx.objectStore(OBJECT_STORE).put(record, slot);
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

function isRecord(v: unknown): v is StateRecord {
  const r = v as Partial<StateRecord> | null;
  return !!r && typeof r.build === 'string' && typeof r.savedAt === 'number' && r.data instanceof Uint8Array;
}

/** Gzip, so that the untouched parts of the memory cost almost nothing to store. */
export async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Hex SHA-256 of a build's wasm file. */
export async function buildIdOf(wasm: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', wasm));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The message that explains why a stored state cannot load into this build, or null when it can. */
export function buildMismatch(record: StateRecord, build: string, slot: number): string | null {
  return record.build === build ? null : `Slot ${slot} was saved by another build of the game and cannot be loaded`;
}

export class SaveStates {
  private current = 1;

  constructor(private readonly source: StateSource, private readonly store: StateStore, private readonly build: string) {}

  get slot(): number {
    return this.current;
  }

  /** Moves the selection by `step` slots, wrapping around; returns the notice to show. */
  async select(step: number): Promise<string> {
    this.current = ((this.current - 1 + step + SLOT_COUNT) % SLOT_COUNT) + 1;
    const record = await this.store.get(this.current);
    return `Slot ${this.current}${record ? '' : ' (empty)'}`;
  }

  async save(): Promise<string> {
    const slot = this.current;
    await this.store.put(slot, { build: this.build, savedAt: Date.now(), data: await this.source.capture() });
    return `Saved slot ${slot}`;
  }

  async load(): Promise<string> {
    const slot = this.current;
    const record = await this.store.get(slot);
    if (!record) return `Slot ${slot} empty`;
    const mismatch = buildMismatch(record, this.build, slot);
    if (mismatch) return mismatch;
    await this.source.apply(record.data);
    return `Loaded slot ${slot}`;
  }
}
