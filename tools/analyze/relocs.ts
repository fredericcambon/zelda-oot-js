// Overlay memory map and relocation resolution.

import { R_MIPS_26, R_MIPS_32, R_MIPS_HI16, R_MIPS_LO16 } from '../elf-wrap/elf.ts';
import type { OverlayLayout } from './layout.ts';
import { decode } from './mips.ts';

/** Relocation type numbers in the overlay lists are the standard ELF MIPS numbers (2, 4, 5 and 6 occur). */
const KNOWN_TYPES = new Set([R_MIPS_32, R_MIPS_26, R_MIPS_HI16, R_MIPS_LO16]);

const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;
const sx16 = (n: number) => (n << 16) >> 16;

/** Link addresses of the sections: text, data and rodata follow each other; BSS comes after, 16-aligned. */
export function overlaySections(o: OverlayLayout) {
  const text = o.vramStart;
  const data = text + o.textSize;
  const rodata = data + o.dataSize;
  const bss = alignUp(rodata + o.rodataSize, 16);
  return { text, data, rodata, bss };
}

export interface OverlayMemorySection {
  name: string;
  addr: number;
  size: number;
  /** Offset in the file. */
  off: number;
  exec?: boolean;
  write?: boolean;
}

export function overlayMemory(o: OverlayLayout): OverlayMemorySection[] {
  const b = overlaySections(o);
  return [
    { name: '.text', addr: b.text, size: o.textSize, off: 0, exec: true },
    { name: '.data', addr: b.data, size: o.dataSize, off: o.textSize, write: true },
    { name: '.rodata', addr: b.rodata, size: o.rodataSize, off: o.textSize + o.dataSize },
  ];
}

export interface ResolvedReloc {
  /** Link address of the relocated word. */
  addr: number;
  type: number;
  /** 1 = text, 2 = data, 3 = rodata. */
  section: number;
  /** Address the word refers to once relocated, when it could be determined. */
  target?: number;
}

/**
 * Resolves every relocation of an overlay to the address it points at. A HI16 and the LO16 that completes it
 * share one target; further LO16 entries reuse the last HI16 held in the same register.
 */
export function resolveRelocs(file: Uint8Array, o: OverlayLayout): ResolvedReloc[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const secs = overlayMemory(o);
  const wordAt = (addr: number) => {
    const s = secs.find((x) => addr >= x.addr && addr < x.addr + x.size)!;
    return dv.getUint32(s.off + addr - s.addr);
  };
  const rel = o.relocs
    .filter((r) => r.section >= 1 && r.section <= 3 && KNOWN_TYPES.has(r.type))
    .map((r) => ({ ...r, addr: secs[r.section - 1]!.addr + r.offset }))
    .filter((r) => r.offset + 4 <= secs[r.section - 1]!.size)
    .sort((a, b) => a.addr - b.addr);
  const target = new Map<number, number>();
  const lastHi = new Map<number, { addr: number; value: number }>();
  const firstLo = new Map<number, number>();
  for (const r of rel) {
    if (r.section !== 1 || (r.type !== R_MIPS_HI16 && r.type !== R_MIPS_LO16)) continue;
    const i = decode(wordAt(r.addr), r.addr);
    if (r.type === R_MIPS_HI16) {
      lastHi.set(i.rt, { addr: r.addr, value: i.imm << 16 });
      continue;
    }
    const hi = lastHi.get(i.rs);
    if (!hi) continue;
    const full = (hi.value + sx16(i.imm)) >>> 0;
    target.set(r.addr, full);
    if (!firstLo.has(hi.addr)) firstLo.set(hi.addr, full);
  }
  for (const [hi, full] of firstLo) target.set(hi, full);
  for (const r of rel) {
    if (r.type === R_MIPS_32) target.set(r.addr, wordAt(r.addr));
    else if (r.type === R_MIPS_26) target.set(r.addr, ((o.vramStart & 0xf0000000) | ((wordAt(r.addr) & 0x3ffffff) << 2)) >>> 0);
  }
  return rel.map((r) => ({ addr: r.addr, type: r.type, section: r.section, target: target.get(r.addr) }));
}
