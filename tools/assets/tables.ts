// Finds the tables of file ranges in the main code file's data: runs of records that each hold the virtual start and
// end of a file of the file table, the way the game's loaders read them to fetch a file.
import type { FileEntry } from '../rom/filetable.ts';

export interface TableMember {
  /** Record number inside the table. */
  record: number;
  /** Byte offset of the pair inside the record. */
  field: number;
  file: number;
}

export interface RangeTable {
  /** Offset of the first record in the code file. */
  offset: number;
  stride: number;
  /** Number of records, empty ones (a zero pair) included. */
  records: number;
  members: TableMember[];
}

const MAX_STRIDE = 64;
/** A table needs this many records that name a file; shorter runs are coincidences of two adjacent words. */
const MIN_MEMBERS = 3;

/**
 * A pair is two adjacent words equal to a file's virtual start and end. Records of one table sit `stride` bytes
 * apart, so the pairs of a table form an arithmetic sequence; records that hold nothing do not break it.
 */
export function findRangeTables(data: Uint8Array, from: number, files: FileEntry[]): RangeTable[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const byStart = new Map(files.filter((f) => f.virtualStart > 0).map((f) => [f.virtualStart, f]));
  const pairAt = new Map<number, number>();
  for (let o = from; o + 8 <= data.length; o += 4) {
    const f = byStart.get(dv.getUint32(o));
    if (f && dv.getUint32(o + 4) === f.virtualEnd) pairAt.set(o, f.index);
  }
  // An unused record is a zero pair, or a file's start twice (an empty range).
  const isEmpty = (o: number) => o >= 0 && o + 8 <= data.length && dv.getUint32(o + 4) === dv.getUint32(o) && (dv.getUint32(o) === 0 || byStart.has(dv.getUint32(o)));

  const taken = new Set<number>();
  const tables: RangeTable[] = [];
  const positions = [...pairAt.keys()].sort((a, b) => a - b);
  // Longest run first, so that a table is not cut into pieces by a shorter stride that happens to fit part of it.
  const runs: { start: number; stride: number; positions: number[]; end: number }[] = [];
  for (const o of positions) {
    for (let stride = 8; stride <= MAX_STRIDE; stride += 4) {
      if (pairAt.has(o - stride) || (isEmpty(o - stride) && pairAt.has(o - 2 * stride))) continue;
      const hit = [o];
      let q = o + stride, end = o + 8;
      for (;;) {
        if (pairAt.has(q)) { hit.push(q); end = q + 8; } else if (!isEmpty(q)) break;
        q += stride;
        if (q + 8 > data.length) break;
      }
      if (hit.length >= MIN_MEMBERS) runs.push({ start: o, stride, positions: hit, end });
    }
  }
  runs.sort((a, b) => b.positions.length - a.positions.length || a.stride - b.stride);
  for (const run of runs) {
    if (run.positions.some((p) => taken.has(p))) continue;
    for (const p of run.positions) taken.add(p);
    // Unused records in front of the first used one still count: the game indexes from the real start of the table.
    let start = run.start;
    while (start - run.stride >= from && isEmpty(start - run.stride)) start -= run.stride;
    const members = run.positions.map((p) => ({ record: Math.round((p - start) / run.stride), field: 0, file: pairAt.get(p)! }));
    tables.push({ offset: start, stride: run.stride, records: Math.round((run.end - start) / run.stride), members });
  }
  return mergeFields(tables.sort((a, b) => a.offset - b.offset));
}

/**
 * Two runs of the same stride whose starts differ by less than the stride are two fields of one table (a record that
 * holds two ranges): fold them into one table with the field offsets set.
 */
function mergeFields(tables: RangeTable[]): RangeTable[] {
  const out: RangeTable[] = [];
  for (const t of tables) {
    const base = out.find((b) => b.stride === t.stride && t.offset > b.offset && t.offset < b.offset + b.stride && b.members.some((m) => m.field === 0));
    if (!base) {
      out.push({ ...t, members: [...t.members] });
      continue;
    }
    const field = t.offset - base.offset;
    for (const m of t.members) base.members.push({ ...m, field });
    base.records = Math.max(base.records, t.records);
  }
  return out;
}
