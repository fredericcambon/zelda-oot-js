// Finds the audio tables in the main code file's data and ties each one to the file whose ranges it lists.
//
// A table is a 16-byte header (a 16-bit entry count, then zeros) followed by 16-byte entries: offset and size inside the
// file, a medium byte (2 = the cartridge), a cache-policy byte and padding. An entry of size 0 is an alias that names
// another entry in its offset field.
import type { FileEntry } from '../rom/filetable.ts';

export interface AudioEntry {
  offset: number;
  size: number;
  medium: number;
  cache: number;
}

export type AudioKind = 'audio-bank' | 'sequence' | 'sample-table';

export interface AudioTable {
  kind: AudioKind;
  /** Offset of the header in the code file. */
  offset: number;
  entries: AudioEntry[];
  /** The file whose bytes the entries address. */
  file: number;
  /** Entries that hold data (size above 0). */
  ranges: number;
  /** For sequences: the table that maps each one to the banks it needs, as an offset in the code file; -1 when absent. */
  fontMap: number;
}

const MIN_ENTRIES = 4;
const MAX_ENTRIES = 1000;
const CARTRIDGE = 2;
/** The largest range of a table ends within this many bytes of the end of its file. */
const END_SLACK = 0x40;

function readTable(dv: DataView, o: number): AudioEntry[] | null {
  const count = dv.getUint16(o);
  if (count < MIN_ENTRIES || count > MAX_ENTRIES || o + 16 + count * 16 > dv.byteLength) return null;
  for (let i = 2; i < 16; i += 2) if (dv.getUint16(o + i) !== 0) return null;
  const entries: AudioEntry[] = [];
  for (let k = 0; k < count; k++) {
    const e = o + 16 + k * 16;
    if (dv.getUint8(e + 8) > 3) return null;
    entries.push({ offset: dv.getUint32(e), size: dv.getUint32(e + 4), medium: dv.getUint8(e + 8), cache: dv.getUint8(e + 9) });
  }
  return entries;
}

/** Every range of the entry list fits in the file, and the last one ends at the file's end. */
function fits(entries: AudioEntry[], size: number): boolean {
  let end = 0;
  for (const e of entries) {
    if (e.size === 0) continue;
    if (e.medium !== CARTRIDGE || e.offset + e.size > size) return false;
    end = Math.max(end, e.offset + e.size);
  }
  return end > 0 && size - end <= END_SLACK;
}

/** A bank starts with a list of offsets that all lie inside the bank. */
function bankLike(entries: AudioEntry[], file: Uint8Array): boolean {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const data = entries.filter((e) => e.size >= 16);
  return data.length > 0 && data.every((e) => [0, 4, 8, 12].every((k) => dv.getUint32(e.offset + k) < e.size));
}

/**
 * A byte array indexed by a 16-bit offset list: entry `i` is at `offsets[i]` and holds a count followed by that many
 * bytes. The first offset is the size of the list. Returns the offset of the list in the code file, or -1.
 */
function findFontMap(code: Uint8Array, from: number, sequences: number, banks: number): number {
  const dv = new DataView(code.buffer, code.byteOffset, code.length);
  for (let o = from; o + sequences * 2 < code.length; o += 2) {
    if (dv.getUint16(o) !== sequences * 2) continue;
    let ok = true;
    for (let k = 0; k < sequences && ok; k++) {
      const off = dv.getUint16(o + k * 2);
      if (k > 0 && off < dv.getUint16(o + k * 2 - 2)) ok = false;
      else if (o + off >= code.length) ok = false;
      else {
        const n = code[o + off]!;
        for (let b = 1; b <= n && ok; b++) if ((code[o + off + b] ?? 0xff) >= banks) ok = false;
      }
    }
    if (ok) return o;
  }
  return -1;
}

/**
 * The tables whose ranges tile one whole file each. A table of bank-like entries is the bank table; of the others, the
 * one that a map of bank lists (one per entry) belongs to is the sequence table, and the remaining one holds samples.
 */
export function findAudioTables(code: Uint8Array, from: number, files: FileEntry[], fileBytes: (i: number) => Uint8Array): AudioTable[] {
  const dv = new DataView(code.buffer, code.byteOffset, code.length);
  const found: { offset: number; entries: AudioEntry[]; file: number }[] = [];
  for (let o = (from + 15) & ~15; o + 16 <= code.length; o += 16) {
    const entries = readTable(dv, o);
    if (!entries) continue;
    // A stored file with no gaps to the next: the audio files are plain data, not compressed.
    const file = files.find((f) => !f.compressed && f.virtualEnd - f.virtualStart >= 0x1000 && fits(entries, f.virtualEnd - f.virtualStart));
    if (file) found.push({ offset: o, entries, file: file.index });
  }
  const banks = found.find((t) => bankLike(t.entries, fileBytes(t.file)));
  if (!banks) return [];
  const rest = found.filter((t) => t !== banks);
  const tables: AudioTable[] = [{ kind: 'audio-bank', offset: banks.offset, entries: banks.entries, file: banks.file, ranges: banks.entries.filter((e) => e.size > 0).length, fontMap: -1 }];
  for (const t of rest) {
    const map = findFontMap(code, from, t.entries.length, banks.entries.length);
    tables.push({ kind: map >= 0 ? 'sequence' : 'sample-table', offset: t.offset, entries: t.entries, file: t.file, ranges: t.entries.filter((e) => e.size > 0).length, fontMap: map });
  }
  return tables;
}
