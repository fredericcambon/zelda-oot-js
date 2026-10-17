// Save states: the portable state of the running game, one per slot, kept with the version of its format. A state loads
// into any build that reads that version.

export const SLOT_COUNT = 4;
/** The `format` of a state saved as a dump of one build's memory, which no build can load any more. */
export const OLD_FORMAT = 0;

export interface StateRecord {
  /** Version of the portable state format; OLD_FORMAT for the build-locked memory dumps kept before it existed. */
  format: number;
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
        return asRecord(v);
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

/** States in the server's shared folder. */
export function serverStates(fetcher: typeof fetch = fetch): StateStore {
  return {
    async get(slot) {
      const r = await fetcher(`/api/saves/state/${slot}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`could not read slot ${slot}: ${r.status}`);
      return { format: Number(r.headers.get('X-State-Format')) || OLD_FORMAT, savedAt: Number(r.headers.get('X-Saved-At')) || 0, data: new Uint8Array(await r.arrayBuffer()) };
    },
    async put(slot, record) {
      const r = await fetcher(`/api/saves/state/${slot}`, {
        method: 'PUT',
        headers: { 'X-State-Format': String(record.format), 'X-Saved-At': String(record.savedAt) },
        body: record.data.slice(),
      });
      if (!r.ok) throw new Error(`could not store slot ${slot}: ${r.status}`);
    },
  };
}

/** Records written before the portable format carry a build id instead of a format version. */
function asRecord(v: unknown): StateRecord | null {
  const r = v as (Partial<StateRecord> & { build?: unknown }) | null;
  if (!r || typeof r.savedAt !== 'number' || !(r.data instanceof Uint8Array)) return null;
  if (typeof r.format === 'number') return { format: r.format, savedAt: r.savedAt, data: r.data };
  return typeof r.build === 'string' ? { format: OLD_FORMAT, savedAt: r.savedAt, data: r.data } : null;
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

/** The message that explains why a stored state cannot load into this build, or null when it can. */
export function formatMismatch(record: StateRecord, readable: number, slot: number): string | null {
  if (record.format === OLD_FORMAT) return `Slot ${slot} was saved in the old format and cannot be loaded`;
  if (record.format !== readable) return `Slot ${slot} uses state format ${record.format}, this build reads ${readable}`;
  return null;
}

export class SaveStates {
  private current = 1;

  constructor(private readonly source: StateSource, private readonly store: StateStore, private readonly format: number) {}

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
    await this.store.put(slot, { format: this.format, savedAt: Date.now(), data: await this.source.capture() });
    return `Saved slot ${slot}`;
  }

  async load(): Promise<string> {
    const slot = this.current;
    const record = await this.store.get(slot);
    if (!record) return `Slot ${slot} empty`;
    const mismatch = formatMismatch(record, this.format, slot);
    if (mismatch) return mismatch;
    try {
      await this.source.apply(record.data);
    } catch (err) {
      return `Slot ${slot} cannot be loaded: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Loaded slot ${slot}`;
  }
}
