import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankImage, getRecord, importRawImage, putRecord } from './image.ts';
import { ITEM_SLOT_OF_ID, decodeName, describeRecord, editRecord, encodeName, entranceFor, newRecord } from './record.ts';
import { checksum, isUsed, storedChecksum, verify } from './sram.ts';

const u16 = (r: Uint8Array, at: number) => (r[at]! << 8) | r[at + 1]!;

describe('newRecord', () => {
  it('holds the defaults of a new file and passes its checksum', () => {
    const r = newRecord('Link');
    expect(isUsed(r)).toBe(true);
    expect(storedChecksum(r)).toBe(checksum(r));
    expect(decodeName(r.subarray(0x24, 0x2c))).toBe('Link    ');
    expect([u16(r, 0x2e), u16(r, 0x30), r[0x33], u16(r, 0x66), u16(r, 0x9c), u16(r, 0x70)]).toEqual([0x30, 0x30, 0x30, 52, 0x1100, 0x1100]);
    expect(Array.from(r.subarray(0x74, 0x8c)).every((b) => b === 0xff)).toBe(true);
    expect(Array.from(r.subarray(0x8c, 0x9c)).every((b) => b === 0)).toBe(true);
    expect(u16(r, 0x1352)).toBe(checksum(r));
  });
});

describe('names', () => {
  it('uses the game table: digits, capitals, lower case, blank, dash and dot', () => {
    expect(Array.from(encodeName('0Aa -.'))).toEqual([0, 0x0a, 0x24, 0x3e, 0x3f, 0x40, 0x3e, 0x3e]);
    expect(decodeName(encodeName('Zelda 7'))).toBe('Zelda 7 ');
  });
  it('refuses unknown characters and long names', () => {
    expect(() => encodeName('a_b')).toThrow(/not in the name table/);
    expect(() => encodeName('ninechars')).toThrow(/longer than 8/);
  });
});

describe('editRecord', () => {
  it('sets hearts, count34 with the limit, items and equipment and reseals', () => {
    const r = newRecord('A');
    editRecord(r, [['hearts', '14'], ['limit34', '2'], ['count34', '400'], ['item', '3'], ['items.0', '0'], ['equip0', '2'], ['equip1', '1'], ['bitsA4.7', '1'], ['countD0', '12']]);
    expect(verify(blank(r)).accepted).toBe(true);
    expect(describeRecord(r)).toMatchObject({
      hearts: 14, health: 14, limit34: 2, count34: 400, countD0: 12, bitsA4: [7],
      nibbleGroups: { equip0: { word9C: 2, word70: 2 }, equip1: { word9C: 1, word70: 1 } },
    });
    expect(r[0x74]).toBe(0);
    expect(r[0x74 + ITEM_SLOT_OF_ID[3]!]).toBe(3);
    expect(r[0x68]).toBe(60);
  });
  it('refuses count34 above limit34 and leaves the record untouched', () => {
    const r = newRecord('A');
    const before = r.slice();
    expect(() => editRecord(r, [['hearts', '5'], ['count34', '150']])).toThrow(/limit34/);
    expect(r).toEqual(before);
  });
  it('refuses unknown fields and out-of-range values', () => {
    const r = newRecord('A');
    expect(() => editRecord(r, [['bogus', '1']])).toThrow(/unknown field/);
    expect(() => editRecord(r, [['hearts', '21']])).toThrow(/outside/);
    expect(() => editRecord(r, [['items.24', '1']])).toThrow(/outside/);
    expect(() => editRecord(r, [['counts8C.16', '1']])).toThrow(/outside/);
  });
  it('resumes at the entrance the game derives from the scene and flag04', () => {
    expect(entranceFor(52, 0)).toBe(0xbb);
    expect(entranceFor(3, 1)).toBe(0x169);
    expect(entranceFor(30, 1)).toBe(0xbb);
    expect(entranceFor(30, 0)).toBe(0x5f4);
    const r = newRecord('A');
    editRecord(r, [['flag04', '0'], ['scene', '30']]);
    expect(describeRecord(r)).toMatchObject({ flag04: 0, scene: 30, resumeEntrance: 0x5f4 });
    expect(((r[0]! << 24) | (r[1]! << 16) | (r[2]! << 8) | r[3]!) >>> 0).toBe(0x5f4);
  });
});

function blank(record: Uint8Array): Uint8Array {
  const sram = blankImage();
  putRecord(sram, 0, record);
  return sram;
}

describe('images', () => {
  it('stores a record in both copies of the slot and reads it back', () => {
    const sram = blank(newRecord('Hi'));
    expect(verify(sram).slots.map((s) => s.used)).toEqual([true, false, false]);
    expect(getRecord(sram, 0)).toEqual(newRecord('Hi'));
    expect(getRecord(sram, 1)).toBeUndefined();
  });
  it('imports a raw image the game accepts and refuses one it would change', () => {
    const good = blank(newRecord('Hi')).subarray(0, 0x8000);
    expect(importRawImage(good).length).toBe(0x20000);
    const bad = good.slice();
    bad[0x30] = bad[0x30]! ^ 0xff;
    expect(() => importRawImage(bad)).toThrow(/unsupported/);
    expect(() => importRawImage(new Uint8Array(100))).toThrow(/unsupported/);
  });
});

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'save-cli-'));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'tools/saves/cli.ts', ...args], { encoding: 'utf8' });
  it('builds with new, edits with set and verifies', () => {
    const out = join(dir, 'sram.bin');
    expect(run('new', '--slot', '1', '--name', 'Zelda', '--out', out, 'hearts=10').status).toBe(0);
    expect(run('set', out, '--slot', '1', 'hearts=12', 'equip0=1').status).toBe(0);
    const sram = new Uint8Array(readFileSync(out));
    expect(describeRecord(getRecord(sram, 1)!)).toMatchObject({ name: 'Zelda   ', hearts: 12 });
    expect(run('verify', out).status).toBe(0);
    expect(run('set', out, '--slot', '2', 'hearts=3').status).toBe(1);
  });
  it('imports a raw image and reports a Controller Pak dump unsupported', () => {
    const raw = join(dir, 'raw.sra');
    writeFileSync(raw, blank(newRecord('Hi')).subarray(0, 0x8000));
    expect(run('import', raw, '--out', join(dir, 'imported.bin')).status).toBe(0);
    const dex = join(dir, 'dex.n64');
    writeFileSync(dex, Buffer.from('123-456-STD\0'));
    const r = run('import', dex, '--out', join(dir, 'x.bin'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unsupported/);
  });

  it('clears the cutscene index when the scene is set, so the entrance is not a cutscene layer', () => {
    const r = newRecord('Link');
    const word = (at: number) => new DataView(r.buffer).getUint32(at);
    expect(word(0x08)).toBe(0xfff1);
    editRecord(r, [['scene', '5']]);
    expect(word(0x08)).toBe(0);
    expect(word(0x00)).toBe(0x10);
  });
});
