// Finds, by structure, the tables in the main code file that name files of the file table: the object table, the
// scene table and the audio index tables. Each is checked against the code that reads it by `classify.ts`.

import type { FileEntry } from '../rom/filetable.ts';

export interface RecordTable {
  /** RAM address of the first record. */
  address: number;
  stride: number;
  /** Records, blank ones included. */
  count: number;
}

export interface CodeData {
  base: number;
  bytes: Uint8Array;
}

const word = (dv: DataView, o: number) => dv.getUint32(o);

/**
 * The longest run of records at one stride in which every record is either blank or names a file's exact virtual range.
 * Trailing blank records are not part of the run. `accept` is given the offset of a record and returns 'blank', 'valid' or false.
 */
function longestRun(code: CodeData, stride: number, step: number, accept: (dv: DataView, o: number) => 'blank' | 'valid' | false, minValid: number): RecordTable | undefined {
  const dv = new DataView(code.bytes.buffer, code.bytes.byteOffset, code.bytes.byteLength);
  let best: { start: number; count: number; valid: number } | undefined;
  for (let start = 0; start + stride <= code.bytes.length; start += step) {
    if (accept(dv, start) !== 'valid') continue;
    // Skip starts that continue a run beginning one record earlier: the earlier start finds the same run.
    if (start >= stride && accept(dv, start - stride) === 'valid') continue;
    let count = 0, valid = 0, lastValid = 0;
    for (let o = start; o + stride <= code.bytes.length; o += stride) {
      const a = accept(dv, o);
      if (a === false) break;
      count++;
      if (a === 'valid') { valid++; lastValid = count; }
    }
    if (valid >= minValid && (!best || valid > best.valid)) best = { start, count: lastValid, valid };
  }
  return best && { address: code.base + best.start, stride, count: best.count };
}

function fileRange(byStart: Map<number, FileEntry>, start: number, end: number): boolean {
  const f = byStart.get(start);
  return f !== undefined && f.virtualEnd === end;
}

/**
 * Records of eight bytes, `{virtual start, virtual end}`, with a blank first record. The longest such run in the
 * main code file is the object table.
 */
export function findObjectTable(code: CodeData, files: FileEntry[]): RecordTable | undefined {
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  const table = longestRun(code, 8, 8, (dv, o) => {
    const s = word(dv, o), e = word(dv, o + 4);
    // An object removed from the ROM keeps its slot with an empty range.
    if (s === e) return 'blank';
    return fileRange(byStart, s, e) ? 'valid' : false;
  }, 100);
  if (!table) return undefined;
  // The run's first record is id 0 and blank: the table starts one record earlier than the first named file.
  const dv = new DataView(code.bytes.buffer, code.bytes.byteOffset, code.bytes.byteLength);
  const first = table.address - code.base;
  if (first >= 8 && word(dv, first - 8) === 0 && word(dv, first - 4) === 0) return { ...table, address: table.address - 8, count: table.count + 1 };
  return table;
}

/**
 * Records of 20 bytes: `{scene start, scene end, title start, title end, four bytes}` where the title range is a file
 * or zero. The longest such run is the scene table.
 */
export function findSceneTable(code: CodeData, files: FileEntry[]): RecordTable | undefined {
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  return longestRun(code, 20, 4, (dv, o) => {
    if (!fileRange(byStart, word(dv, o), word(dv, o + 4))) return false;
    const ts = word(dv, o + 8), te = word(dv, o + 12);
    return (ts === 0 && te === 0) || fileRange(byStart, ts, te) ? 'valid' : false;
  }, 50);
}

export interface IndexTable {
  address: number;
  /** Records after the 16-byte header. */
  count: number;
  entries: { offset: number; size: number; medium: number; flags: number }[];
  /** Highest `offset + size`. */
  extent: number;
  /** The file whose size the entries fill. */
  file: FileEntry;
}

const MAX_INDEX_ENTRIES = 600;
const MIN_INDEX_EXTENT = 0x10000;
/** Entries end at the file's end, less padding up to this many bytes. */
const INDEX_PADDING = 0x40;

/**
 * Tables of `{u16 count, u16 medium, u32 base = 0, 8 bytes}` followed by 16-byte records `{offset, size, medium, ...}`
 * whose ranges fill one file of the file table (the audio loader adds the file's ROM address to every offset: the
 * routine at 0x800B77A8 stores `+4` and adds it to `+0x10` of each record).
 */
export function findIndexTables(code: CodeData, files: FileEntry[]): IndexTable[] {
  const dv = new DataView(code.bytes.buffer, code.bytes.byteOffset, code.bytes.byteLength);
  const out: IndexTable[] = [];
  for (let o = 0; o + 32 <= code.bytes.length; o += 4) {
    const count = dv.getInt16(o);
    if (count < 2 || count > MAX_INDEX_ENTRIES || dv.getUint16(o + 2) > 3 || word(dv, o + 4) !== 0) continue;
    if (o + 16 + count * 16 > code.bytes.length) continue;
    const entries: IndexTable['entries'] = [];
    let extent = 0, ok = true;
    for (let i = 0; i < count && ok; i++) {
      const e = o + 16 + i * 16;
      const offset = word(dv, e), size = word(dv, e + 4), medium = dv.getUint8(e + 8);
      if (medium > 4 || size > 0x1000000 || offset > 0x1000000) ok = false;
      entries.push({ offset, size, medium, flags: word(dv, e + 8) & 0xffffff });
      extent = Math.max(extent, offset + size);
    }
    if (!ok || extent < MIN_INDEX_EXTENT) continue;
    const file = files.find((f) => {
      const size = f.virtualEnd - f.virtualStart;
      return size >= extent && size - extent <= INDEX_PADDING;
    });
    if (file) out.push({ address: code.base + o, count, entries, extent, file });
  }
  return out;
}
