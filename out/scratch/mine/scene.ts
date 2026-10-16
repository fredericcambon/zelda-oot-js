// Scene and room headers: a list of 8-byte commands `{u8 id, u8 arg, u16 arg, u32 pointer-or-value}` that ends with id 0x14.
// The game runs the list with the routine at 0x80081D50, which calls the handler the command table names for ids below 26
// (docs/re/assets.md).

import type { FileEntry } from '../rom/filetable.ts';
import type { CodeImage } from './xref.ts';
import { disassemble } from '../analyze/mips.ts';

export const END_COMMAND = 0x14;
export const ROOM_LIST_COMMAND = 4;
export const COMMAND_COUNT = 26;

export interface HeaderCommand {
  id: number;
  /** Byte 1 of the command (a count for list commands). */
  arg: number;
  /** Second word. */
  value: number;
  /** Offset in the file of the command. */
  offset: number;
}

export interface SceneHeader {
  commands: HeaderCommand[];
  /** Whether the list ended with the END command inside the file. */
  terminated: boolean;
}

/** Reads the commands from the start of the file; undefined when it does not look like a header. */
export function parseHeader(data: Uint8Array, maxCommands = 64): SceneHeader | undefined {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const commands: HeaderCommand[] = [];
  for (let o = 0; o + 8 <= data.length && commands.length < maxCommands; o += 8) {
    const id = data[o]!;
    if (id >= COMMAND_COUNT) return undefined;
    commands.push({ id, arg: data[o + 1]!, value: dv.getUint32(o + 4), offset: o });
    if (id === END_COMMAND) return { commands, terminated: true };
  }
  return undefined;
}

export interface RoomRef {
  /** Room number: the position in the room list. */
  room: number;
  file: FileEntry;
}

/**
 * The files the room-list command names: `arg` pairs `{virtual start, virtual end}` at the offset its pointer gives, in
 * the file's own segment. Pairs that are not file ranges are reported as errors.
 */
export function roomRefs(data: Uint8Array, header: SceneHeader, byStart: Map<number, FileEntry>): { rooms: RoomRef[]; errors: string[] } {
  const rooms: RoomRef[] = [];
  const errors: string[] = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const c of header.commands.filter((x) => x.id === ROOM_LIST_COMMAND)) {
    const at = c.value & 0xffffff;
    for (let r = 0; r < c.arg; r++) {
      if (at + r * 8 + 8 > data.length) { errors.push(`room ${r}: list runs past the end of the file`); break; }
      const f = byStart.get(dv.getUint32(at + r * 8));
      if (f && f.virtualEnd === dv.getUint32(at + r * 8 + 4)) rooms.push({ room: r, file: f });
      else errors.push(`room ${r}: pair at 0x${(at + r * 8).toString(16)} is not a file range`);
    }
  }
  return { rooms, errors };
}

export interface CommandTable {
  /** RAM address of the 26-entry table of handlers. */
  address: number;
  /** Handler address per command id; 0 for ids the table leaves empty. */
  handlers: number[];
  /** Address of the instruction that ends the table's use in the dispatcher (the `jalr`). */
  dispatchAt: number;
}

/**
 * The command table: a table of 26 words, each a code address or 0, built as a constant within a few instructions of a
 * `sltiu rt, rs, 26` (the bound check) and a `jalr` through the entry. Looked for in the main code file.
 */
export function findCommandTable(code: CodeImage, textStart: number, textEnd: number): CommandTable | undefined {
  const insns = disassemble(code.bytes.subarray(0, code.textSize), code.base);
  const dv = new DataView(code.bytes.buffer, code.bytes.byteOffset, code.bytes.byteLength);
  const isCode = (w: number) => w >= textStart && w < textEnd && w % 4 === 0;
  for (let k = 0; k < insns.length; k++) {
    const lui = insns[k]!;
    if (lui.op !== 'lui') continue;
    for (let j = k + 1; j < Math.min(k + 6, insns.length); j++) {
      const lo = insns[j]!;
      if (lo.op !== 'addiu' || lo.rs !== lui.rt) continue;
      const address = (((lui.imm << 16) + ((lo.imm << 16) >> 16)) >>> 0);
      const offset = address - code.base;
      if (offset < code.textSize || offset + COMMAND_COUNT * 4 > code.bytes.length) break;
      const handlers = Array.from({ length: COMMAND_COUNT }, (_, i) => dv.getUint32(offset + i * 4));
      const filled = handlers.filter((w) => w !== 0);
      if (filled.length < COMMAND_COUNT - 8 || !filled.every(isCode)) break;
      const window = insns.slice(k, k + 24);
      const bound = window.some((i) => i.op === 'sltiu' && i.imm === COMMAND_COUNT);
      const call = window.find((i) => i.kind === 'jalr');
      if (bound && call) return { address, handlers, dispatchAt: call.addr };
      break;
    }
  }
  return undefined;
}
