// Reads the command list at the start of a scene or room file, and the structures its commands point to.
//
// The list is a run of 8-byte commands: command number, one byte of operand, two zero bytes, then a segmented address
// (segment number in the top byte). The game's interpreter at 0x80081D60 stops at command 0x14 and dispatches the other
// numbers below 26 through a table of 26 handlers.
import type { FileEntry } from '../rom/filetable.ts';
import type { Range } from './dlscan.ts';

export const END_COMMAND = 0x14;
export const COMMAND_COUNT = 26;

export interface SceneCommand {
  id: number;
  /** The operand byte (a count for the commands that point to arrays). */
  operand: number;
  /** The second word. */
  value: number;
}

export interface Mesh {
  /** Number of the command that points to the header. */
  command: number;
  /** Offset of the mesh header in the room file. */
  offset: number;
  type: number;
  /** Display lists, (opaque, translucent) per entry; 0 for none. File offsets. */
  entries: [number, number][];
}

/** Commands of a file, or null when the start of the file is not a command list ending with the end command. */
export function readCommands(bytes: Uint8Array): SceneCommand[] | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: SceneCommand[] = [];
  for (let o = 0; o + 8 <= bytes.length; o += 8) {
    const id = dv.getUint8(o);
    if (id >= COMMAND_COUNT || dv.getUint16(o + 2) !== 0) return null;
    out.push({ id, operand: dv.getUint8(o + 1), value: dv.getUint32(o + 4) });
    if (id === END_COMMAND) return out;
  }
  return null;
}

/** The room files a scene lists: an array of (virtual start, virtual end) pairs, `operand` of them, in segment 2. */
export function roomList(scene: Uint8Array, commands: SceneCommand[], files: FileEntry[]): { file: number; at: number }[] {
  const dv = new DataView(scene.buffer, scene.byteOffset, scene.byteLength);
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  for (const c of commands) {
    if (c.value >>> 24 !== 2) continue;
    const at = c.value & 0xffffff;
    if (c.operand === 0 || at + c.operand * 8 > scene.length || at % 4 !== 0) continue;
    const rooms: { file: number; at: number }[] = [];
    for (let k = 0; k < c.operand; k++) {
      const f = byStart.get(dv.getUint32(at + k * 8));
      if (!f || dv.getUint32(at + k * 8 + 4) !== f.virtualEnd) break;
      rooms.push({ file: f.index, at: at + k * 8 });
    }
    if (rooms.length === c.operand) return rooms;
  }
  return [];
}

/**
 * The mesh header of a room: a type byte, an entry count, then pointers to the first and last entry. Each entry is
 * (opaque, translucent) display-list pointers, preceded by four s16 for the culling type. Validated against the room's
 * display lists: every non-zero pointer must be the start of one.
 */
export function readMesh(room: Uint8Array, commands: SceneCommand[], lists: Range[]): Mesh | null {
  const dv = new DataView(room.buffer, room.byteOffset, room.byteLength);
  const starts = new Set(lists.map((l) => l.start));
  for (const c of commands) {
    if (c.value >>> 24 !== 3) continue;
    const h = c.value & 0xffffff;
    if (h + 12 > room.length) continue;
    const type = dv.getUint8(h), count = dv.getUint8(h + 1);
    const first = dv.getUint32(h + 4);
    if (type > 2 || count === 0 || first >>> 24 !== 3) continue;
    const entrySize = type === 2 ? 16 : 8;
    const pointersAt = (first & 0xffffff) + (type === 2 ? 8 : 0);
    if (pointersAt + (count - 1) * entrySize + 8 > room.length) continue;
    const entries: [number, number][] = [];
    let ok = true;
    for (let k = 0; k < count && ok; k++) {
      const pair = [dv.getUint32(pointersAt + k * entrySize), dv.getUint32(pointersAt + k * entrySize + 4)];
      for (const p of pair) if (p !== 0 && (p >>> 24 !== 3 || !starts.has(p & 0xffffff))) ok = false;
      entries.push([pair[0]! & 0xffffff, pair[1]! & 0xffffff]);
    }
    if (ok && entries.some(([a, b]) => a !== 0 || b !== 0)) return { command: c.id, offset: h, type, entries };
  }
  return null;
}

/** Object ids a room lists: `operand` 16-bit ids in segment 3, each below the number of objects. */
export function readObjectList(room: Uint8Array, commands: SceneCommand[], objectCount: number): { command: number; ids: number[] } | null {
  const dv = new DataView(room.buffer, room.byteOffset, room.byteLength);
  for (const c of commands) {
    if (c.value >>> 24 !== 3 || c.operand === 0) continue;
    const at = c.value & 0xffffff;
    if (at + c.operand * 2 > room.length || at % 2 !== 0) continue;
    const ids = Array.from({ length: c.operand }, (_, k) => dv.getUint16(at + k * 2));
    if (ids.every((id) => id > 0 && id < objectCount)) return { command: c.id, ids };
  }
  return null;
}
