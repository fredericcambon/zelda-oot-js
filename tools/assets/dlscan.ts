// Finds display lists inside a file's bytes and reads the textures, palettes and vertex arrays they name.
// Nothing here runs the lists; it only walks the commands the way the interpreter in tools/gfx does.
import { Fmt } from '../gfx/types.ts';
import { Op } from '../gfx/opcodes.ts';

/** Bytes of a display-list command. */
const CMD = 8;

export interface Range {
  start: number;
  end: number;
}

export interface TextureRef {
  /** File offset of the first texel. */
  offset: number;
  fmt: number;
  siz: number;
  width: number;
  height: number;
  /** File offset of the palette a colour-indexed texture selects, or -1. */
  palette: number;
  /** Size of the image in bytes. */
  bytes: number;
}

export interface PaletteRef {
  offset: number;
  entries: number;
}

export interface VertexRef {
  offset: number;
  count: number;
}

export interface DisplayListScan {
  lists: Range[];
  textures: TextureRef[];
  palettes: PaletteRef[];
  vertices: VertexRef[];
  /** Commands that point into a segment other than the one the file is mapped to, by segment number. */
  foreignSegments: Record<number, number>;
  matrices: number[];
}

const VALID_OPS = new Set<number>(Object.values(Op));
/** Colour, depth and scissor set-up belongs to the frame, never to a list stored in a file. */
const FRAME_OPS = new Set<number>([Op.SETCIMG, Op.SETZIMG, Op.SETSCISSOR, Op.FILLRECT, Op.SETFILLCOLOR, Op.TEXRECT, Op.RDPHALF_1, Op.RDPHALF_2]);

/** Whether a command's fields are within what the game's own lists were observed to use. */
function plausible(w0: number, w1: number): boolean {
  const op = w0 >>> 24;
  if (!VALID_OPS.has(op) || FRAME_OPS.has(op)) return false;
  const seg = w1 >>> 24;
  switch (op) {
    case Op.ENDDL:
    case Op.RDPLOADSYNC: case Op.RDPPIPESYNC: case Op.RDPTILESYNC: case Op.RDPFULLSYNC:
      return (w0 & 0xffffff) === 0 && w1 === 0;
    case Op.DL: return seg <= 0x0f && (w0 & 0x00feffff) === 0;
    case Op.VTX: {
      const n = (w0 >>> 12) & 0xff, end = (w0 >>> 1) & 0x7f;
      return seg <= 0x0f && n > 0 && n <= end && end <= 32;
    }
    case Op.SETTIMG: return seg <= 0x0f && ((w0 >>> 21) & 7) < 5;
    case Op.MTX: return seg <= 0x0f;
    case Op.MOVEMEM: return seg <= 0x0f;
    case Op.TRI1: return (w0 & 0xff) % 2 === 0 && ((w0 >>> 8) & 0xff) % 2 === 0 && ((w0 >>> 16) & 0xff) % 2 === 0;
    case Op.TRI2: case Op.QUAD:
      return [w0, w1].every((w) => (w & 0xff) % 2 === 0 && ((w >>> 8) & 0xff) % 2 === 0 && ((w >>> 16) & 0xff) % 2 === 0);
    default: return true;
  }
}

/** Display lists end with ENDDL, or with a DL command that branches (does not return). */
function isTerminator(w0: number): boolean {
  const op = w0 >>> 24;
  return op === Op.ENDDL || (op === Op.DL && ((w0 >>> 16) & 0xff) === 1);
}

/** A list that nothing points to needs this many commands: shorter runs match random data too often. */
const MIN_COMMANDS = 3;

/**
 * Display lists of a file mapped at `segment`. A stretch of plausible commands is cut after every terminator. The first
 * piece of a stretch may start with data that merely looks like commands (vertices, say), so it starts at the first
 * address some word of the file points to, when one lies inside it.
 */
export function findDisplayLists(bytes: Uint8Array, segment: number): Range[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pointed = new Set<number>();
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const w = dv.getUint32(o);
    if (w >>> 24 === segment && (w & 7) === 0) pointed.add(w & 0xffffff);
  }
  const lists: Range[] = [];
  let p = 0;
  let stretchStart = true;
  while (p + CMD <= bytes.length) {
    if (!plausible(dv.getUint32(p), dv.getUint32(p + 4))) {
      p += CMD;
      stretchStart = true;
      continue;
    }
    let q = p, end = -1;
    while (q + CMD <= bytes.length && plausible(dv.getUint32(q), dv.getUint32(q + 4))) {
      if (isTerminator(dv.getUint32(q))) { end = q + CMD; break; }
      q += CMD;
    }
    if (end < 0) {
      p = q + CMD;
      stretchStart = true;
      continue;
    }
    let start = p;
    if (stretchStart && !pointed.has(start)) {
      for (let r = start + CMD; r < end; r += CMD) if (pointed.has(r)) { start = r; break; }
    }
    if ((end - start) / CMD >= MIN_COMMANDS || pointed.has(start)) lists.push({ start, end });
    p = end;
    stretchStart = false;
  }
  return lists;
}

interface Tile {
  fmt: number;
  siz: number;
  line: number;
  tmem: number;
  palette: number;
  uls: number; ult: number; lrs: number; lrt: number;
  sized: boolean;
}

const newTile = (): Tile => ({ fmt: 0, siz: 0, line: 0, tmem: 0, palette: 0, uls: 0, ult: 0, lrs: 0, lrt: 0, sized: false });

/** Offset inside the file that an address `segment << 24 | offset` names, or -1 for another segment. */
function resolve(addr: number, segment: number): number {
  return addr >>> 24 === segment ? addr & 0xffffff : -1;
}

const bitsPerTexel = (siz: number) => 4 << siz;

/**
 * Reads the lists found in `bytes` (a file mapped at segment `segment`) and collects what they name inside the file.
 * Textures are reported when a tile that has been loaded from an image gets its size set, which is how the game's
 * lists end every texture set-up (SETTIMG, SETTILE, LOADBLOCK or LOADTLUT, SETTILE, SETTILESIZE).
 */
export function scanDisplayLists(bytes: Uint8Array, segment: number): DisplayListScan {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lists = findDisplayLists(bytes, segment);
  const textures = new Map<string, TextureRef>();
  const palettes = new Map<number, PaletteRef>();
  const vertices = new Map<number, VertexRef>();
  const matrices = new Set<number>();
  const foreignSegments: Record<number, number> = {};
  const foreign = (addr: number) => {
    const s = addr >>> 24;
    if (s !== segment && s >= 1 && s <= 0x0f) foreignSegments[s] = (foreignSegments[s] ?? 0) + 1;
  };

  for (const list of lists) {
    const tiles = Array.from({ length: 8 }, newTile);
    let timg = { fmt: 0, siz: 0, width: 0, addr: -1 };
    let lastPalette = -1;
    /** File offset of the image the last LOADBLOCK or LOADTILE read, or -1 when it was in another segment. */
    let loaded = -1;
    for (let q = list.start; q < list.end; q += CMD) {
      const w0 = dv.getUint32(q), w1 = dv.getUint32(q + 4);
      switch (w0 >>> 24) {
        case Op.SETTIMG:
          timg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xfff) + 1, addr: resolve(w1, segment) };
          foreign(w1);
          break;
        case Op.DL: case Op.MOVEMEM: foreign(w1); break;
        case Op.MTX: {
          const o = resolve(w1, segment);
          if (o >= 0) matrices.add(o);
          foreign(w1);
          break;
        }
        case Op.VTX: {
          const o = resolve(w1, segment), count = (w0 >>> 12) & 0xff;
          if (o >= 0 && o + count * 16 <= bytes.length) {
            const prev = vertices.get(o);
            if (!prev || prev.count < count) vertices.set(o, { offset: o, count });
          }
          foreign(w1);
          break;
        }
        case Op.SETTILE: {
          const t = tiles[(w1 >>> 24) & 7]!;
          t.fmt = (w0 >>> 21) & 7; t.siz = (w0 >>> 19) & 3; t.line = (w0 >>> 9) & 0x1ff; t.tmem = w0 & 0x1ff;
          t.palette = (w1 >>> 20) & 15;
          t.sized = false;
          break;
        }
        case Op.SETTILESIZE: {
          const t = tiles[(w1 >>> 24) & 7]!;
          t.uls = (w0 >>> 12) & 0xfff; t.ult = w0 & 0xfff; t.lrs = (w1 >>> 12) & 0xfff; t.lrt = w1 & 0xfff;
          t.sized = true;
          if (loaded >= 0) {
            const width = ((t.lrs - t.uls) >> 2) + 1, height = ((t.lrt - t.ult) >> 2) + 1;
            const bytesLen = Math.ceil((width * height * bitsPerTexel(t.siz)) / 8);
            const ref: TextureRef = { offset: loaded, fmt: t.fmt, siz: t.siz, width, height, palette: t.fmt === Fmt.CI ? lastPalette : -1, bytes: bytesLen };
            if (ref.offset + ref.bytes <= bytes.length) textures.set(`${ref.offset}:${ref.fmt}:${ref.siz}:${width}:${height}:${ref.palette}`, ref);
          }
          break;
        }
        case Op.LOADBLOCK: case Op.LOADTILE:
          loaded = timg.addr;
          break;
        case Op.LOADTLUT: {
          const entries = (((w1 >>> 12) & 0xfff) >> 2) + 1;
          if (timg.addr >= 0 && timg.addr + entries * 2 <= bytes.length) {
            lastPalette = timg.addr;
            const prev = palettes.get(timg.addr);
            if (!prev || prev.entries < entries) palettes.set(timg.addr, { offset: timg.addr, entries });
          } else lastPalette = -1;
          break;
        }
        default: break;
      }
    }
  }
  const byOffset = <T extends { offset: number }>(m: Iterable<T>) => [...m].sort((a, b) => a.offset - b.offset);
  return { lists, textures: byOffset(textures.values()), palettes: byOffset(palettes.values()), vertices: byOffset(vertices.values()), foreignSegments, matrices: [...matrices].sort((a, b) => a - b) };
}
