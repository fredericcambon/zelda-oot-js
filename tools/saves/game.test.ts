import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootWithSave, newFileSave } from './game.ts';
import { BACKUP, PRIMARY, checksum, recordAt, storedChecksum, verify } from './sram.ts';
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
