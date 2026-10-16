// Finds where the game's code names an address or a file: `lui` + `addiu`/`ori`/load pairs that build a constant,
// and word-sized pointers in data. Used as evidence that a table or a file is consumed, and by what.

import { disassemble, type Insn } from '../analyze/mips.ts';
import type { RomContext } from '../analyze/context.ts';

/** One block of code the game runs: the boot image, the main code file, a fixed segment or an overlay. */
export interface CodeImage {
  name: string;
  base: number;
  /** The whole image, text first. */
  bytes: Uint8Array;
  /** Bytes of `bytes` that are instructions. */
  textSize: number;
  fileIndex: number | null;
}

/** First byte of the main code file's data: the first overlay descriptor table (docs/re/overlays.md). */
export function mainCodeTextSize(ctx: RomContext): number {
  const first = Math.min(...ctx.layout.overlays.map((o) => o.tableOffset));
  return first;
}

export function codeImages(ctx: RomContext): CodeImage[] {
  const { boot, code, overlays, segments } = ctx.layout;
  const images: CodeImage[] = [];
  images.push({ name: 'boot', base: boot.ramStart, bytes: ctx.rom.subarray(boot.romOffset, boot.romOffset + boot.ramEnd - boot.ramStart), textSize: boot.ramEnd - boot.ramStart, fileIndex: null });
  const codeBytes = ctx.fileBytes(code.fileIndex);
  images.push({ name: 'code', base: code.ramStart, bytes: codeBytes, textSize: Math.min(mainCodeTextSize(ctx), codeBytes.length), fileIndex: code.fileIndex });
  for (const s of segments) {
    images.push({ name: `seg_${s.ramStart.toString(16)}`, base: s.ramStart, bytes: ctx.fileBytes(s.fileIndex), textSize: s.size, fileIndex: s.fileIndex });
  }
  for (const o of overlays) {
    images.push({ name: `ovl_${o.fileIndex}`, base: o.vramStart, bytes: ctx.fileBytes(o.fileIndex), textSize: o.textSize, fileIndex: o.fileIndex });
  }
  return images;
}

export interface ConstantUse {
  image: string;
  /** Address of the instruction that completes the constant (the `addiu`/`ori`, or the load/store that folds the low half). */
  addr: number;
  value: number;
  op: string;
  /** Instruction index inside `insns`, for callers that want to read on. */
  index: number;
}

const FOLDING = new Set(['addiu', 'ori', 'lw', 'lh', 'lhu', 'lb', 'lbu', 'sw', 'sh', 'sb', 'lwc1', 'swc1', 'ld', 'sd']);

/** Calls `visit` for every constant a `lui` plus a nearby low-half instruction on the same register builds. */
export function forEachConstant(image: CodeImage, visit: (use: ConstantUse, insns: Insn[]) => void): void {
  const insns = disassemble(image.bytes.subarray(0, image.textSize), image.base);
  for (let k = 0; k < insns.length; k++) {
    const hi = insns[k]!;
    if (hi.op !== 'lui') continue;
    for (let j = k + 1; j < Math.min(k + 12, insns.length); j++) {
      const lo = insns[j]!;
      if (FOLDING.has(lo.op) && lo.rs === hi.rt) {
        const value = lo.op === 'ori' ? ((hi.imm << 16) | lo.imm) >>> 0 : (((hi.imm << 16) + ((lo.imm << 16) >> 16)) >>> 0);
        visit({ image: image.name, addr: lo.addr, value, op: lo.op, index: j }, insns);
      }
      // The register is overwritten: the constant is not formed.
      if ((lo.rt === hi.rt && lo.op !== 'sw' && lo.op !== 'sh' && lo.op !== 'sb') || lo.kind === 'jr' || lo.kind === 'return') break;
    }
  }
}

/** Every constant in `images` that falls in `[lo, hi)`. */
export function constantsIn(images: CodeImage[], lo: number, hi: number): ConstantUse[] {
  const out: ConstantUse[] = [];
  for (const image of images) forEachConstant(image, (use) => { if (use.value >= lo && use.value < hi) out.push(use); });
  return out;
}

export interface FileRef {
  image: string;
  /** Address of the instruction (`constant`) or of the word that holds the start of the range (`pair`). */
  addr: number;
  kind: 'constant' | 'pair';
  /** For a constant: the first call to a ROM loader within the next instructions, when there is one. */
  loaderCall?: number;
}

const LOADER_WINDOW = 48;

/** The first call to one of `loaders` in the instructions after `index`, up to the end of the function. */
export function loaderCallAfter(insns: Insn[], index: number, loaders: ReadonlySet<number>): number | undefined {
  for (let j = index; j < Math.min(index + LOADER_WINDOW, insns.length); j++) {
    const i = insns[j]!;
    if (i.kind === 'call' && i.target !== undefined && loaders.has(i.target)) return i.addr;
    if (i.kind === 'return') return undefined;
  }
  return undefined;
}

/**
 * Every place in `images` that names a file by its virtual ROM start: a constant built in code, or a data word
 * equal to the start and followed by the end of the same file.
 */
export function findFileRefs(images: CodeImage[], files: { index: number; virtualStart: number; virtualEnd: number }[], loaders: ReadonlySet<number>): Map<number, FileRef[]> {
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  const refs = new Map<number, FileRef[]>();
  const add = (file: number, ref: FileRef) => {
    const list = refs.get(file);
    if (list) list.push(ref);
    else refs.set(file, [ref]);
  };
  for (const image of images) {
    forEachConstant(image, (use, insns) => {
      const f = byStart.get(use.value);
      if (f && use.op !== 'sw' && use.op !== 'sh' && use.op !== 'sb') add(f.index, { image: image.name, addr: use.addr, kind: 'constant', loaderCall: loaderCallAfter(insns, use.index, loaders) });
    });
    const dv = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    for (let o = image.textSize; o + 8 <= image.bytes.length; o += 4) {
      const f = byStart.get(dv.getUint32(o));
      if (f && dv.getUint32(o + 4) === f.virtualEnd) add(f.index, { image: image.name, addr: image.base + o, kind: 'pair' });
    }
  }
  return refs;
}
