// Reader for the display-list interpreter that lives in the wasm module (runtime/gfx/): turns the buffers it writes into
// the DisplayListResult of types.ts. Float arrays and decoded images are views into the module's memory, valid
// until the next run (and not across a growth of the memory: read the result right after the run).
import {
  decodeCombine, type Batch, type DecodedTexture, type DisplayListResult, type DrawState, type RunOptions, type TileState,
} from './types.ts';

/** The exports of the interpreter (runtime/gfx/dl.c). */
export interface GfxCore {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _free(ptr: number): void;
  _gfx_run_ram(ram: number, size: number, start: number, maxCommands: number): number;
  _gfx_result(): number;
  _gfx_reset(): void;
  _gfx_layout(what: number): number;
}

/** The vertex trace of the interpreter, for tests (runtime/gfx/gfx.h). */
export interface GfxTraceCore extends GfxCore {
  _gfx_trace_vertices(on: number): void;
  _gfx_vertex_trace(): number;
  _gfx_vertex_trace_length(): number;
}

/** A game module, whose interpreter runs over the module's own RDRAM. */
export interface GfxGameCore extends GfxCore {
  _gfx_run(start: number): number;
}

/** Runs the display list at `start` over the module's RDRAM and reads the result; valid until the next run. */
export function runDisplayList(core: GfxGameCore, start: number): DisplayListResult {
  core._gfx_run(start >>> 0);
  return readResult(core);
}

/** Words of the records of the result (GfxResult, GfxBatch, GfxState, GfxTextureRef, GfxUnknown in runtime/gfx/gfx.h). */
const RESULT_WORDS = 17;
const BATCH_WORDS = 13;
const STATE_WORDS = 177;
const TEXTURE_WORDS = 4;
const UNKNOWN_WORDS = 3;
const PROBLEM_BYTES = 160;
const TILE_WORDS = 16;

type Tuple17 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

const LATIN1 = new TextDecoder('latin1');
const KINDS = ['triangles', 'texrect', 'fillrect'] as const;

function checkLayout(core: GfxCore): void {
  const expected = [RESULT_WORDS, BATCH_WORDS, STATE_WORDS, TEXTURE_WORDS, UNKNOWN_WORDS, PROBLEM_BYTES];
  expected.forEach((want, what) => {
    const got = core._gfx_layout(what);
    if (got !== want) throw new Error(`the interpreter's record ${what} has ${got} words, the reader expects ${want}`);
  });
}

/** Reads the result of the last run. */
export function readResult(core: GfxCore): DisplayListResult {
  checkLayout(core);
  const heap = core.HEAPU8;
  const buffer = heap.buffer as ArrayBuffer;
  const header = new Uint32Array(buffer, core._gfx_result(), RESULT_WORDS);
  const [commands, batchCount, batchesAt, stateCount, statesAt, textureCount, texturesAt, vertexCount, positionsAt, colorsAt, uvsAt,
    problemCount, problemsAt, unknownCount, unknownAt, opcodeCount, opcodesAt] = Array.from(header) as number[] as Tuple17;
  const textureWords = new Uint32Array(buffer, texturesAt || 0, textureCount * TEXTURE_WORDS);
  const images: DecodedTexture[] = Array.from({ length: textureCount }, (_, i) => {
    const width = textureWords[i * TEXTURE_WORDS + 1]!, height = textureWords[i * TEXTURE_WORDS + 2]!;
    const rgba = textureWords[i * TEXTURE_WORDS + 3]!;
    return { id: textureWords[i * TEXTURE_WORDS]!, width, height, rgba: heap.subarray(rgba, rgba + width * height * 4), tile: 0 };
  });

  const stateWords = new Int32Array(buffer, statesAt || 0, stateCount * STATE_WORDS);
  const states: (DrawState | undefined)[] = new Array<DrawState | undefined>(stateCount);
  const stateOf = (index: number): DrawState => (states[index] ??= readState(stateWords, index * STATE_WORDS, images));

  const batchWords = new Int32Array(buffer, batchesAt || 0, batchCount * BATCH_WORDS);
  const positions = new Float32Array(buffer, positionsAt || 0, vertexCount * 4);
  const colors = new Float32Array(buffer, colorsAt || 0, vertexCount * 4);
  const uvs = new Float32Array(buffer, uvsAt || 0, vertexCount * 2);
  const batches: Batch[] = [];
  for (let i = 0; i < batchCount; i++) {
    const w = i * BATCH_WORDS;
    const kind = KINDS[batchWords[w]!]!;
    const state = stateOf(batchWords[w + 1]!);
    if (kind === 'triangles') {
      const first = batchWords[w + 2]!, count = batchWords[w + 3]!;
      batches.push({
        kind, state, positions: positions.subarray(first * 4, (first + count) * 4), colors: colors.subarray(first * 4, (first + count) * 4),
        uvs: uvs.subarray(first * 2, (first + count) * 2),
      });
    } else {
      batches.push({
        kind, state, xl: batchWords[w + 4]!, yl: batchWords[w + 5]!, xh: batchWords[w + 6]!, yh: batchWords[w + 7]!, tile: batchWords[w + 8]!,
        s: batchWords[w + 9]!, t: batchWords[w + 10]!, dsdx: batchWords[w + 11]!, dtdy: batchWords[w + 12]!,
      });
    }
  }

  const problems: string[] = [];
  for (let i = 0; i < problemCount; i++) {
    const start = problemsAt + i * PROBLEM_BYTES;
    let end = start;
    while (heap[end] !== 0) end++;
    problems.push(LATIN1.decode(heap.subarray(start, end)));
  }
  const unknownWords = new Uint32Array(buffer, unknownAt || 0, unknownCount * UNKNOWN_WORDS);
  const unknown = Array.from({ length: unknownCount }, (_, i) => ({
    addr: unknownWords[i * 3]!, w0: unknownWords[i * 3 + 1]!, w1: unknownWords[i * 3 + 2]!,
  }));
  const pairs = new Uint32Array(buffer, opcodesAt || 0, opcodeCount * 2);
  const opcodes = new Map<number, number>();
  for (let i = 0; i < opcodeCount; i++) opcodes.set(pairs[i * 2]!, pairs[i * 2 + 1]!);
  return { batches, commands, opcodes, unknown, problems };
}

function readTile(w: Int32Array, o: number): TileState {
  return {
    fmt: w[o]!, siz: w[o + 1]!, line: w[o + 2]!, tmem: w[o + 3]!, palette: w[o + 4]!, cmT: w[o + 5]!, maskT: w[o + 6]!, shiftT: w[o + 7]!,
    cmS: w[o + 8]!, maskS: w[o + 9]!, shiftS: w[o + 10]!, uls: w[o + 11]!, ult: w[o + 12]!, lrs: w[o + 13]!, lrt: w[o + 14]!, sized: w[o + 15] !== 0,
  };
}

/** One GfxState record, in the order of its fields. */
function readState(w: Int32Array, base: number, images: DecodedTexture[]): DrawState {
  let at = base;
  const next = (): number => w[at++]!;
  const unsigned = (): number => next() >>> 0;
  const geometryMode = unsigned(), otherModeH = unsigned(), otherModeL = unsigned();
  const combine = decodeCombine(unsigned(), unsigned());
  const primColor = { r: next(), g: next(), b: next(), a: next(), minLod: next(), lodFrac: next() };
  const rgba = () => ({ r: next(), g: next(), b: next(), a: next() });
  const envColor = rgba(), fogColor = rgba(), blendColor = rgba();
  const fillColor = unsigned();
  const texture = { on: next() !== 0, level: next(), tile: next(), scaleS: unsigned(), scaleT: unsigned() };
  const tiles = Array.from({ length: 8 }, () => {
    const t = readTile(w, at);
    at += TILE_WORDS;
    return t;
  });
  const refs = [next(), next()];
  const refTiles = [next(), next()];
  const textures = refs.map((ref, i) => (ref < 0 ? null : { ...images[ref]!, tile: refTiles[i]! })) as DrawState['textures'];
  const viewport = { scale: [next(), next(), next()] as [number, number, number], trans: [next(), next(), next()] as [number, number, number] };
  const scissor = { mode: next(), xh: next(), yh: next(), xl: next(), yl: next() };
  const colorImage = { fmt: next(), siz: next(), width: next(), addr: next() };
  const depthImage = unsigned();
  return {
    geometryMode, otherModeH, otherModeL, combine, primColor, envColor, fogColor, blendColor, fillColor, texture, tiles, textures, viewport,
    scissor, colorImage, depthImage,
  };
}

/** Runs the interpreter over a RAM image copied into the module's memory, as `DisplayListInterpreter.run` does. */
export class CDisplayListInterpreter {
  constructor(private readonly core: GfxCore) {}

  run(ram: Uint8Array, start: number, opts: RunOptions = {}): DisplayListResult {
    const copy = this.core._malloc(ram.length);
    this.core.HEAPU8.set(ram, copy);
    try {
      this.core._gfx_run_ram(copy, ram.length, start >>> 0, opts.maxCommands ?? 5_000_000);
      return readResult(this.core);
    } finally {
      this.core._free(copy);
    }
  }
}

/** The vertices of every vertex load since `_gfx_trace_vertices(1)`, as the module recorded them. */
export function readVertexTrace(core: GfxTraceCore): { w0: number; first: number; vertices: { clip: number[]; color: number[]; s: number; t: number }[] }[] {
  const length = core._gfx_vertex_trace_length();
  const data = new Float64Array(core.HEAPU8.buffer as ArrayBuffer, core._gfx_vertex_trace() || 0, length);
  const loads = [];
  for (let at = 0; at < length;) {
    const w0 = data[at]!, first = data[at + 1]!, count = data[at + 2]!;
    at += 3;
    const vertices = [];
    for (let i = 0; i < count; i++, at += 10) {
      vertices.push({ clip: Array.from(data.subarray(at, at + 4)), color: Array.from(data.subarray(at + 4, at + 8)), s: data[at + 8]!, t: data[at + 9]! });
    }
    loads.push({ w0, first, vertices });
  }
  return loads;
}

/** A copy of a result that stays valid after the next run (float arrays and images are copied; shared ones stay shared). */
export function copyResult(result: DisplayListResult): DisplayListResult {
  const pixels = new Map<Uint8Array, Uint8Array>();
  const copyImage = (image: DecodedTexture | null): DecodedTexture | null => {
    if (!image) return null;
    let rgba = pixels.get(image.rgba);
    if (!rgba) pixels.set(image.rgba, (rgba = image.rgba.slice()));
    return { ...image, rgba };
  };
  const states = new Map<DrawState, DrawState>();
  const copyState = (state: DrawState): DrawState => {
    let copy = states.get(state);
    if (!copy) {
      copy = { ...state, textures: [copyImage(state.textures[0]), copyImage(state.textures[1])] };
      states.set(state, copy);
    }
    return copy;
  };
  const batches = result.batches.map((b): Batch =>
    b.kind === 'triangles'
      ? { ...b, state: copyState(b.state), positions: b.positions.slice(), colors: b.colors.slice(), uvs: b.uvs.slice() }
      : { ...b, state: copyState(b.state) });
  return { ...result, batches };
}
