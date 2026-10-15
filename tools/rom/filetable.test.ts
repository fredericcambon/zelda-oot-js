import { describe, expect, it } from 'vitest';
import { locateFileTable } from './filetable.ts';

const TABLE_AT = 0x1230;
const COUNT = 80;

// File 0 is stored, spans virtual/ROM 0..0x2000 and so covers the table. Files
// 1.. take 0x100 virtual bytes each; odd ones are compressed into 0x40 bytes.
function build(opts: { skipFirst?: boolean } = {}): Uint8Array {
  const rom = new Uint8Array(0x10000);
  const v = new DataView(rom.buffer);
  let phys = 0x2000;
  for (let i = 0; i < COUNT; i++) {
    const o = TABLE_AT + i * 16;
    const compressed = i % 2 === 1;
    const stored = compressed ? 0x40 : 0x100;
    const vs = i === 0 ? (opts.skipFirst ? 0x400 : 0) : 0x2000 + i * 0x100;
    const ve = i === 0 ? 0x2000 : vs + 0x100;
    v.setUint32(o, vs);
    v.setUint32(o + 4, ve);
    v.setUint32(o + 8, i === 0 ? 0 : phys);
    v.setUint32(o + 12, compressed ? phys + stored : 0);
    if (i > 0) phys += stored;
  }
  return rom;
}

describe('locateFileTable', () => {
  it('finds the table and classifies entries', () => {
    const t = locateFileTable(build());
    expect(t.offset).toBe(TABLE_AT);
    expect(t.entries).toHaveLength(COUNT);
    expect(t.entries[1]).toMatchObject({ compressed: true, romEnd: t.entries[1]!.romStart + 0x40 });
    expect(t.entries[2]).toMatchObject({ compressed: false });
    expect(t.entries[2]!.romEnd - t.entries[2]!.romStart).toBe(0x100);
  });

  it('fails when no table is present', () => {
    expect(() => locateFileTable(new Uint8Array(0x4000))).toThrow(/not found/);
  });

  it('requires the first file to map virtual 0 to ROM 0', () => {
    expect(() => locateFileTable(build({ skipFirst: true }))).toThrow(/virtual 0/);
  });
});
