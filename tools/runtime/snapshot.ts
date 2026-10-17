// Saves and loads the portable state of a running game module at a frame boundary.
//
// The runtime writes the state (rt_state_save in runtime/state.c): RDRAM, the registers and call chains of the guest
// threads in terms of the ROM's functions, and the variables of the runtime and its devices. It holds nothing of the
// wasm file that wrote it, so a state taken by one build loads into another. The module's memory, the fibers' stacks
// and Asyncify's bookkeeping are not part of it. The cartridge's save memory is left out too and keeps its contents
// when a state is loaded.
import type { OotCore } from './instance.ts';

/** The exports a state needs on top of the ones every host uses. */
export interface StateCore extends OotCore {
  _free(ptr: number): void;
  _oot_state_save(buf: number, cap: number): number;
  _oot_state_load(buf: number, len: number): void | Promise<void>;
  _oot_state_loaded(): number;
  _oot_state_error(): number;
}

/** The format version this file's description of a state matches (RT_STATE_VERSION in runtime/rt.h). */
export const STATE_VERSION = 1;

const MAGIC = 0x50544f4f; // "OOTP", little-endian
/** First word of the raw memory dump that states were before the portable format, written big-endian. */
const OLD_MAGIC = 0x4f4f5453;

export type StateFormat = { kind: 'portable'; version: number } | { kind: 'old' } | { kind: 'unknown' };

/** Tells which format a state is in from its first bytes (uncompressed). */
export function stateFormat(bytes: Uint8Array): StateFormat {
  if (bytes.length < 8) return { kind: 'unknown' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) === MAGIC) return { kind: 'portable', version: view.getUint32(4, true) };
  if (view.getUint32(0, false) === OLD_MAGIC) return { kind: 'old' };
  return { kind: 'unknown' };
}

/**
 * The portable state of the game; call between frames. Throws with the reason when the game is somewhere a state cannot
 * hold (while it boots, or with a thread in an unexpected place); the game then runs on.
 */
export function saveState(mod: StateCore): Uint8Array {
  const size = mod._oot_state_save(0, 0);
  if (size === 0) throw new Error(mod.UTF8ToString(mod._oot_state_error()));
  const buf = mod._malloc(size);
  try {
    if (mod._oot_state_save(buf, size) !== size) throw new Error(mod.UTF8ToString(mod._oot_state_error()));
    return mod.HEAPU8.slice(buf, buf + size);
  } finally {
    mod._free(buf);
  }
}

/**
 * Replaces the state of the game with a saved one, whichever build saved it. Throws with the reason when the state is refused
 * (another format version, a function or call site this build lacks, damaged data); the game then runs on as it was.
 */
export async function loadState(mod: StateCore, state: Uint8Array): Promise<void> {
  const buf = mod._malloc(state.length);
  try {
    mod.HEAPU8.set(state, buf);
    await mod._oot_state_load(buf, state.length);
    if (!mod._oot_state_loaded()) throw new Error(mod.UTF8ToString(mod._oot_state_error()));
  } finally {
    mod._free(buf);
  }
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** gzip, as states are kept. */
export const compressState = (bytes: Uint8Array) => through(bytes, new CompressionStream('gzip'));
export const decompressState = (bytes: Uint8Array) => through(bytes, new DecompressionStream('gzip'));
