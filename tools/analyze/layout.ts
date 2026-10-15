// Finds where the boot code, the main code file and the overlays live, from the ROM bytes alone.

import { readFile } from '../rom/extract.ts';
import type { FileEntry } from '../rom/filetable.ts';
import { regsAtCall, freshRegs, step, type Regs } from './constprop.ts';
import { disassemble, type Insn } from './mips.ts';

/** The IPL3 boot stage copies the ROM from this offset to the entry address given in the header. */
export const BOOT_ROM_OFFSET = 0x1000;

export interface Range {
  start: number;
  size: number;
}

export interface BootLayout {
  entry: number;
  romOffset: number;
  ramStart: number;
  /** End of the loaded image: the entry stub starts clearing BSS here. */
  ramEnd: number;
  bss: Range;
  stackTop: number;
  /** Address the entry stub jumps to once BSS is cleared. */
  mainAddr: number;
  evidence: string[];
}

export interface CodeLayout {
  fileIndex: number;
  ramStart: number;
  size: number;
  bss: Range;
  entry: number;
  /** Address of the boot routine that loads files by virtual ROM address. */
  loaderAddr: number;
  /** Address of the call in the boot code that loads the file. */
  loadCallAddr: number;
  evidence: string[];
}

export interface OverlayReloc {
  /** 1 = text, 2 = data, 3 = rodata, 4 = bss, as numbered in the relocation words. */
  section: number;
  type: number;
  /** Offset inside the section named by `section`. */
  offset: number;
}

export interface OverlayLayout {
  fileIndex: number;
  /** Offset of the descriptor in the main code file. */
  recordOffset: number;
  tableOffset: number;
  recordStride: number;
  vramStart: number;
  vramEnd: number;
  fileSize: number;
  textSize: number;
  dataSize: number;
  rodataSize: number;
  bssSize: number;
  /** Offset of the section-size header inside the file. */
  headerOffset: number;
  relocs: OverlayReloc[];
}

export interface RomLayout {
  boot: BootLayout;
  code: CodeLayout;
  overlays: OverlayLayout[];
}

const hex = (n: number) => '0x' + (n >>> 0).toString(16);

function words(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Reads the entry stub: BSS clear loop, stack pointer and the jump that ends the stub. */
export function analyseBoot(rom: Uint8Array): BootLayout {
  const dv = words(rom);
  const entry = dv.getUint32(8);
  const image = rom.subarray(BOOT_ROM_OFFSET);
  const insns = disassemble(image, entry, 0, 0x100);
  const regs = freshRegs();
  const evidence: string[] = [];
  let bss: Range | undefined;
  let stackTop: number | undefined;
  let mainAddr: number | undefined;
  let loopStart: Regs | undefined;
  const loopTarget = insns.find((x) => x.op === 'bne' && x.target !== undefined && x.target < x.addr)?.target;
  for (let k = 0; k < insns.length; k++) {
    const i = insns[k]!;
    if (i.addr === loopTarget) loopStart = [...regs];
    // Loop of the form: sw zero,0(rA); sw zero,4(rA); bne rB,zero,loop; addi rA,rA,8 with rB decremented in the body.
    if (i.op === 'bne' && i.rt === 0 && i.target !== undefined && i.target < i.addr) {
      const body = insns.filter((x) => x.addr >= i.target! && x.addr < i.addr);
      const stores = body.filter((x) => x.op === 'sw' && x.rt === 0);
      const slot = insns[k + 1]!;
      const counter = body.find((x) => (x.op === 'addi' || x.op === 'addiu') && x.rt === i.rs && x.rs === i.rs);
      if (stores.length === 2 && slot.op.startsWith('addi') && counter) {
        const ptr = stores[0]!.rs;
        const start = loopStart?.[ptr];
        const len = loopStart?.[i.rs];
        if (start !== undefined && len !== undefined) {
          bss = { start, size: len };
          evidence.push(
            `${hex(i.addr)}: loop storing zero through ${hex(start)} in 8-byte steps until a counter initialised to ${hex(len)} reaches zero`,
          );
        }
      }
      continue;
    }
    if (i.op === 'jr' && i.kind === 'jr') {
      step(regs, insns[k + 1]!);
      mainAddr = regs[i.rs];
      stackTop = regs[29];
      evidence.push(`${hex(i.addr)}: jr to ${hex(mainAddr ?? 0)} with sp set to ${hex(stackTop ?? 0)} in the delay slot`);
      break;
    }
    if (i.kind === 'plain') step(regs, i);
  }
  if (!bss || mainAddr === undefined || stackTop === undefined) throw new Error('boot entry stub does not match the BSS-clear + jump form');
  return {
    entry, romOffset: BOOT_ROM_OFFSET, ramStart: entry, ramEnd: bss.start, bss, stackTop, mainAddr, evidence,
  };
}

const RAM_LOW = 0x80000000;
const RAM_HIGH = 0x80800000;

/**
 * The boot code loads the main code file with a call whose arguments are constants: destination in RAM, the
 * file's virtual ROM start and its size. Candidates are calls whose second and third arguments describe a whole
 * file of the file table; the one followed by a clear of the memory right after the loaded image and a call into
 * the loaded image is the main code file.
 */
export function analyseCode(rom: Uint8Array, boot: BootLayout, files: FileEntry[]): CodeLayout {
  const image = rom.subarray(boot.romOffset, boot.romOffset + (boot.ramEnd - boot.ramStart));
  const insns = disassemble(image, boot.ramStart);
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  const found: CodeLayout[] = [];
  insns.forEach((c, idx) => {
    if (c.kind !== 'call' || c.target === undefined) return;
    const regs = regsAtCall(insns, idx);
    const [dest, src, size] = [regs[4], regs[5], regs[6]];
    if (dest === undefined || src === undefined || size === undefined) return;
    const f = byStart.get(src);
    if (!f || f.virtualEnd - f.virtualStart !== size || dest < RAM_LOW || dest >= RAM_HIGH) return;
    const end = dest + size;
    let bss: Range | undefined;
    let entry: number | undefined;
    for (let j = idx + 2; j < Math.min(idx + 60, insns.length); j++) {
      const n = insns[j]!;
      if (n.kind !== 'call' || n.target === undefined) continue;
      const r = regsAtCall(insns, j);
      if (r[4] === end && r[5] !== undefined && !bss) bss = { start: end, size: r[5] };
      else if (n.target >= dest && n.target < end && entry === undefined) entry = n.target;
    }
    if (bss && entry !== undefined) {
      found.push({
        fileIndex: f.index, ramStart: dest, size, bss, entry, loaderAddr: c.target, loadCallAddr: c.addr,
        evidence: [
          `${hex(c.addr)}: call ${hex(c.target)}(dest=${hex(dest)}, rom=${hex(src)}, size=${hex(size)}); ${hex(src)}..${hex(src + size)} is file ${f.index} of the file table`,
          `then a call with first argument ${hex(end)} (the end of the loaded image) and size ${hex(bss.size)}: BSS`,
          `then a call to ${hex(entry)}, inside the loaded image`,
        ],
      });
    }
  });
  if (found.length !== 1) throw new Error(`expected exactly one main-code load in the boot code, found ${found.length}`);
  return found[0]!;
}

interface Quad {
  offset: number;
  file: FileEntry;
  vramStart: number;
  vramEnd: number;
}

function parseFooter(data: Uint8Array): Omit<OverlayLayout, 'fileIndex' | 'recordOffset' | 'tableOffset' | 'recordStride' | 'vramStart' | 'vramEnd'> | undefined {
  const dv = words(data);
  if (data.length < 0x20) return undefined;
  const back = dv.getUint32(data.length - 4);
  if (back < 20 + 4 || back > data.length || back % 4) return undefined;
  const h = data.length - back;
  const [text, dat, ro, bss, n] = [0, 4, 8, 12, 16].map((k) => dv.getUint32(h + k));
  if (text === undefined || dat === undefined || ro === undefined || bss === undefined || n === undefined) return undefined;
  if (text + dat + ro !== h) return undefined;
  const relEnd = h + 20 + n * 4;
  if (relEnd > data.length - 4 || data.length - 4 - relEnd >= 16) return undefined;
  const relocs: OverlayReloc[] = [];
  for (let k = 0; k < n; k++) {
    const w = dv.getUint32(h + 20 + k * 4);
    relocs.push({ section: w >>> 30, type: (w >>> 24) & 0x3f, offset: w & 0xffffff });
  }
  return { fileSize: data.length, textSize: text, dataSize: dat, rodataSize: ro, bssSize: bss, headerOffset: h, relocs };
}

/**
 * Overlay descriptors are records in the main code file that start with the virtual ROM range of a file followed
 * by the RAM range the overlay is linked at. A candidate counts only when the file ends with a consistent
 * section-size header and relocation list.
 */
export function findOverlays(rom: Uint8Array, code: Uint8Array, files: FileEntry[]): OverlayLayout[] {
  const dv = words(code);
  const byStart = new Map(files.map((f) => [f.virtualStart, f]));
  const quads: Quad[] = [];
  for (let o = 0; o + 16 <= code.length; o += 4) {
    const a = dv.getUint32(o);
    const f = byStart.get(a);
    if (!f || a === 0 || f.virtualEnd !== dv.getUint32(o + 4)) continue;
    const vs = dv.getUint32(o + 8);
    const ve = dv.getUint32(o + 12);
    if (vs >= RAM_LOW && ve > vs && ve < 0x81000000 && vs % 16 === 0) quads.push({ offset: o, file: f, vramStart: vs, vramEnd: ve });
  }
  const out: OverlayLayout[] = [];
  const seen = new Set<number>();
  for (const q of quads) {
    if (seen.has(q.file.index)) continue;
    const footer = parseFooter(readFile(rom, q.file));
    if (!footer) continue;
    seen.add(q.file.index);
    // Records of one table are evenly spaced; the stride is the distance to the neighbouring quad.
    const next = quads.find((x) => x.offset > q.offset && x.offset - q.offset <= 0x100);
    const prev = [...quads].reverse().find((x) => x.offset < q.offset && q.offset - x.offset <= 0x100);
    const stride = Math.min(next ? next.offset - q.offset : Infinity, prev ? q.offset - prev.offset : Infinity);
    out.push({
      fileIndex: q.file.index, recordOffset: q.offset, tableOffset: q.offset, recordStride: Number.isFinite(stride) ? stride : 0,
      vramStart: q.vramStart, vramEnd: q.vramEnd, ...footer,
    });
  }
  return out.sort((a, b) => a.fileIndex - b.fileIndex);
}

export function analyseLayout(rom: Uint8Array, files: FileEntry[]): RomLayout {
  const boot = analyseBoot(rom);
  const code = analyseCode(rom, boot, files);
  const codeFile = files.find((f) => f.index === code.fileIndex)!;
  const overlays = findOverlays(rom, readFile(rom, codeFile), files);
  return { boot, code, overlays };
}

export type { Insn };
