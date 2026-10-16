// Saves and restores the whole state of a running game module at a frame boundary.
//
// Between two frames every guest thread is parked on its own fiber, and the fiber records (with the stacks Asyncify
// unwound them into), the scheduler, the devices and the guest's RDRAM all live in the module's linear memory.
// Outside the memory there is one thing: Asyncify numbers the exported functions a suspended stack was entered
// through, in the order they were first suspended, and each fiber's record holds such a number. The table of
// numbers lives in the module's JS, so a state carries it as indices into the module's list of exports. The host
// fiber is re-created by each frame and the rest of the Asyncify bookkeeping is idle between frames. So the memory
// and that table are the complete state, except for the cartridge image, which is read-only and stays where it is.
import type { OotCore } from './instance.ts';

/** The exports the snapshot needs on top of the ones every host uses. */
export interface SnapshotCore extends OotCore {
  Asyncify: AsyncifyRuntime;
  _free(ptr: number): void;
  _oot_rom_base(): number;
  _oot_rom_size(): number;
}

/** The parts of the module's Asyncify runtime that a state depends on (Emscripten's library_async.js). */
export interface AsyncifyRuntime {
  state: number;
  currData: number | null;
  exportCallStack: unknown[];
  callStackId: number;
  /** Original export function to the number its suspended stacks carry, and back. */
  callstackFuncToId: Map<unknown, number>;
  callStackIdToFunc: Map<number, unknown>;
  /** Every instrumented export, in export order. */
  funcWrappers: Map<unknown, unknown>;
}

const ASYNCIFY_NORMAL = 0;

export interface MemorySnapshot {
  /** Size in bytes of the module's memory when the state was taken. */
  length: number;
  /** The cartridge image, which is left out. */
  romStart: number;
  romEnd: number;
  /** Memory below and above the cartridge image. */
  head: Uint8Array;
  tail: Uint8Array;
  /** For each number Asyncify has handed out, in order, the position of its function among the module's exports. */
  asyncifyFunctions: number[];
}

const MAGIC = 0x4f4f5453; // "OOTS"
const HEADER_BYTES = 24;

/** Copies the module's memory (call between frames). */
export function captureMemory(mod: SnapshotCore): MemorySnapshot {
  const a = mod.Asyncify;
  if (a.state !== ASYNCIFY_NORMAL || a.currData !== null || a.exportCallStack.length > 0) throw new Error('the game is in the middle of a frame');
  const exports = [...a.funcWrappers.keys()];
  const asyncifyFunctions = Array.from({ length: a.callStackId }, (_, id) => exports.indexOf(a.callStackIdToFunc.get(id)));
  if (asyncifyFunctions.includes(-1)) throw new Error('Asyncify refers to a function that is not an export');
  const heap = mod.HEAPU8;
  const romStart = mod._oot_rom_base();
  const romEnd = romStart + mod._oot_rom_size();
  return { length: heap.length, romStart, romEnd, head: heap.slice(0, romStart), tail: heap.slice(romEnd), asyncifyFunctions };
}

/**
 * Puts a captured state back into a module that was booted from the same build and the same cartridge image
 * (so that the image sits at the same address). The save memory (the cartridge's SRAM), which the user's saved
 * games live in, keeps the contents it has now.
 */
export function restoreMemory(mod: SnapshotCore, snap: MemorySnapshot): void {
  if (mod._oot_rom_base() !== snap.romStart || mod._oot_rom_base() + mod._oot_rom_size() !== snap.romEnd) {
    throw new Error('the saved state was taken with a different cartridge image');
  }
  // The module grows when an allocation does not fit. The blocks are returned at once, and the copy below overwrites the allocator's records of them.
  const probes: number[] = [];
  while (mod.HEAPU8.length < snap.length) {
    const before = mod.HEAPU8.length;
    probes.push(mod._malloc(snap.length - before + 0x10000));
    if (mod.HEAPU8.length === before && probes.length > 8) throw new Error('the module cannot grow to the size of the saved state');
  }
  probes.forEach((p) => mod._free(p));
  const a = mod.Asyncify;
  const exports = [...a.funcWrappers.keys()];
  a.callstackFuncToId.clear();
  a.callStackIdToFunc.clear();
  snap.asyncifyFunctions.forEach((index, id) => {
    a.callstackFuncToId.set(exports[index], id);
    a.callStackIdToFunc.set(id, exports[index]);
  });
  a.callStackId = snap.asyncifyFunctions.length;
  const sramAt = mod._oot_sram();
  const sram = mod.HEAPU8.slice(sramAt, sramAt + mod._oot_sram_size());
  const heap = mod.HEAPU8;
  heap.set(snap.head, 0);
  heap.set(snap.tail, snap.romEnd);
  // Memory the module grew into after the state was taken did not exist then; the allocator expects it to be zero.
  heap.fill(0, snap.length);
  heap.set(sram, sramAt);
}

/** One buffer holding a state: a small header, then the memory below and above the cartridge image. */
export function encodeMemory(snap: MemorySnapshot): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + 4 * snap.asyncifyFunctions.length + snap.head.length + snap.tail.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC);
  view.setUint32(4, snap.length);
  view.setUint32(8, snap.romStart);
  view.setUint32(12, snap.romEnd);
  view.setUint32(16, snap.head.length);
  view.setUint32(20, snap.asyncifyFunctions.length);
  snap.asyncifyFunctions.forEach((index, k) => view.setUint32(HEADER_BYTES + 4 * k, index));
  const headAt = HEADER_BYTES + 4 * snap.asyncifyFunctions.length;
  out.set(snap.head, headAt);
  out.set(snap.tail, headAt + snap.head.length);
  return out;
}

export function decodeMemory(bytes: Uint8Array): MemorySnapshot {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || view.getUint32(0) !== MAGIC) throw new Error('not a saved game state');
  const length = view.getUint32(4);
  const romStart = view.getUint32(8);
  const romEnd = view.getUint32(12);
  const functions = view.getUint32(20);
  const headAt = HEADER_BYTES + 4 * functions;
  const headEnd = headAt + view.getUint32(16);
  if (view.getUint32(16) !== romStart || headEnd + (length - romEnd) !== bytes.length) throw new Error('the saved game state is damaged');
  const asyncifyFunctions = Array.from({ length: functions }, (_, k) => view.getUint32(HEADER_BYTES + 4 * k));
  return { length, romStart, romEnd, head: bytes.subarray(headAt, headEnd), tail: bytes.subarray(headEnd), asyncifyFunctions };
}
