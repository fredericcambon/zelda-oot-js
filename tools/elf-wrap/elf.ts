// ELF32 big-endian MIPS writer and parser (System V gABI, MIPS o32 supplement).

export const ET_EXEC = 2;
export const EM_MIPS = 8;
export const EF_MIPS_ABI_O32 = 0x1000;
export const EF_MIPS_ARCH_3 = 0x20000000;

export const SHT_PROGBITS = 1;
export const SHT_SYMTAB = 2;
export const SHT_STRTAB = 3;
export const SHT_NOBITS = 8;
export const SHT_REL = 9;

export const SHF_WRITE = 1;
export const SHF_ALLOC = 2;
export const SHF_EXECINSTR = 4;
export const SHF_INFO_LINK = 0x40;

export const PT_LOAD = 1;
export const PF_X = 1;
export const PF_W = 2;
export const PF_R = 4;

export const STB_GLOBAL = 1;
export const STT_NOTYPE = 0;
export const STT_FUNC = 2;
export const STT_SECTION = 3;

export const R_MIPS_32 = 2;
export const R_MIPS_26 = 4;
export const R_MIPS_HI16 = 5;
export const R_MIPS_LO16 = 6;

export const EHDR_SIZE = 52;
export const PHDR_SIZE = 32;
export const SHDR_SIZE = 40;
const SYM_SIZE = 16;
const REL_SIZE = 8;

export interface ElfSection {
  name: string;
  /** Contents; NOBITS sections only use `size`. */
  data?: Uint8Array;
  size?: number;
  nobits?: boolean;
  addr: number;
  exec?: boolean;
  write?: boolean;
  align?: number;
}

export interface ElfSymbol {
  name: string;
  /** Section the symbol belongs to. */
  section: string;
  /** Virtual address. */
  value: number;
  size?: number;
  type?: number;
}

export interface ElfReloc {
  /** Section containing the relocated word. */
  section: string;
  /** Virtual address of the relocated word. */
  addr: number;
  type: number;
  /** Name of the section whose address the word refers to. */
  symbol: string;
}

export interface ElfSpec {
  entry?: number;
  sections: ElfSection[];
  symbols?: ElfSymbol[];
  relocs?: ElfReloc[];
}

class Strtab {
  private bytes: number[] = [0];
  private seen = new Map<string, number>();
  add(s: string): number {
    if (s === '') return 0;
    const known = this.seen.get(s);
    if (known !== undefined) return known;
    const at = this.bytes.length;
    for (const c of Buffer.from(s, 'latin1')) this.bytes.push(c);
    this.bytes.push(0);
    this.seen.set(s, at);
    return at;
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const alignUp = (n: number, a: number) => (a <= 1 ? n : Math.ceil(n / a) * a);

interface OutSection {
  name: string;
  type: number;
  flags: number;
  addr: number;
  bytes: Uint8Array;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
  offset: number;
}

export function writeElf(spec: ElfSpec): Uint8Array {
  const shstr = new Strtab();
  const str = new Strtab();
  /** Section header table without the null entry at index 0. */
  const out: OutSection[] = [];
  const mk = (o: Partial<OutSection> & { name: string; type: number }): number => {
    out.push({ flags: 0, addr: 0, bytes: new Uint8Array(0), size: 0, link: 0, info: 0, align: 1, entsize: 0, offset: 0, ...o });
    return out.length;
  };

  const index = new Map<string, number>();
  for (const s of spec.sections) {
    const nobits = s.nobits === true;
    index.set(
      s.name,
      mk({
        name: s.name,
        type: nobits ? SHT_NOBITS : SHT_PROGBITS,
        flags: SHF_ALLOC | (s.exec ? SHF_EXECINSTR : 0) | (s.write ? SHF_WRITE : 0),
        addr: s.addr,
        bytes: nobits ? new Uint8Array(0) : s.data!,
        size: nobits ? (s.size ?? 0) : s.data!.length,
        align: s.align ?? 4,
      }),
    );
  }

  // Symbol table: null symbol, one local section symbol per section, then the caller's symbols (global).
  const symIndex = new Map<string, number>();
  const syms: { name: number; value: number; size: number; info: number; shndx: number }[] = [
    { name: 0, value: 0, size: 0, info: 0, shndx: 0 },
  ];
  for (const s of spec.sections) {
    symIndex.set(s.name, syms.length);
    syms.push({ name: 0, value: s.addr, size: 0, info: STT_SECTION, shndx: index.get(s.name)! });
  }
  const firstGlobal = syms.length;
  for (const sym of spec.symbols ?? []) {
    const shndx = index.get(sym.section);
    if (shndx === undefined) throw new Error(`symbol ${sym.name} is in unknown section ${sym.section}`);
    syms.push({
      name: str.add(sym.name),
      value: sym.value,
      size: sym.size ?? 0,
      info: (STB_GLOBAL << 4) | (sym.type ?? STT_NOTYPE),
      shndx,
    });
  }

  const byTarget = new Map<string, ElfReloc[]>();
  for (const r of spec.relocs ?? []) {
    const list = byTarget.get(r.section) ?? [];
    list.push(r);
    byTarget.set(r.section, list);
  }

  // .symtab follows the REL sections; section header indexes include the null entry, hence the +1.
  const symtabIdx = out.length + byTarget.size + 1;
  for (const [target, list] of byTarget) {
    const b = new Uint8Array(list.length * REL_SIZE);
    const dv = new DataView(b.buffer);
    list.forEach((r, i) => {
      const sym = symIndex.get(r.symbol);
      if (sym === undefined) throw new Error(`relocation refers to unknown symbol ${r.symbol}`);
      dv.setUint32(i * REL_SIZE, r.addr >>> 0);
      dv.setUint32(i * REL_SIZE + 4, ((sym << 8) | r.type) >>> 0);
    });
    mk({
      name: `.rel${target}`, type: SHT_REL, flags: SHF_INFO_LINK, bytes: b, size: b.length,
      link: symtabIdx, info: index.get(target)!, align: 4, entsize: REL_SIZE,
    });
  }

  const symBytes = new Uint8Array(syms.length * SYM_SIZE);
  const sdv = new DataView(symBytes.buffer);
  syms.forEach((s, i) => {
    const o = i * SYM_SIZE;
    sdv.setUint32(o, s.name);
    sdv.setUint32(o + 4, s.value >>> 0);
    sdv.setUint32(o + 8, s.size);
    sdv.setUint8(o + 12, s.info);
    sdv.setUint16(o + 14, s.shndx);
  });
  mk({
    name: '.symtab', type: SHT_SYMTAB, bytes: symBytes, size: symBytes.length, link: symtabIdx + 1, info: firstGlobal,
    align: 4, entsize: SYM_SIZE,
  });
  const strBytes = str.toBytes();
  mk({ name: '.strtab', type: SHT_STRTAB, bytes: strBytes, size: strBytes.length });
  const nameOffsets = out.map((s) => shstr.add(s.name));
  nameOffsets.push(shstr.add('.shstrtab'));
  const shstrBytes = shstr.toBytes();
  const shstrtabIdx = mk({ name: '.shstrtab', type: SHT_STRTAB, bytes: shstrBytes, size: shstrBytes.length });

  const loadable = spec.sections.map((s) => index.get(s.name)!);
  let pos = EHDR_SIZE + loadable.length * PHDR_SIZE;
  for (const s of out) {
    s.offset = alignUp(pos, s.align);
    pos = s.offset + s.bytes.length;
  }
  const shoff = alignUp(pos, 4);
  const buf = new Uint8Array(shoff + (out.length + 1) * SHDR_SIZE);
  const dv = new DataView(buf.buffer);

  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1, 0], 0);
  dv.setUint16(16, ET_EXEC);
  dv.setUint16(18, EM_MIPS);
  dv.setUint32(20, 1);
  dv.setUint32(24, (spec.entry ?? 0) >>> 0);
  dv.setUint32(28, loadable.length ? EHDR_SIZE : 0);
  dv.setUint32(32, shoff);
  dv.setUint32(36, EF_MIPS_ARCH_3 | EF_MIPS_ABI_O32);
  dv.setUint16(40, EHDR_SIZE);
  dv.setUint16(42, PHDR_SIZE);
  dv.setUint16(44, loadable.length);
  dv.setUint16(46, SHDR_SIZE);
  dv.setUint16(48, out.length + 1);
  dv.setUint16(50, shstrtabIdx);

  loadable.forEach((si, i) => {
    const s = out[si - 1]!;
    const o = EHDR_SIZE + i * PHDR_SIZE;
    dv.setUint32(o, PT_LOAD);
    dv.setUint32(o + 4, s.offset);
    dv.setUint32(o + 8, s.addr >>> 0);
    dv.setUint32(o + 12, s.addr >>> 0);
    dv.setUint32(o + 16, s.type === SHT_NOBITS ? 0 : s.size);
    dv.setUint32(o + 20, s.size);
    dv.setUint32(o + 24, PF_R | (s.flags & SHF_WRITE ? PF_W : 0) | (s.flags & SHF_EXECINSTR ? PF_X : 0));
    dv.setUint32(o + 28, s.align);
  });

  out.forEach((s) => buf.set(s.bytes, s.offset));
  out.forEach((s, i) => {
    const o = shoff + (i + 1) * SHDR_SIZE;
    dv.setUint32(o, nameOffsets[i]!);
    dv.setUint32(o + 4, s.type);
    dv.setUint32(o + 8, s.flags);
    dv.setUint32(o + 12, s.addr >>> 0);
    dv.setUint32(o + 16, s.offset);
    dv.setUint32(o + 20, s.size);
    dv.setUint32(o + 24, s.link);
    dv.setUint32(o + 28, s.info);
    dv.setUint32(o + 32, s.align);
    dv.setUint32(o + 36, s.entsize);
  });
  return buf;
}

export interface ParsedSection {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
}

export interface ParsedElf {
  type: number;
  machine: number;
  flags: number;
  entry: number;
  sections: ParsedSection[];
  segments: { type: number; offset: number; vaddr: number; filesz: number; memsz: number; flags: number }[];
  symbols: { name: string; value: number; size: number; info: number; shndx: number }[];
  relocs: { section: string; addr: number; type: number; symbol: string }[];
  /** Bytes of a section by name (empty for NOBITS). */
  sectionData(name: string): Uint8Array;
}

export function parseElf(buf: Uint8Array): ParsedElf {
  if (buf.length < EHDR_SIZE) throw new Error('not an ELF file: too short');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x7f454c46) throw new Error('not an ELF file: bad magic');
  if (buf[4] !== 1) throw new Error('not ELF32');
  if (buf[5] !== 2) throw new Error('not big-endian');
  const phoff = dv.getUint32(28);
  const shoff = dv.getUint32(32);
  const phnum = dv.getUint16(44);
  const shnum = dv.getUint16(48);
  const shstrndx = dv.getUint16(50);
  if (phnum && dv.getUint16(42) !== PHDR_SIZE) throw new Error('bad e_phentsize');
  if (shnum && dv.getUint16(46) !== SHDR_SIZE) throw new Error('bad e_shentsize');
  if (shoff + shnum * SHDR_SIZE > buf.length) throw new Error('section header table is truncated');

  const raw: Omit<ParsedSection, 'name'>[] = [];
  const nameOffs: number[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * SHDR_SIZE;
    nameOffs.push(dv.getUint32(o));
    raw.push({
      type: dv.getUint32(o + 4), flags: dv.getUint32(o + 8), addr: dv.getUint32(o + 12), offset: dv.getUint32(o + 16),
      size: dv.getUint32(o + 20), link: dv.getUint32(o + 24), info: dv.getUint32(o + 28), align: dv.getUint32(o + 32),
      entsize: dv.getUint32(o + 36),
    });
  }
  const cstr = (tab: number, off: number): string => {
    let e = tab + off;
    let s = '';
    while (buf[e] !== 0) s += String.fromCharCode(buf[e++]!);
    return s;
  };
  const sections: ParsedSection[] = raw.map((r, i) => ({ ...r, name: cstr(raw[shstrndx]!.offset, nameOffs[i]!) }));

  const segments: ParsedElf['segments'] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * PHDR_SIZE;
    segments.push({
      type: dv.getUint32(o), offset: dv.getUint32(o + 4), vaddr: dv.getUint32(o + 8), filesz: dv.getUint32(o + 16),
      memsz: dv.getUint32(o + 20), flags: dv.getUint32(o + 24),
    });
  }

  const symbols: ParsedElf['symbols'] = [];
  for (const s of sections.filter((x) => x.type === SHT_SYMTAB)) {
    const strOff = sections[s.link]!.offset;
    for (let o = s.offset; o < s.offset + s.size; o += SYM_SIZE) {
      symbols.push({
        name: cstr(strOff, dv.getUint32(o)), value: dv.getUint32(o + 4), size: dv.getUint32(o + 8),
        info: dv.getUint8(o + 12), shndx: dv.getUint16(o + 14),
      });
    }
  }
  const relocs: ParsedElf['relocs'] = [];
  for (const s of sections.filter((x) => x.type === SHT_REL)) {
    for (let o = s.offset; o < s.offset + s.size; o += REL_SIZE) {
      const info = dv.getUint32(o + 4);
      const sym = symbols[info >>> 8]!;
      relocs.push({
        section: sections[s.info]!.name,
        addr: dv.getUint32(o),
        type: info & 0xff,
        symbol: (sym.info & 0xf) === STT_SECTION ? sections[sym.shndx]!.name : sym.name,
      });
    }
  }
  return {
    type: dv.getUint16(16), machine: dv.getUint16(18), flags: dv.getUint32(36), entry: dv.getUint32(24),
    sections, segments, symbols, relocs,
    sectionData(name) {
      const s = sections.find((x) => x.name === name);
      if (!s) throw new Error(`no section ${name}`);
      return s.type === SHT_NOBITS ? new Uint8Array(0) : buf.subarray(s.offset, s.offset + s.size);
    },
  };
}
