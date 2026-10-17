// The display-list interpreter that lives in the wasm module (runtime/gfx/), and a reader that turns the buffers it
// writes into the DisplayListResult of dl.ts. Float arrays and decoded images are views into the module's memory, valid
// until the next run (and not across a growth of the memory: read the result right after the run).
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emcc, GFX_DIR } from '../port/build.ts';
import { repoRoot, type Toolchain } from '../recomp/toolchain.ts';
import {
  decodeCombine, type Batch, type DecodedTexture, type DisplayListResult, type DrawState, type RunOptions, type TileState,
} from './dl.ts';

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

/** Words of the records of the result (GfxResult, GfxBatch, GfxState, GfxTextureRef, GfxUnknown in runtime/gfx/gfx.h). */
const RESULT_WORDS = 17;
const BATCH_WORDS = 13;
const STATE_WORDS = 177;
const TEXTURE_WORDS = 4;
const UNKNOWN_WORDS = 3;
const PROBLEM_BYTES = 160;
const TILE_WORDS = 16;

type Tuple17 = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];

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
    return { width, height, rgba: heap.subarray(rgba, rgba + width * height * 4), tile: 0 };
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
    problems.push(Buffer.from(heap.subarray(start, end)).toString('latin1'));
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

const GFX_EXPORTS = ['_malloc', '_free', '_gfx_run_ram', '_gfx_result', '_gfx_reset', '_gfx_layout'];

/** Builds the interpreter alone into a module under `outDir` (rebuilt when a source is newer) and loads it. */
export async function loadGfxModule(toolchain: Toolchain, outDir: string): Promise<GfxCore> {
  const sources = readdirSync(GFX_DIR).filter((f) => (f.endsWith('.c') && f !== 'task.c') || f.endsWith('.h')).map((f) => join(GFX_DIR, f));
  const out = join(outDir, 'gfx.mjs');
  const newest = Math.max(...sources.map((s) => statSync(s).mtimeMs));
  if (!existsSync(out) || statSync(out).mtimeMs < newest) {
    mkdirSync(outDir, { recursive: true });
    const r = await emcc(toolchain, [
      '-O2', '-ffp-contract=off', '-Wall', '-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
      `-sEXPORTED_FUNCTIONS=${GFX_EXPORTS.join(',')}`, '-sEXPORTED_RUNTIME_METHODS=HEAPU8',
      ...sources.filter((s) => s.endsWith('.c')), '-o', out,
    ], repoRoot);
    if (r.code !== 0) throw new Error(`the interpreter failed to build:\n${r.output.slice(0, 4000)}`);
  }
  const factory = (await import(/* @vite-ignore */ `${pathToFileURL(out).href}?${statSync(out).mtimeMs}`)).default as (opts: object) => Promise<GfxCore>;
  return factory({ print: () => {}, printErr: (m: string) => console.error(m) });
}
