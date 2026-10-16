// Finds skeleton headers (a table of limb pointers) and animation headers in an object file's bytes by their layout.
import type { Range } from './dlscan.ts';

export interface Limb {
  offset: number;
  child: number;
  sibling: number;
  /** File offset of the limb's display list, or -1 when it has none. */
  list: number;
}

export interface Skeleton {
  /** File offset of the header (limb table pointer, limb count). */
  offset: number;
  limbTable: number;
  limbCount: number;
  limbs: Limb[];
}

export interface Animation {
  offset: number;
  frames: number;
  frameData: number;
  jointIndices: number;
  /** Indices below this number name a constant value, not a per-frame track. */
  staticIndexMax: number;
}

/** A limb: three s16 offsets, child and sibling indices (0xFF for none), one display-list pointer. */
const LIMB_BYTES = 12;
const NONE = 0xff;
const MAX_LIMBS = 64;
/** The game's longest animation is well under this many frames. */
const MAX_FRAMES = 2000;

const inFile = (addr: number, segment: number, size: number) => addr >>> 24 === segment && (addr & 0xffffff) < size;

export function findSkeletons(bytes: Uint8Array, segment: number, lists: Range[]): Skeleton[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const listStarts = new Set(lists.map((l) => l.start));
  const out: Skeleton[] = [];
  for (let o = 0; o + 8 <= bytes.length; o += 4) {
    const table = dv.getUint32(o);
    const count = dv.getUint8(o + 4);
    if (!inFile(table, segment, bytes.length) || count < 2 || count > MAX_LIMBS || (table & 3) !== 0) continue;
    const tableOff = table & 0xffffff;
    if (tableOff + count * 4 > bytes.length || dv.getUint16(o + 6) !== 0) continue;
    const limbs: Limb[] = [];
    let ok = true;
    let withList = 0;
    for (let i = 0; i < count && ok; i++) {
      const p = dv.getUint32(tableOff + i * 4);
      if (!inFile(p, segment, bytes.length) || (p & 3) !== 0 || (p & 0xffffff) + LIMB_BYTES > bytes.length) { ok = false; break; }
      const l = p & 0xffffff;
      const child = dv.getUint8(l + 6), sibling = dv.getUint8(l + 7), dl = dv.getUint32(l + 8);
      if ((child !== NONE && child >= count) || (sibling !== NONE && sibling >= count)) { ok = false; break; }
      let list = -1;
      if (dl !== 0) {
        if (!inFile(dl, segment, bytes.length) || !listStarts.has(dl & 0xffffff)) { ok = false; break; }
        list = dl & 0xffffff;
        withList++;
      }
      limbs.push({ offset: l, child, sibling, list });
    }
    if (ok && withList > 0) out.push({ offset: o, limbTable: tableOff, limbCount: count, limbs });
  }
  return out;
}

/**
 * Animation headers: frame count, two pointers (frame values, per-limb index triples) and the static-index limit.
 * With the skeleton's limb count the index array must fit, and every index must name a value inside the frame data.
 */
export function findAnimations(bytes: Uint8Array, segment: number, limbCount: number): Animation[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Animation[] = [];
  for (let o = 0; o + 16 <= bytes.length; o += 4) {
    const frames = dv.getInt16(o);
    const frameData = dv.getUint32(o + 4), joints = dv.getUint32(o + 8);
    if (frames < 1 || frames > MAX_FRAMES || dv.getInt16(o + 2) !== 0) continue;
    if (!inFile(frameData, segment, bytes.length) || !inFile(joints, segment, bytes.length) || (frameData & 1) !== 0 || (joints & 1) !== 0) continue;
    const staticIndexMax = dv.getUint16(o + 12);
    const fd = frameData & 0xffffff, ji = joints & 0xffffff;
    const triples = limbCount + 1;
    if (ji + triples * 6 > bytes.length) continue;
    const values = Math.floor((bytes.length - fd) / 2);
    let ok = true;
    for (let k = 0; k < triples * 3 && ok; k++) {
      const idx = dv.getUint16(ji + k * 2);
      if (idx >= staticIndexMax ? idx + frames > values : idx >= values) ok = false;
    }
    if (ok) out.push({ offset: o, frames, frameData: fd, jointIndices: ji, staticIndexMax });
  }
  return out;
}
