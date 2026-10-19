// Shapes of a display-list result: the draw batches the interpreter in runtime/gfx/ produces, the render state each was
// drawn with, and the decoded textures. Renderers consume these; c-dl.ts reads them out of the module.

/** A decoded image: width x height RGBA8 texels, row-major, top row first. */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Texel formats of the RDP (the `fmt` field of SetTextureImage and SetTile). */
export const Fmt = { RGBA: 0, YUV: 1, CI: 2, IA: 3, I: 4 } as const;

/** Bits per texel (the `siz` field): 4, 8, 16 or 32. */
export const Siz = { B4: 0, B8: 1, B16: 2, B32: 3 } as const;

export interface TileState {
  fmt: number;
  siz: number;
  /** Row length in 64-bit TMEM words. */
  line: number;
  /** TMEM address in 64-bit words. */
  tmem: number;
  palette: number;
  cmT: number;
  maskT: number;
  shiftT: number;
  cmS: number;
  maskS: number;
  shiftS: number;
  /** Tile bounds in 10.2 fixed point texels. */
  uls: number;
  ult: number;
  lrs: number;
  lrt: number;
  /** True once SetTileSize has been executed for the tile. */
  sized: boolean;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PrimColor extends Rgba {
  minLod: number;
  lodFrac: number;
}

export interface CombineStage {
  /** Selector codes of the four inputs (A - B) * C + D of the colour and alpha equations, as the hardware numbers them. */
  rgb: [number, number, number, number];
  alpha: [number, number, number, number];
}

export interface Combine {
  raw: [number, number];
  /** Cycle 0 and cycle 1 (the second is used in two-cycle mode). */
  cycles: [CombineStage, CombineStage];
}

export interface Viewport {
  /** Scale and translation in 10.2 fixed point screen units, (x, y, z). */
  scale: [number, number, number];
  trans: [number, number, number];
}

export interface DecodedTexture extends RgbaImage {
  /** Names the image: the interpreter gives each decoded image a number that is never used again, so equal ids mean equal pixels. */
  id: number;
  /** Index of the tile descriptor the image was decoded for. */
  tile: number;
  /** Format and texel size of that tile. */
  fmt?: number;
  siz?: number;
  /** One byte per texel, 1 where the load commands that fed the tile wrote the texel; absent or null when all of them did (runtime/gfx/gfx.h). */
  loaded?: Uint8Array | null;
}

/** The render state a batch of primitives was drawn with. Immutable once stored in a batch. */
export interface DrawState {
  geometryMode: number;
  otherModeH: number;
  otherModeL: number;
  combine: Combine;
  primColor: PrimColor;
  envColor: Rgba;
  fogColor: Rgba;
  blendColor: Rgba;
  fillColor: number;
  texture: { on: boolean; level: number; tile: number; scaleS: number; scaleT: number };
  /** The eight tile descriptors. */
  tiles: TileState[];
  /** Decoded images of the tile the texture command names and the one after it; null when nothing is loaded for it. */
  textures: [DecodedTexture | null, DecodedTexture | null];
  viewport: Viewport;
  scissor: { mode: number; xh: number; yh: number; xl: number; yl: number };
  colorImage: { fmt: number; siz: number; width: number; addr: number };
  depthImage: number;
}

/** The lights a run of lit vertices is shaded with per pixel: colours are bytes, directions are in the vertices' model space (runtime/gfx/gfx.h). */
export interface LightSet {
  count: number;
  ambient: [number, number, number];
  /** Three floats per light, seven lights. */
  colors: Float32Array;
  dirs: Float32Array;
}

export interface TriangleBatch {
  kind: 'triangles';
  state: DrawState;
  /** Three consecutive vertices per triangle. Positions are clip-space (x, y, z, w), four floats each. */
  positions: Float32Array;
  /**
   * Colours in 0..1 (lit when lighting was on), four floats per vertex. With the geometry mode's fog bit the alpha is the
   * fog factor, as in the microcode's vertex records.
   */
  colors: Float32Array;
  /** Texture coordinates in texels (the S10.5 value times the texture command's scale, divided by 32), two floats per vertex. */
  uvs: Float32Array;
  /**
   * With pixel lighting on: four floats per vertex, the normal bytes and 1 where the triangle is lit per pixel with `lights` (its colour
   * is then ignored), else 0 (runtime/gfx/gfx.h).
   */
  normals?: Float32Array;
  lights?: LightSet;
}

export interface RectBatch {
  kind: 'texrect' | 'fillrect';
  state: DrawState;
  /** Corners in 10.2 fixed point screen units. */
  xl: number;
  yl: number;
  xh: number;
  yh: number;
  tile: number;
  /** Texture start and per-pixel steps for a texture rectangle, S10.5 and S5.10; zero for a fill rectangle. */
  s: number;
  t: number;
  dsdx: number;
  dtdy: number;
}

export type Batch = TriangleBatch | RectBatch;

export interface UnknownCommand {
  addr: number;
  w0: number;
  w1: number;
}

export interface DisplayListResult {
  batches: Batch[];
  /** Number of commands executed. */
  commands: number;
  /** How many times each first-byte opcode was executed. */
  opcodes: Map<number, number>;
  unknown: UnknownCommand[];
  /** Inconsistencies in the list that the interpreter worked around, such as a bad segment or a matrix underflow. */
  problems: string[];
  /** With pixel lighting on: triangles lit, of those the ones whose normals disagree with their faces and the ones with vertices lit differently (mixed), and the ones left on the vertex path. */
  lighting?: { lit: number; reversed: number; mixed: number; vertexPath: number };
}

export interface RunOptions {
  /** Stop after this many commands (a runaway list). */
  maxCommands?: number;
}

export function decodeCombine(w0: number, w1: number): Combine {
  const cycle0: CombineStage = {
    rgb: [(w0 >>> 20) & 15, (w1 >>> 28) & 15, (w0 >>> 15) & 31, (w1 >>> 15) & 7],
    alpha: [(w0 >>> 12) & 7, (w1 >>> 12) & 7, (w0 >>> 9) & 7, (w1 >>> 9) & 7],
  };
  const cycle1: CombineStage = {
    rgb: [(w0 >>> 5) & 15, (w1 >>> 24) & 15, w0 & 31, (w1 >>> 6) & 7],
    alpha: [(w1 >>> 21) & 7, (w1 >>> 3) & 7, (w1 >>> 18) & 7, w1 & 7],
  };
  return { raw: [w0 >>> 0, w1 >>> 0], cycles: [cycle0, cycle1] };
}
