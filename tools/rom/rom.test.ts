import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRom, readFile } from './extract.ts';
import { locateFileTable } from './filetable.ts';
import { loadRom, PAL_1_0_SHA1 } from './rom.ts';

describe('loadRom', () => {
  it('rejects an image with the wrong hash', () => {
    const fake = new Uint8Array(64);
    fake.set([0x80, 0x37, 0x12, 0x40]);
    expect(() => loadRom(fake)).toThrow(/wrong ROM: SHA-1 is [0-9a-f]{40}, expected 328a1f1b/);
  });
});

const romPath = process.env.OOT_ROM;

describe.skipIf(!romPath)('PAL 1.0 ROM', () => {
  const raw = romPath ? new Uint8Array(readFileSync(romPath)) : new Uint8Array();

  it('matches the PAL 1.0 hash and header', () => {
    const rom = loadRom(raw);
    expect(rom.sha1).toBe(PAL_1_0_SHA1);
    expect(rom.header.gameCode).toBe('NZLP');
    expect(rom.header.version).toBe(0);
  });

  it('has 1511 files, all decompressing to their declared size', () => {
    const rom = loadRom(raw);
    const table = locateFileTable(rom.data);
    expect(table.entries).toHaveLength(1511);
    expect(table.entries.filter((e) => e.compressed)).toHaveLength(1457);
    for (const e of table.entries) {
      expect(readFile(rom.data, e).length).toBe(e.virtualEnd - e.virtualStart);
    }
  });

  it('writes an index next to the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oot-extract-'));
    try {
      const index = extractRom(raw, dir);
      expect(index.files).toHaveLength(1511);
      expect(readFileSync(join(dir, index.files[9]!.path)).length).toBe(index.files[9]!.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
