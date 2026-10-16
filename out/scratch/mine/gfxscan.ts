// Locates display lists, vertex arrays, textures, palettes and animations inside a scene, room or object file.
// The command layouts are the ones the interpreter in tools/gfx implements (evidence in docs/re/display-lists.md);
// textures follow the load sequence the game emits: SETTIMG, SETTILE, LOADBLOCK/LOADTILE/LOADTLUT, SETTILE, SETTILESIZE.

import { Op } from '../gfx/opcodes.ts';

export interface DisplayListSpan {
  offset: number;
  /** Bytes, the closing ENDDL or branch included. */
  size: number;
  commands: number;
}

export interface VertexSpan {
  offset: number;
  /** Vertices of 16 bytes. */
  count: number;
}

export interface TextureSpan {
  offset: number;
  bytes: number;
  /** RDP format and texel size numbers as in tools/gfx/decode.ts. */
  fmt: number;
  siz: number;
  width: number;
  height: number;
  /** Offset of the palette in this file for CI textures, or -1 when it is not in the file. */
  palette: number;
}

export interface PaletteSpan {
  offset: number;
  /** 16-bit entries. */
  colors: number;
}

export interface AnimationSpan {
  offset: number;
  frames: number;
  /** Offsets in the file of the frame values and of the joint index table. */
  frameData: number;
  jointIndices: number;
  /** Indices at or above this value are animated; lower ones are constants. */
  staticIndexMax: number;
}

export interface GfxScan {
  /** Segment number (1-15) the file's own pointers use, or -1 when no pointer stays inside the file. */
  segment: number;
  displayLists: DisplayListSpan[];
  vertices: VertexSpan[];
  textures: TextureSpan[];
  palettes: PaletteSpan[];
  animations: AnimationSpan[];
  /** Pointers by segment number whose target lies in another file. */
  externalRefs: Record<number, number>;
}

const isSegAddr = (w: number) => (w >>> 24) <= 0x0f || (w >>> 24) === 0x80;
const evenIndex = (b: number) => (b & 1) === 0 && b < 64;
const triIndices = (w: number) => evenIndex((w >>> 16) & 0xff) && evenIndex((w >>> 8) & 0xff) && evenIndex(w & 0xff);

/** Whether the two words can be one command of the display list dialect the game uses. */
export function plausibleCommand(w0: number, w1: number): boolean {
  const op = w0 >>> 24;
  switch (op) {
    case Op.VTX: {
      const n = (w0 >>> 12) & 0xff;
      return n >= 1 && n <= 32 && isSegAddr(w1) && ((w0 >>> 20) & 0xf) === 0;
    }
    case Op.TRI1:
      return w1 === 0 && triIndices(w0);
    case Op.TRI2:
    case Op.QUAD:
      return triIndices(w0) && triIndices(w1);
    case Op.CULLDL:
      return (w0 & 0xff0000) === 0 && (w1 & 0xffff0000) === 0;
    case Op.DL:
      return ((w0 >>> 16) & 0xfe) === 0 && (w0 & 0xffff) === 0 && isSegAddr(w1);
    case Op.ENDDL:
      return w0 === 0xdf000000 && w1 === 0;
    case Op.RDPLOADSYNC: case Op.RDPPIPESYNC: case Op.RDPTILESYNC: case Op.RDPFULLSYNC:
      return (w0 & 0xffffff) === 0 && w1 === 0;
    case Op.TEXTURE:
      return (w0 & 0xffff0000) === 0xd7000000;
    case Op.POPMTX: case Op.GEOMETRYMODE: case Op.MOVEWORD: case Op.SETOTHERMODE_L: case Op.SETOTHERMODE_H: case Op.SETOTHERMODE:
    case Op.SETSCISSOR: case Op.SETTILESIZE: case Op.LOADBLOCK: case Op.LOADTILE: case Op.LOADTLUT: case Op.SETTILE: case Op.FILLRECT:
    case Op.SETFILLCOLOR: case Op.SETFOGCOLOR: case Op.SETBLENDCOLOR: case Op.SETPRIMCOLOR: case Op.SETENVCOLOR: case Op.SETCOMBINE:
    case Op.TEXRECT: case Op.RDPHALF_1: case Op.RDPHALF_2:
      return true;
    case Op.MTX: case Op.MOVEMEM: case Op.SETTIMG: case Op.SETZIMG: case Op.SETCIMG:
      return isSegAddr(w1);
    default:
      return false;
  }
}

const bitsPerTexel = (siz: number) => 4 << siz;
const textureBytes = (width: number, height: number, siz: number) => Math.ceil((width * height * bitsPerTexel(siz)) / 8);

interface Load { addr: number; tmem: number; tlut: boolean }

/** Display lists: runs of plausible commands that end at an ENDDL or a branch, split at each end. */
function findDisplayLists(dv: DataView, length: number): DisplayListSpan[] {
  const lists: DisplayListSpan[] = [];
  let start = -1;
  for (let i = 0; i < Math.floor(length / 8); i++) {
    const w0 = dv.getUint32(i * 8), w1 = dv.getUint32(i * 8 + 4);
    if (!plausibleCommand(w0, w1)) { start = -1; continue; }
    if (start < 0) start = i;
    const op = w0 >>> 24;
    if (op === Op.ENDDL || (op === Op.DL && ((w0 >>> 16) & 1) === 1)) {
      lists.push({ offset: start * 8, size: (i - start + 1) * 8, commands: i - start + 1 });
      start = -1;
    }
  }
  return lists;
}

/** A run shorter than this is kept only when a pointer names its start: short runs of valid commands occur by chance. */
const MIN_UNREFERENCED_COMMANDS = 4;

export function scanGfx(data: Uint8Array): GfxScan {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.length;
  const found = findDisplayLists(dv, length);

  // The pointers inside the lists decide which segment number the file's own offsets use.
  const pointerOps = new Set<number>([Op.VTX, Op.DL, Op.SETTIMG, Op.MTX, Op.MOVEMEM]);
  const hits = new Array<number>(16).fill(0);
  for (const span of found) {
    for (let o = span.offset; o < span.offset + span.size; o += 8) {
      const p = dv.getUint32(o + 4);
      if (pointerOps.has(dv.getUint32(o) >>> 24) && (p & 0xffffff) < length) hits[(p >>> 24) & 15]!++;
    }
  }
  let segment = -1, best = 0;
  hits.forEach((n, s) => { if (s !== 0 && n > best) { best = n; segment = s; } });
  const inFile = (p: number) => segment >= 0 && (p >>> 24) === segment && (p & 0xffffff) < length;

  const named = new Set<number>();
  for (let o = 0; o + 4 <= length && segment >= 0; o += 4) {
    const w = dv.getUint32(o);
    if (inFile(w)) named.add(w & 0xffffff);
  }
  const displayLists = found.filter((span) => named.has(span.offset) || span.commands >= MIN_UNREFERENCED_COMMANDS);

  const vertexRanges = new Map<number, number>();
  const textures = new Map<string, TextureSpan>();
  const palettes = new Map<number, PaletteSpan>();
  const external: Record<number, number> = {};
  const noteExternal = (p: number) => {
    if (!inFile(p) && (p >>> 24) !== 0x80 && (p >>> 24) !== 0) external[(p >>> 24) & 15] = (external[(p >>> 24) & 15] ?? 0) + 1;
  };

  for (const list of displayLists) {
    let timg = { addr: 0 };
    const tiles = Array.from({ length: 8 }, () => ({ fmt: 0, siz: 0, tmem: 0, set: false }));
    const loads: Load[] = [];
    let lastPalette = -1;
    for (let o = list.offset; o < list.offset + list.size; o += 8) {
      const w0 = dv.getUint32(o), w1 = dv.getUint32(o + 4);
      switch (w0 >>> 24) {
        case Op.VTX: {
          noteExternal(w1);
          if (!inFile(w1)) break;
          const off = w1 & 0xffffff;
          vertexRanges.set(off, Math.max(vertexRanges.get(off) ?? 0, (w0 >>> 12) & 0xff));
          break;
        }
        case Op.DL: case Op.MTX: case Op.MOVEMEM: noteExternal(w1); break;
        case Op.SETTIMG: noteExternal(w1); timg = { addr: w1 }; break;
        case Op.SETTILE: {
          const t = tiles[(w1 >>> 24) & 7]!;
          t.fmt = (w0 >>> 21) & 7; t.siz = (w0 >>> 19) & 3; t.tmem = w0 & 0x1ff; t.set = true;
          break;
        }
        case Op.LOADBLOCK: case Op.LOADTILE:
          loads.push({ addr: timg.addr, tmem: tiles[(w1 >>> 24) & 7]!.tmem, tlut: false });
          break;
        case Op.LOADTLUT: {
          const colors = ((w1 >>> 14) & 0x3ff) + 1;
          loads.push({ addr: timg.addr, tmem: tiles[(w1 >>> 24) & 7]!.tmem, tlut: true });
          if (inFile(timg.addr)) {
            lastPalette = timg.addr & 0xffffff;
            palettes.set(lastPalette, { offset: lastPalette, colors: Math.max(palettes.get(lastPalette)?.colors ?? 0, colors) });
          } else lastPalette = -1;
          break;
        }
        case Op.SETTILESIZE: {
          const tile = tiles[(w1 >>> 24) & 7]!;
          const width = ((((w1 >>> 12) & 0xfff) - ((w0 >>> 12) & 0xfff)) >> 2) + 1;
          const height = (((w1 & 0xfff) - (w0 & 0xfff)) >> 2) + 1;
          const load = [...loads].reverse().find((l) => !l.tlut && l.tmem === tile.tmem);
          if (!load || !tile.set || width < 1 || height < 1 || !inFile(load.addr)) break;
          const offset = load.addr & 0xffffff;
          const bytes = textureBytes(width, height, tile.siz);
          if (offset + bytes > length) break;
          const palette = tile.fmt === 2 ? lastPalette : -1;
          textures.set(`${offset}:${tile.fmt}:${tile.siz}:${width}:${height}`, { offset, bytes, fmt: tile.fmt, siz: tile.siz, width, height, palette });
          break;
        }
      }
    }
  }

  return {
    segment,
    displayLists,
    vertices: mergeVertices(vertexRanges),
    textures: [...textures.values()].sort((a, b) => a.offset - b.offset),
    palettes: [...palettes.values()].sort((a, b) => a.offset - b.offset),
    animations: segment >= 0 ? findAnimations(dv, length, segment) : [],
    externalRefs: external,
  };
}

/** Arrays named by VTX commands: ranges that overlap or touch are one array. */
function mergeVertices(ranges: Map<number, number>): VertexSpan[] {
  const out: VertexSpan[] = [];
  for (const [offset, count] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && offset <= last.offset + last.count * 16) last.count = Math.max(last.count, (offset - last.offset) / 16 + count);
    else out.push({ offset, count });
  }
  return out;
}

const ANIMATION_HEADER_SIZE = 16;
const MAX_ANIMATION_FRAMES = 1500;

/**
 * Animation headers: `{s16 frames, u16 0, u32 frameData, u32 jointIndices, u16 staticIndexMax, u16 0}`, both pointers
 * in the file's own segment. The sampler reads `+4`, `+8` and `+0xC` as described in docs/re/assets.md.
 */
export function findAnimations(dv: DataView, length: number, segment: number): AnimationSpan[] {
  const out: AnimationSpan[] = [];
  for (let o = 0; o + ANIMATION_HEADER_SIZE <= length; o += 4) {
    const frames = dv.getInt16(o);
    if (frames <= 1 || frames >= MAX_ANIMATION_FRAMES || dv.getUint16(o + 2) !== 0 || dv.getUint16(o + 14) !== 0) continue;
    const frameData = dv.getUint32(o + 4), jointIndices = dv.getUint32(o + 8);
    if ((frameData >>> 24) !== segment || (jointIndices >>> 24) !== segment) continue;
    const fo = frameData & 0xffffff, jo = jointIndices & 0xffffff;
    if (fo % 2 || jo % 2 || fo + 2 > length || jo + 6 > length) continue;
    out.push({ offset: o, frames, frameData: fo, jointIndices: jo, staticIndexMax: dv.getUint16(o + 12) });
  }
  return out;
}
