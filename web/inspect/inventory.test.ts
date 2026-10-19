import { describe, expect, it } from 'vitest';
import { SAVE_CONTEXT } from '../../tools/headless/load-save.ts';
import { newRecord } from '../../tools/saves/record.ts';
import { CHECKED_SIZE } from '../../tools/saves/sram.ts';
import { Bridge } from './bridge.ts';
import { editContext, inventorySnapshot, readContext, toggleFreeze } from './inventory.ts';
import { Refused } from './queue.ts';

function setup(unsafe?: string) {
  const ram = new Uint8Array(0x800000);
  ram.set(newRecord('LINK').subarray(0, CHECKED_SIZE), SAVE_CONTEXT & 0x7fffff);
  const bridge = new Bridge(() => ram, () => unsafe);
  return { ram, bridge, at: (o: number) => ram[(SAVE_CONTEXT & 0x7fffff) + o]! };
}

describe('inventory', () => {
  it('reads the context with describeRecord', () => {
    const { bridge } = setup();
    const snap = inventorySnapshot(bridge);
    expect(snap.fields).toMatchObject({ name: 'LINK    ', hearts: 3, health: 3 });
    expect((snap.fields!.items as number[]).length).toBe(24);
  });

  it('edits hearts and an item slot, leaving the checksum alone', () => {
    const { bridge, at } = setup();
    const sum = [at(0x1352), at(0x1353)];
    editContext(bridge, [['hearts', '10'], ['items.3', '15']]);
    expect(at(0x2f)).toBe(160);
    expect(at(0x31)).toBe(160);
    expect(at(0x74 + 3)).toBe(15);
    expect([at(0x1352), at(0x1353)]).toEqual(sum);
  });

  it('refuses invalid edits and unsafe states without writing', () => {
    const bad = setup();
    expect(() => editContext(bad.bridge, [['hearts', '99']])).toThrow(Refused);
    expect(bad.at(0x2f)).toBe(48);
    const unsafe = setup('a scene transition is in progress');
    expect(() => editContext(unsafe.bridge, [['hearts', '5']])).toThrow(/transition/);
    expect(unsafe.at(0x2f)).toBe(48);
  });

  it('holds a field across frames and follows edits', () => {
    const { ram, bridge, at } = setup();
    toggleFreeze(bridge, 'items.0');
    expect(inventorySnapshot(bridge).frozen).toEqual(['items.0']);
    ram[(SAVE_CONTEXT & 0x7fffff) + 0x74] = 0xff;
    bridge.applyFreezes();
    expect(at(0x74)).toBe(readContext(bridge.ram()!)[0x74]);
    editContext(bridge, [['items.0', '7']]);
    ram[(SAVE_CONTEXT & 0x7fffff) + 0x74] = 0;
    bridge.applyFreezes();
    expect(at(0x74)).toBe(7);
    toggleFreeze(bridge, 'items.0');
    expect(inventorySnapshot(bridge).frozen).toEqual([]);
  });
});

describe('edits beyond editRecord', () => {
  it('sets heart pieces, upgrade levels and magic, and reads them back', () => {
    const { bridge, at } = setup();
    editContext(bridge, [['heartPieces', '3'], ['upgrade.1', '4'], ['upgrade.0', '2'], ['magicSize', '2'], ['magic', '90']]);
    const fields = inventorySnapshot(bridge).fields!;
    expect(fields.heartPieces).toBe(3);
    expect(fields.upgrades).toEqual([2, 4, 0, 0]);
    expect([fields.level32, fields.flag3A, fields.flag3C, fields.byte33]).toEqual([2, 1, 1, 90]);
    expect(at(0xa4)).toBe(0x30);
    editContext(bridge, [['magicSize', '1']]);
    expect(inventorySnapshot(bridge).fields).toMatchObject({ level32: 1, flag3C: 0, byte33: 0x30 });
  });

  it('owns and gives up an equipment column', () => {
    const { bridge } = setup();
    editContext(bridge, [['own.2.1', '1']]);
    expect((inventorySnapshot(bridge).fields!.nibbleGroups as Record<string, { word9C: number }>).equip2!.word9C & 2).toBe(2);
    editContext(bridge, [['own.2.1', '0']]);
    expect((inventorySnapshot(bridge).fields!.nibbleGroups as Record<string, { word9C: number }>).equip2!.word9C & 2).toBe(0);
  });

  it('refuses out-of-range values', () => {
    const { bridge } = setup();
    expect(() => editContext(bridge, [['heartPieces', '9']])).toThrow(Refused);
    expect(() => editContext(bridge, [['magic', '200']])).toThrow(Refused);
  });
});
