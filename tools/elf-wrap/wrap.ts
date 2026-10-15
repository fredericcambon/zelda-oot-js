// Wraps the boot code, the main code file and each overlay as ELF32 big-endian MIPS o32 images at their link addresses.

import { readFile } from '../rom/extract.ts';
import type { FileEntry } from '../rom/filetable.ts';
import type { OverlayLayout, RomLayout } from '../analyze/layout.ts';
import { overlayMemory, overlaySections, resolveRelocs } from '../analyze/relocs.ts';
import { writeElf, type ElfReloc, type ElfSpec } from './elf.ts';

export interface WrappedImage {
  /** File name stem: `boot`, `code` or `ovl_<file index>`. */
  name: string;
  kind: 'boot' | 'code' | 'overlay';
  fileIndex?: number;
  elf: Uint8Array;
  /**
   * The same image without relocation sections. Ghidra's ELF loader would apply them to words that already hold
   * link addresses, so the analysis imports this variant.
   */
  elfPlain: Uint8Array;
  /** Where each section sits in memory. */
  sections: { name: string; addr: number; size: number; nobits: boolean }[];
}

const SECTION_NAMES = ['', '.text', '.data', '.rodata'];

export function wrapOverlay(file: Uint8Array, o: OverlayLayout): WrappedImage {
  const base = overlaySections(o);
  const secs = overlayMemory(o);
  const resolved = resolveRelocs(file, o);
  const sectionOf = (addr: number): string | undefined => {
    for (const s of secs) if (addr >= s.addr && addr < s.addr + s.size) return s.name;
    if (o.bssSize && addr >= base.bss && addr < base.bss + o.bssSize) return '.bss';
    return addr === base.rodata + o.rodataSize || addr === base.bss ? '.bss' : undefined;
  };
  const relocs: ElfReloc[] = resolved.map((r) => ({
    section: SECTION_NAMES[r.section]!,
    addr: r.addr,
    type: r.type,
    symbol: (r.target !== undefined ? sectionOf(r.target) : undefined) ?? '.text',
  }));

  const spec: ElfSpec = {
    sections: secs.map((s) => ({
      name: s.name, addr: s.addr, data: file.subarray(s.off, s.off + s.size), exec: s.exec, write: s.write, align: 16,
    })),
    relocs,
  };
  if (o.bssSize) spec.sections.push({ name: '.bss', addr: base.bss, nobits: true, size: o.bssSize, write: true, align: 16 });
  return {
    name: `ovl_${String(o.fileIndex).padStart(4, '0')}`,
    kind: 'overlay',
    fileIndex: o.fileIndex,
    elf: writeElf(spec),
    elfPlain: writeElf({ ...spec, relocs: [] }),
    sections: spec.sections.map((s) => ({ name: s.name, addr: s.addr, size: s.nobits ? s.size! : s.data!.length, nobits: !!s.nobits })),
  };
}

export function wrapAll(rom: Uint8Array, files: FileEntry[], layout: RomLayout): WrappedImage[] {
  const out: WrappedImage[] = [];
  const { boot, code } = layout;

  const bootBytes = rom.subarray(boot.romOffset, boot.romOffset + (boot.ramEnd - boot.ramStart));
  const bootSpec: ElfSpec = {
    entry: boot.entry,
    sections: [
      { name: '.text', addr: boot.ramStart, data: bootBytes, exec: true, write: true, align: 16 },
      { name: '.bss', addr: boot.bss.start, nobits: true, size: boot.bss.size, write: true, align: 16 },
    ],
  };
  out.push({
    name: 'boot', kind: 'boot', elf: writeElf(bootSpec), elfPlain: writeElf(bootSpec),
    sections: [
      { name: '.text', addr: boot.ramStart, size: bootBytes.length, nobits: false },
      { name: '.bss', addr: boot.bss.start, size: boot.bss.size, nobits: true },
    ],
  });

  const codeFile = files.find((f) => f.index === code.fileIndex)!;
  const codeBytes = readFile(rom, codeFile);
  const codeSpec: ElfSpec = {
    entry: code.entry,
    sections: [
      { name: '.text', addr: code.ramStart, data: codeBytes, exec: true, write: true, align: 16 },
      { name: '.bss', addr: code.bss.start, nobits: true, size: code.bss.size, write: true, align: 16 },
    ],
  };
  out.push({
    name: 'code', kind: 'code', fileIndex: code.fileIndex, elf: writeElf(codeSpec), elfPlain: writeElf(codeSpec),
    sections: [
      { name: '.text', addr: code.ramStart, size: codeBytes.length, nobits: false },
      { name: '.bss', addr: code.bss.start, size: code.bss.size, nobits: true },
    ],
  });

  const byIndex = new Map(files.map((f) => [f.index, f]));
  for (const o of layout.overlays) out.push(wrapOverlay(readFile(rom, byIndex.get(o.fileIndex)!), o));
  return out;
}
