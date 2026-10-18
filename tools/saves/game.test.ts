import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootWithSave, loadFirstFile, newFileSave } from './game.ts';
import { blankImage, putRecord } from './image.ts';
import { ITEM_SLOT_OF_ID, describeRecord, editRecord, newRecord } from './record.ts';
import { BACKUP, CHECKED_SIZE, PRIMARY, checksum, recordAt, storedChecksum, verify } from './sram.ts';
import { dumpSram } from './dump.ts';

const rom = process.env.OOT_ROM;
let written: Promise<Uint8Array> | undefined;
const gameWrittenSave = () => (written ??= newFileSave(rom!).then((r) => r.sram));

describe.skipIf(!rom || !existsSync(rom))('the save memory the game writes', () => {
  it('passes verify after the scripted new game creates a file, and the game keeps it as it is', async () => {
    const sram = await gameWrittenSave();
    const v = verify(sram);
    expect(v.problems).toEqual([]);
    expect(v.accepted).toBe(true);
    expect(v.slots.map((s) => s.used)).toEqual([true, false, false]);
    expect(v.slots[0]!).toMatchObject({ primary: 'ok', backup: 'ok', copiesEqual: true });

    const record = recordAt(sram, PRIMARY[0]);
    expect(storedChecksum(record)).toBe(checksum(record));
    const [slot0] = (dumpSram(sram) as { slots: { fields: Record<string, number | string> }[] }).slots;
    expect(slot0!.fields).toMatchObject({ entranceIndex: 0xbb, healthCapacity: 0x30, health: 0x30, sceneIndex: 52, magic: '5a454c44415a' });

    const again = await bootWithSave(rom!, sram);
    expect(again.rewritten).toBe(false);
    expect(Buffer.from(again.sram).equals(Buffer.from(sram))).toBe(true);

    // The game's own boot check sees what verify reports: a failing primary is restored from the backup, two failing copies reset the slot.
    const badPrimary = sram.slice();
    badPrimary[PRIMARY[0] + 0x40] = badPrimary[PRIMARY[0] + 0x40]! ^ 0xff;
    expect(verify(badPrimary).slots[0]!.outcome).toBe('from-backup');
    const restored = await bootWithSave(rom!, badPrimary);
    expect(restored.rewritten).toBe(true);
    expect(verify(restored.sram).slots[0]!).toMatchObject({ used: true, outcome: 'from-backup' });

    const bothBad = badPrimary.slice();
    bothBad[BACKUP[0] + 0x40] = bothBad[BACKUP[0] + 0x40]! ^ 0xff;
    expect(verify(bothBad).slots[0]!.outcome).toBe('reset');
    const reset = await bootWithSave(rom!, bothBad);
    expect(reset.rewritten).toBe(true);
    expect(verify(reset.sram).slots[0]!).toMatchObject({ used: false, outcome: 'kept' });
  }, 3_600_000);

  it('has its header rewritten when the signature differs', async () => {
    const sram = await gameWrittenSave();
    const bad = sram.slice();
    bad[4] = bad[4]! ^ 0xff;
    expect(verify(bad).header.signatureOk).toBe(false);
    const fixed = await bootWithSave(rom!, bad);
    expect(fixed.rewritten).toBe(true);
    expect(verify(fixed.sram).header.signatureOk).toBe(true);
  }, 3_600_000);
});

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32 = (b: Uint8Array, at: number) => ((u16(b, at) << 16) | u16(b, at + 2)) >>> 0;

/** Offsets of the file select's per-slot copies from the address of slot 0's name copy (`+0x1C9FC`): see docs/re/saves.md. */
const FS_CAPACITY = 0x1ca14 - 0x1c9fc;
const FS_BITS_A4 = 0x1ca1c - 0x1c9fc;
const FS_HEALTH = 0x1ca32 - 0x1c9fc;

/** The file select's copy of slot 0: the one place where the name bytes are followed by the word at +0xA4 and health at the file select's offsets. */
function fileSelectSlot0(ram: Uint8Array, name: Uint8Array, capacity: number, bitsA4: number, health: number): number[] {
  const hits: number[] = [];
  for (let i = 0; i + FS_HEALTH + 2 <= ram.length; i++) {
    if (ram[i] !== name[0] || !name.every((b, k) => ram[i + k] === b)) continue;
    if (u16(ram, i + FS_CAPACITY) === capacity && u32(ram, i + FS_BITS_A4) === bitsA4 && u16(ram, i + FS_HEALTH) === health) hits.push(i);
  }
  return hits;
}

describe.skipIf(!rom || !existsSync(rom))('saves built by hand', () => {
  it('builds the record the game writes for a new file', async () => {
    const { sram } = await newFileSave(rom!);
    const written = recordAt(sram, PRIMARY[0]).subarray(0, CHECKED_SIZE);
    const built = newRecord('A').subarray(0, CHECKED_SIZE);
    const differing = Array.from(built, (b, i) => (b === written[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differing).toEqual([]);
  }, 3_600_000);

  it('shows in the file select and loads with the inventory it was given', async () => {
    const record = newRecord('Zelda');
    editRecord(record, [
      ['hearts', '12'], ['limit34', '1'], ['count34', '150'], ['equip0', '1'], ['equip1', '2'], ['equip2', '2'], ['item', '3'], ['items.0', '0'],
      ['bitsA4.0', '1'], ['bitsA4.8', '1'], ['countD0', '3'], ['flag3A', '1'], ['flag3C', '1'],
    ]);
    const sram = blankImage();
    putRecord(sram, 0, record);
    expect(verify(sram).accepted).toBe(true);

    const { prompt, context, loadedAt } = await loadFirstFile(rom!, sram);
    const slot = fileSelectSlot0(prompt, record.subarray(0x24, 0x2c), 12 * 16, u32(record, 0xa4), 12 * 16);
    expect(slot).toHaveLength(1);

    expect(loadedAt).toBeDefined();
    const want = describeRecord(record);
    const got = describeRecord(context!);
    for (const key of ['name', 'hearts', 'health', 'limit34', 'count34', 'countD0', 'items', 'counts8C', 'nibbleGroups', 'bitsA4', 'flag3A', 'flag3C'] as const) {
      expect(got[key], key).toEqual(want[key]);
    }
    expect(context![0x74 + ITEM_SLOT_OF_ID[3]!]).toBe(3);
    expect(got.flag04).toBe(1);
  }, 3_600_000);

  it('shows and loads the hearts and the item changed with set', async () => {
    const record = newRecord('Link');
    editRecord(record, [['hearts', '5'], ['items.1', '1']]);
    editRecord(record, [['hearts', '9'], ['items.1', '2'], ['health', '7.5']]);
    const sram = blankImage();
    putRecord(sram, 0, record);

    const { prompt, context } = await loadFirstFile(rom!, sram);
    expect(fileSelectSlot0(prompt, record.subarray(0x24, 0x2c), 9 * 16, 0, 120)).toHaveLength(1);
    expect(u16(context!, 0x2e)).toBe(9 * 16);
    expect(u16(context!, 0x30)).toBe(120);
    expect(context![0x75]).toBe(2);
  }, 3_600_000);
});
