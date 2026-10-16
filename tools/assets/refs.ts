// Finds where the game's code names a file of the file table: as a 32-bit literal built with lui plus ori or addiu, or
// as a pair of words (virtual start, virtual end) in a data table.
import { freshRegs, step } from '../analyze/constprop.ts';
import { disassemble } from '../analyze/mips.ts';
import type { RomContext } from '../analyze/context.ts';
import type { Inventory } from '../analyze/types.ts';
import type { FileEntry } from '../rom/filetable.ts';

export interface CodeImage {
  /** Name used in evidence strings: `boot`, `code`, `segment-<file>` or `overlay-<file>`. */
  name: string;
  fileIndex: number;
  bytes: Uint8Array;
  ramStart: number;
  textSize: number;
}

/** The code images whose instructions can name files: the main code file, the code segments and every overlay. */
export function codeImages(ctx: RomContext, inventory: Inventory): CodeImage[] {
  const textBytes = (name: string) => {
    const img = inventory.images.find((i) => i.name === name);
    const text = img?.sections.find((s) => s.kind === 'text');
    if (!img || !text) throw new Error(`inventory has no text section for ${name}`);
    return text.end - text.start;
  };
  const code = ctx.layout.code;
  const images: CodeImage[] = [{ name: 'code', fileIndex: code.fileIndex, bytes: ctx.fileBytes(code.fileIndex), ramStart: code.ramStart, textSize: textBytes('code') }];
  for (const s of ctx.layout.segments) images.push({ name: `segment-${s.fileIndex}`, fileIndex: s.fileIndex, bytes: ctx.fileBytes(s.fileIndex), ramStart: s.ramStart, textSize: textBytes(`seg_${s.ramStart.toString(16)}`) });
  for (const o of ctx.layout.overlays) images.push({ name: `overlay-${o.fileIndex}`, fileIndex: o.fileIndex, bytes: ctx.fileBytes(o.fileIndex), ramStart: o.vramStart, textSize: o.textSize });
  return images;
}

export interface LiteralRef {
  image: string;
  /** Address of the instruction that completes the literal. */
  addr: number;
}

/** Every `lui`/`ori` or `lui`/`addiu` pair in the code images that builds the virtual start of a file of the file table. */
export function literalRefs(images: CodeImage[], files: FileEntry[]): Map<number, LiteralRef[]> {
  const byStart = new Map(files.filter((f) => f.virtualStart >= 0x10000).map((f) => [f.virtualStart, f.index]));
  const refs = new Map<number, LiteralRef[]>();
  for (const img of images) {
    const lui = new Map<number, number>();
    for (const i of disassemble(img.bytes, img.ramStart, 0, Math.min(img.textSize, img.bytes.length))) {
      if (i.op === 'lui') {
        lui.set(i.rt, (i.imm << 16) >>> 0);
        continue;
      }
      if ((i.op === 'ori' || i.op === 'addiu') && lui.has(i.rs)) {
        const hi = lui.get(i.rs)!;
        const value = (i.op === 'ori' ? hi | i.imm : hi + ((i.imm << 16) >> 16)) >>> 0;
        const file = byStart.get(value);
        if (file !== undefined) {
          const list = refs.get(file) ?? [];
          list.push({ image: img.name, addr: i.addr });
          refs.set(file, list);
        }
      }
      if (i.kind !== 'plain' && i.kind !== 'branch') lui.clear();
    }
  }
  return refs;
}

/** Instruction addresses in `image` that form an address inside `[lo, hi)` with a lui and an addiu, ori or load/store. */
export function addressRefs(image: CodeImage, lo: number, hi: number): number[] {
  const out: number[] = [];
  const lui = new Map<number, number>();
  for (const i of disassemble(image.bytes, image.ramStart, 0, Math.min(image.textSize, image.bytes.length))) {
    if (i.op === 'lui') {
      lui.set(i.rt, (i.imm << 16) >>> 0);
      continue;
    }
    const base = lui.get(i.rs);
    if (base !== undefined && ['addiu', 'ori', 'lw', 'lh', 'lhu', 'lb', 'lbu', 'sw', 'sh'].includes(i.op)) {
      const a = (i.op === 'ori' ? base | i.imm : base + ((i.imm << 16) >> 16)) >>> 0;
      if (a >= lo && a < hi) out.push(i.addr);
    }
    if (i.kind !== 'plain' && i.kind !== 'branch') lui.clear();
  }
  return out;
}

export interface LoadCall {
  /** Address of the call to the loader. */
  call: number;
  callee: number;
  /** Argument registers a0..a3 that hold a constant at the call. */
  args: (number | undefined)[];
}

const AFTER_SITE_INSNS = 48;

/**
 * The first call to one of `loaders` that follows the instruction at `site` in straight-line code, with the argument
 * registers that hold constants (the size of a transfer is usually one). Gives up at the first branch or jump.
 */
export function loadCallAfter(image: CodeImage, site: number, loaders: Set<number>): LoadCall | undefined {
  const from = site - image.ramStart;
  const insns = disassemble(image.bytes, image.ramStart, Math.max(0, from - 64), Math.min(image.bytes.length, from + AFTER_SITE_INSNS * 4 + 8));
  const at = insns.findIndex((i) => i.addr === site);
  if (at < 0) return undefined;
  const regs = freshRegs();
  for (let k = Math.max(0, at - 16); k < insns.length; k++) {
    const i = insns[k]!;
    if (i.kind === 'call' && k > at) {
      if (!loaders.has(i.target!)) return undefined;
      const slot = insns[k + 1];
      if (slot) step(regs, slot);
      return { call: i.addr, callee: i.target!, args: [4, 5, 6, 7].map((r) => regs[r]) };
    }
    if (k > at && i.kind !== 'plain') return undefined;
    if (i.kind === 'plain') step(regs, i);
    else if (i.kind === 'call' || i.kind === 'branch') regs.fill(undefined, 1);
  }
  return undefined;
}

/** Instruction addresses that build exactly `value` with a lui and an ori or addiu (or a lone addiu/ori from zero). */
export function constantSites(image: CodeImage, value: number): number[] {
  const out: number[] = [];
  const lui = new Map<number, number>();
  for (const i of disassemble(image.bytes, image.ramStart, 0, Math.min(image.textSize, image.bytes.length))) {
    if (i.op === 'lui') {
      lui.set(i.rt, (i.imm << 16) >>> 0);
      continue;
    }
    if (i.op === 'ori' || i.op === 'addiu') {
      const base = i.rs === 0 ? 0 : lui.get(i.rs);
      if (base !== undefined) {
        const v = (i.op === 'ori' ? base | i.imm : base + ((i.imm << 16) >> 16)) >>> 0;
        if (v === value) out.push(i.addr);
      }
    }
    if (i.kind !== 'plain' && i.kind !== 'branch') lui.clear();
  }
  return out;
}
