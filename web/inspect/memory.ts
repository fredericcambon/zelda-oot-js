// The 8 MB of guest RDRAM as the Memory tab shows it: a window of bytes with the ones that just changed marked, pinned
// watches with typed values, and the classic value search (equal, changed, unchanged since the last search).
import { writeValue, type FreezeSize } from './freeze.ts';
import type { Bridge } from './bridge.ts';
import { Refused } from './queue.ts';

export const RDRAM_BASE = 0x80000000;
export const RDRAM_SIZE = 0x800000;
export const RDRAM_END = RDRAM_BASE + RDRAM_SIZE;

export const WINDOW_ROWS = 16;
export const ROW_BYTES = 16;
export const WINDOW_BYTES = WINDOW_ROWS * ROW_BYTES;

/** A byte changed this many refreshes ago or less is shown as changed. */
export const CHANGED_TICKS = 10;
export const MAX_HITS = 24;

export type ValueType = 'u8' | 'u16' | 'u32' | 's16' | 'float';
export const VALUE_TYPES: readonly ValueType[] = ['u8', 'u16', 'u32', 's16', 'float'];
const SIZES: Record<ValueType, FreezeSize> = { u8: 1, u16: 2, u32: 4, s16: 2, float: 4 };
export const sizeOf = (type: ValueType): FreezeSize => SIZES[type];

export const hexAddress = (addr: number): string => `0x${(addr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** An address typed as `0x80xxxxxx`, `80xxxxxx` or an offset into RDRAM (`0x1234`); always hexadecimal. */
export function parseAddress(text: string): number {
  const t = text.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(t)) throw new Refused(`"${text.trim()}" is not an address (hexadecimal, 0x80000000 to 0x807FFFFF, or an offset)`);
  let n = parseInt(t, 16);
  if (n < RDRAM_SIZE) n += RDRAM_BASE;
  if (n < RDRAM_BASE || n >= RDRAM_END) throw new Refused(`${hexAddress(n)} is outside the 8 MB of memory (0x80000000 to 0x807FFFFF)`);
  return n >>> 0;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The value of `type` at `addr`, big-endian. */
export function readTyped(bytes: Uint8Array, addr: number, type: ValueType): number {
  const dv = view(bytes);
  const at = addr & 0x7fffff;
  switch (type) {
    case 'u8': return dv.getUint8(at);
    case 'u16': return dv.getUint16(at);
    case 'u32': return dv.getUint32(at);
    case 's16': return dv.getInt16(at);
    case 'float': return dv.getFloat32(at);
  }
}

/** The unsigned bit pattern of `value` as `type` stores it. */
export function bitsOf(type: ValueType, value: number): number {
  const dv = new DataView(new ArrayBuffer(4));
  if (type === 'float') dv.setFloat32(0, value);
  else if (type === 's16') dv.setInt16(0, value);
  else dv.setUint32(0, value);
  return type === 'float' || type === 'u32' ? dv.getUint32(0) : type === 's16' ? dv.getUint16(0) : value;
}

const RANGES: Record<Exclude<ValueType, 'float'>, [number, number]> = { u8: [0, 0xff], u16: [0, 0xffff], u32: [0, 0xffffffff], s16: [-0x8000, 0x7fff] };

/** A typed value: decimal, or hexadecimal with a 0x prefix; a decimal for a float. */
export function parseValue(type: ValueType, text: string): number {
  const t = text.trim();
  const n = /^-?0x[0-9a-f]+$/i.test(t) ? Number(t) : /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
  if (Number.isNaN(n)) throw new Refused(`"${t}" is not a number`);
  if (type === 'float') return n;
  const [lo, hi] = RANGES[type];
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Refused(`${type} takes a whole number from ${lo} to ${hi}`);
  return n;
}

export function formatValue(type: ValueType, value: number): string {
  if (type === 'float') return Number.isInteger(value) ? value.toFixed(1) : String(Number(value.toPrecision(7)));
  return String(value);
}

export interface Watch {
  id: number;
  addr: number;
  type: ValueType;
}

export interface WatchRow extends Watch {
  value: number;
  frozen: boolean;
}

export interface SearchSnapshot {
  type: ValueType;
  /** Addresses still possible; null before the first filter (every address is). */
  count: number | null;
  hits: { addr: number; value: number }[];
}

export interface MemorySnapshot {
  running: boolean;
  /** Address of the first byte of the window. */
  start: number;
  bytes: Uint8Array;
  /** Refreshes since each byte last changed (255: not seen to change). */
  age: Uint8Array;
  watches: WatchRow[];
  search: SearchSnapshot | null;
  /** Why writes are refused now; undefined when they are allowed. */
  refusal: string | undefined;
}

export const EMPTY_MEMORY: MemorySnapshot = { running: false, start: RDRAM_BASE, bytes: new Uint8Array(WINDOW_BYTES), age: new Uint8Array(WINDOW_BYTES).fill(255), watches: [], search: null, refusal: 'no game is running' };

const WATCH_KEY = 'zelda-oot-js:watches';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function loadWatches(store: Store | null = defaultStore()): Watch[] {
  try {
    const raw = JSON.parse(store?.getItem(WATCH_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    const watches: Watch[] = [];
    for (const w of raw as Partial<Watch>[]) {
      if (w && typeof w.addr === 'number' && VALUE_TYPES.includes(w.type as ValueType) && w.addr >= RDRAM_BASE && w.addr + sizeOf(w.type as ValueType) <= RDRAM_END) {
        watches.push({ id: watches.length + 1, addr: w.addr, type: w.type as ValueType });
      }
    }
    return watches;
  } catch {
    return [];
  }
}

export type SearchKind = 'equal' | 'changed' | 'unchanged';

interface SearchState {
  type: ValueType;
  /** RDRAM as it was at the last search step. */
  before: Uint8Array;
  /** Offsets into RDRAM still possible; null while every aligned offset is. */
  candidates: Uint32Array | null;
}

export class MemoryModel {
  private start = RDRAM_BASE;
  private prev: Uint8Array | null = null;
  private age = new Uint8Array(WINDOW_BYTES).fill(255);
  private watches: Watch[];
  private nextWatchId: number;
  private search: SearchState | null = null;

  constructor(private readonly store: Store | null = defaultStore()) {
    this.watches = loadWatches(store);
    this.nextWatchId = this.watches.length + 1;
  }

  /** Moves the window to the 16-byte row holding `addr`, kept inside RDRAM. */
  setStart(addr: number): void {
    const row = Math.floor((addr - RDRAM_BASE) / ROW_BYTES) * ROW_BYTES;
    this.start = RDRAM_BASE + Math.max(0, Math.min(row, RDRAM_SIZE - WINDOW_BYTES));
    this.prev = null;
    this.age.fill(255);
  }

  get windowStart(): number {
    return this.start;
  }

  /** Reads the window, the watches and the search hits; call about ten times a second. */
  tick(bridge: Bridge): MemorySnapshot {
    const ram = bridge.bytes();
    if (!ram) return EMPTY_MEMORY;
    const at = this.start & 0x7fffff;
    const bytes = ram.slice(at, at + WINDOW_BYTES);
    if (this.prev) {
      for (let i = 0; i < WINDOW_BYTES; i++) this.age[i] = bytes[i] !== this.prev[i] ? 0 : Math.min(this.age[i]! + 1, 255);
    }
    this.prev = bytes;
    const frozen = bridge.freezes.list();
    return {
      running: true,
      start: this.start,
      bytes,
      age: this.age.slice(),
      watches: this.watches.map((w) => ({ ...w, value: readTyped(ram, w.addr, w.type), frozen: frozen.some((f) => !f.owner && f.addr === w.addr && f.size === sizeOf(w.type)) })),
      search: this.search ? this.searchSnapshot(ram) : null,
      refusal: bridge.unsafeReason(),
    };
  }

  private save(): void {
    try {
      this.store?.setItem(WATCH_KEY, JSON.stringify(this.watches.map(({ addr, type }) => ({ addr, type }))));
    } catch {
      // Storage is blocked or full: the watches last until the page closes.
    }
  }

  addWatch(addr: number, type: ValueType): void {
    if (addr + sizeOf(type) > RDRAM_END) throw new Refused(`${hexAddress(addr)} is outside the 8 MB of memory`);
    if (this.watches.some((w) => w.addr === addr && w.type === type)) return;
    this.watches = [...this.watches, { id: this.nextWatchId++, addr, type }];
    this.save();
  }

  removeWatch(bridge: Bridge, id: number): void {
    const w = this.watches.find((x) => x.id === id);
    if (!w) return;
    this.release(bridge, w);
    this.watches = this.watches.filter((x) => x.id !== id);
    this.save();
  }

  private holdOf(bridge: Bridge, w: Watch) {
    return bridge.freezes.list().find((f) => !f.owner && f.addr === w.addr && f.size === sizeOf(w.type));
  }

  private release(bridge: Bridge, w: Watch): void {
    const f = this.holdOf(bridge, w);
    if (f) bridge.freezes.remove(f.id);
  }

  /** Holds a watch at its current value, or releases it. */
  toggleHold(bridge: Bridge, id: number): string {
    const w = this.watches.find((x) => x.id === id);
    if (!w) throw new Refused('That watch is gone');
    if (this.holdOf(bridge, w)) {
      this.release(bridge, w);
      return `Released ${hexAddress(w.addr)}`;
    }
    const ram = bridge.bytes();
    if (!ram) throw new Refused('Not now: no game is running');
    bridge.freezes.add(w.addr, sizeOf(w.type), bitsOf(w.type, readTyped(ram, w.addr, w.type)));
    return `Holding ${hexAddress(w.addr)}`;
  }

  /** Writes a typed value; a watch held at that address keeps the new value. Refused in a state that does not take changes. */
  write(bridge: Bridge, addr: number, type: ValueType, text: string): string {
    const bits = bitsOf(type, parseValue(type, text));
    const size = sizeOf(type);
    if (addr + size > RDRAM_END) throw new Refused(`${hexAddress(addr)} is outside the 8 MB of memory`);
    writeValue(bridge.writable(), addr, size, bits);
    const f = bridge.freezes.list().find((h) => !h.owner && h.addr === addr && h.size === size);
    if (f) bridge.freezes.add(addr, size, bits);
    return `Wrote ${text.trim()} (${type}) to ${hexAddress(addr)}`;
  }

  writeWatch(bridge: Bridge, id: number, text: string): string {
    const w = this.watches.find((x) => x.id === id);
    if (!w) throw new Refused('That watch is gone');
    return this.write(bridge, w.addr, w.type, text);
  }

  /** Takes the first snapshot of a search over every aligned `type` value in RDRAM. */
  startSearch(bridge: Bridge, type: ValueType): string {
    const ram = bridge.bytes();
    if (!ram) throw new Refused('Not now: no game is running');
    this.search = { type, before: ram.slice(0, RDRAM_SIZE), candidates: null };
    return 'Search started: change the value in the game, then narrow it';
  }

  endSearch(): void {
    this.search = null;
  }

  /** Keeps the addresses whose value is `text`, changed, or did not change since the last step. */
  narrow(bridge: Bridge, kind: SearchKind, text = ''): string {
    const s = this.search;
    const ram = bridge.bytes();
    if (!s) throw new Refused('Start a search first');
    if (!ram) throw new Refused('Not now: no game is running');
    const size = sizeOf(s.type);
    const wanted = kind === 'equal' ? bitsOf(s.type, parseValue(s.type, text)) : 0;
    const now = view(ram);
    const was = view(s.before);
    const read = (dv: DataView, off: number) => (size === 1 ? dv.getUint8(off) : size === 2 ? dv.getUint16(off) : dv.getUint32(off));
    const keep = (off: number): boolean => {
      if (kind === 'equal') return read(now, off) === wanted;
      const same = read(now, off) === read(was, off);
      return kind === 'unchanged' ? same : !same;
    };
    const total = Math.floor(RDRAM_SIZE / size);
    const source = s.candidates;
    const length = source ? source.length : total;
    const offsetAt = (i: number) => (source ? source[i]! : i * size);
    let count = 0;
    for (let i = 0; i < length; i++) if (keep(offsetAt(i))) count++;
    const next = new Uint32Array(count);
    let n = 0;
    for (let i = 0; i < length; i++) if (keep(offsetAt(i))) next[n++] = offsetAt(i);
    s.candidates = next;
    s.before.set(ram.subarray(0, RDRAM_SIZE));
    return `${count} address${count === 1 ? '' : 'es'} left`;
  }

  private searchSnapshot(ram: Uint8Array): SearchSnapshot {
    const s = this.search!;
    const hits = [];
    if (s.candidates) {
      for (let i = 0; i < Math.min(s.candidates.length, MAX_HITS); i++) {
        const addr = RDRAM_BASE + s.candidates[i]!;
        hits.push({ addr, value: readTyped(ram, addr, s.type) });
      }
    }
    return { type: s.type, count: s.candidates ? s.candidates.length : null, hits };
  }
}
