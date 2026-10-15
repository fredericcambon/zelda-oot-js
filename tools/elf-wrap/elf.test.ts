import { describe, expect, it } from 'vitest';
import {
  EF_MIPS_ABI_O32, EF_MIPS_ARCH_3, EM_MIPS, ET_EXEC, PT_LOAD, R_MIPS_32, R_MIPS_HI16, SHF_ALLOC, SHF_EXECINSTR,
  SHF_WRITE, SHT_NOBITS, SHT_PROGBITS, SHT_REL, SHT_STRTAB, SHT_SYMTAB, STT_FUNC, parseElf, writeElf,
} from './elf.ts';

const sample = () =>
  writeElf({
    entry: 0x80001000,
    sections: [
      { name: '.text', addr: 0x80001000, data: Uint8Array.from([0x27, 0xbd, 0xff, 0xe8, 0, 0, 0, 0]), exec: true },
      { name: '.data', addr: 0x80001010, data: Uint8Array.from([0x80, 0, 0x10, 0x04]), write: true },
      { name: '.bss', addr: 0x80001020, nobits: true, size: 0x40, write: true, align: 16 },
    ],
    symbols: [{ name: 'start', section: '.text', value: 0x80001000, size: 8, type: STT_FUNC }],
    relocs: [
      { section: '.text', addr: 0x80001000, type: R_MIPS_HI16, symbol: '.data' },
      { section: '.data', addr: 0x80001010, type: R_MIPS_32, symbol: '.text' },
    ],
  });

describe('writeElf', () => {
  it('writes an ELF32 big-endian MIPS executable header', () => {
    const b = sample();
    expect([...b.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    expect(b[4]).toBe(1); // ELFCLASS32
    expect(b[5]).toBe(2); // ELFDATA2MSB
    expect(b[6]).toBe(1); // EV_CURRENT
    const e = parseElf(b);
    expect(e.type).toBe(ET_EXEC);
    expect(e.machine).toBe(EM_MIPS);
    expect(e.flags).toBe(EF_MIPS_ARCH_3 | EF_MIPS_ABI_O32);
    expect(e.entry).toBe(0x80001000);
    const dv = new DataView(b.buffer);
    expect(dv.getUint16(40)).toBe(52); // e_ehsize
    expect(dv.getUint16(42)).toBe(32); // e_phentsize
    expect(dv.getUint16(46)).toBe(40); // e_shentsize
  });

  it('lays out sections with the null section first and a string table for names', () => {
    const e = parseElf(sample());
    expect(e.sections[0]!).toMatchObject({ name: '', type: 0, size: 0 });
    expect(e.sections.map((s) => s.name)).toEqual([
      '', '.text', '.data', '.bss', '.rel.text', '.rel.data', '.symtab', '.strtab', '.shstrtab',
    ]);
    const text = e.sections[1]!;
    expect(text.type).toBe(SHT_PROGBITS);
    expect(text.flags).toBe(SHF_ALLOC | SHF_EXECINSTR);
    expect(text.addr).toBe(0x80001000);
    expect(text.offset % text.align).toBe(0);
    const bss = e.sections[3]!;
    expect(bss.type).toBe(SHT_NOBITS);
    expect(bss.flags).toBe(SHF_ALLOC | SHF_WRITE);
    expect(bss.size).toBe(0x40);
    expect(e.sections.at(-1)!.type).toBe(SHT_STRTAB);
    expect([...e.sectionData('.text')]).toEqual([0x27, 0xbd, 0xff, 0xe8, 0, 0, 0, 0]);
  });

  it('emits one PT_LOAD per allocated section, with memsz larger than filesz for NOBITS', () => {
    const e = parseElf(sample());
    expect(e.segments).toHaveLength(3);
    expect(e.segments.every((s) => s.type === PT_LOAD)).toBe(true);
    expect(e.segments[0]!).toMatchObject({ vaddr: 0x80001000, filesz: 8, memsz: 8, flags: 5 });
    expect(e.segments[2]!).toMatchObject({ vaddr: 0x80001020, filesz: 0, memsz: 0x40, flags: 6 });
  });

  it('writes REL sections linked to the symbol table with ELF32_R_INFO packing', () => {
    const b = sample();
    const e = parseElf(b);
    const rel = e.sections.find((s) => s.name === '.rel.text')!;
    expect(rel.type).toBe(SHT_REL);
    expect(rel.entsize).toBe(8);
    expect(e.sections[rel.link]!.type).toBe(SHT_SYMTAB);
    expect(e.sections[rel.info]!.name).toBe('.text');
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(rel.offset)).toBe(0x80001000);
    const info = dv.getUint32(rel.offset + 4);
    expect(info & 0xff).toBe(R_MIPS_HI16);
    expect(e.symbols[info >>> 8]!.shndx).toBe(2); // section symbol of .data
    expect(e.relocs).toEqual([
      { section: '.text', addr: 0x80001000, type: R_MIPS_HI16, symbol: '.data' },
      { section: '.data', addr: 0x80001010, type: R_MIPS_32, symbol: '.text' },
    ]);
  });

  it('keeps local symbols before globals and records that boundary in sh_info', () => {
    const e = parseElf(sample());
    expect(e.symbols[0]!).toMatchObject({ name: '', value: 0, shndx: 0 });
    const symtab = e.sections.find((s) => s.type === SHT_SYMTAB)!;
    expect(symtab.entsize).toBe(16);
    expect(symtab.info).toBe(4); // null symbol + three section symbols
    expect(e.symbols[symtab.info]!).toMatchObject({ name: 'start', value: 0x80001000, size: 8 });
    expect(e.symbols[symtab.info]!.info).toBe((1 << 4) | STT_FUNC);
  });

  it('rejects relocations against unknown symbols and non-ELF input', () => {
    expect(() =>
      writeElf({
        sections: [{ name: '.text', addr: 0, data: new Uint8Array(4) }],
        relocs: [{ section: '.text', addr: 0, type: R_MIPS_32, symbol: 'missing' }],
      }),
    ).toThrow(/unknown symbol/);
    expect(() => parseElf(new Uint8Array(64))).toThrow(/not an ELF/);
  });
});
