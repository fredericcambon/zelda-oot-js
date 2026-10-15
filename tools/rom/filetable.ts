export interface FileEntry {
  index: number;
  /** Virtual address range the file occupies once decompressed. */
  virtualStart: number;
  virtualEnd: number;
  /** Range of the stored bytes in the ROM. */
  romStart: number;
  romEnd: number;
  compressed: boolean;
}

export interface FileTable {
  /** ROM offset of the first entry. */
  offset: number;
  entries: FileEntry[];
}

const ENTRY_SIZE = 16;
const MIN_ENTRIES = 64;

function entryAt(v: DataView, off: number) {
  return {
    virtualStart: v.getUint32(off),
    virtualEnd: v.getUint32(off + 4),
    physStart: v.getUint32(off + 8),
    physEnd: v.getUint32(off + 12),
  };
}

/**
 * Finds the file table by structure, not by a fixed offset: it is the longest
 * run of 16-byte records `{vstart, vend, pstart, pend}` that are aligned,
 * non-empty, ordered by virtual address and inside the image, where `pend` is
 * 0 for stored files and the end of the Yaz0 stream for compressed ones. The
 * run must start with the file that maps virtual 0 to ROM 0, and the table
 * itself must lie inside one of its files.
 */
export function locateFileTable(rom: Uint8Array): FileTable {
  const v = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const valid = (off: number, prevEnd: number) => {
    const e = entryAt(v, off);
    if (e.virtualStart >= e.virtualEnd || e.virtualStart < prevEnd) return false;
    if ((e.virtualStart | e.virtualEnd | e.physStart) % 16 !== 0) return false;
    if (e.physEnd === 0) return e.physStart + (e.virtualEnd - e.virtualStart) <= rom.length;
    return e.physEnd > e.physStart && e.physEnd <= rom.length;
  };

  let best = { offset: -1, count: 0 };
  for (let off = 0; off + ENTRY_SIZE <= rom.length; ) {
    let count = 0;
    let prevEnd = 0;
    while (off + (count + 1) * ENTRY_SIZE <= rom.length && valid(off + count * ENTRY_SIZE, prevEnd)) {
      prevEnd = v.getUint32(off + count * ENTRY_SIZE + 4);
      count++;
    }
    if (count > best.count) best = { offset: off, count };
    off += count > 0 ? count * ENTRY_SIZE : ENTRY_SIZE;
  }
  if (best.count < MIN_ENTRIES) throw new Error('file table not found in ROM');

  const entries: FileEntry[] = [];
  for (let i = 0; i < best.count; i++) {
    const e = entryAt(v, best.offset + i * ENTRY_SIZE);
    const compressed = e.physEnd !== 0;
    entries.push({
      index: i,
      virtualStart: e.virtualStart,
      virtualEnd: e.virtualEnd,
      romStart: e.physStart,
      romEnd: compressed ? e.physEnd : e.physStart + (e.virtualEnd - e.virtualStart),
      compressed,
    });
  }
  const first = entries[0]!;
  if (first.virtualStart !== 0 || first.romStart !== 0) {
    throw new Error('file table does not start at virtual 0 / ROM 0');
  }
  if (!entries.some((e) => e.romStart <= best.offset && best.offset < e.romEnd)) {
    throw new Error('file table is not inside any of its own files');
  }
  return { offset: best.offset, entries };
}
