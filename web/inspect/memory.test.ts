import { describe, expect, it } from 'vitest';
import { applyCheats, loadCheats, parseCode, saveCheats, type Cheat } from './cheats.ts';
import { Bridge } from './bridge.ts';
import { loadWatches, MemoryModel, parseAddress, parseValue, readTyped, bitsOf } from './memory.ts';
import { Refused } from './queue.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

function setup(unsafe?: string) {
  const ram = new Uint8Array(0x800000);
  const bridge = new Bridge(() => ram, () => unsafe);
  const model = new MemoryModel(memory());
  return { ram, bridge, model };
}

describe('addresses and values', () => {
  it('takes full addresses and offsets, and refuses the rest', () => {
    expect(parseAddress('0x80123456')).toBe(0x80123456);
    expect(parseAddress('80123456')).toBe(0x80123456);
    expect(parseAddress('0x1234')).toBe(0x80001234);
    expect(() => parseAddress('0x80800000')).toThrow(Refused);
    expect(() => parseAddress('zz')).toThrow(Refused);
    expect(() => parseAddress('0xA0000000')).toThrow(Refused);
  });

  it('parses typed values with their ranges', () => {
    expect(parseValue('u8', '0x7B')).toBe(123);
    expect(parseValue('s16', '-5')).toBe(-5);
    expect(parseValue('float', '1.5')).toBe(1.5);
    expect(() => parseValue('u8', '256')).toThrow(Refused);
    expect(() => parseValue('s16', '40000')).toThrow(Refused);
    expect(() => parseValue('u16', 'abc')).toThrow(Refused);
    expect(bitsOf('s16', -1)).toBe(0xffff);
    expect(bitsOf('float', 1)).toBe(0x3f800000);
  });
});

describe('MemoryModel', () => {
  it('reads a window, marks changed bytes and moves', () => {
    const { ram, bridge, model } = setup();
    model.setStart(0x80000105);
    expect(model.windowStart).toBe(0x80000100);
    expect(model.tick(bridge).age[3]).toBe(255);
    ram[0x103] = 9;
    const snap = model.tick(bridge);
    expect(snap.bytes[3]).toBe(9);
    expect(snap.age[3]).toBe(0);
    expect(model.tick(bridge).age[3]).toBe(1);
  });

  it('edits in place through a safe state only', () => {
    const { ram, bridge, model } = setup();
    expect(() => model.write(bridge, 0x80000010, 'u16', '0x1234')).not.toThrow();
    expect([ram[0x10], ram[0x11]]).toEqual([0x12, 0x34]);
    const unsafe = setup('a scene transition is in progress');
    expect(() => unsafe.model.write(unsafe.bridge, 0x80000010, 'u8', '1')).toThrow(/transition/);
    expect(unsafe.ram[0x10]).toBe(0);
  });

  it('pins a watch, holds it across frames, and follows edits', () => {
    const { ram, bridge, model } = setup();
    model.addWatch(0x80000020, 'u16');
    model.addWatch(0x80000020, 'u16');
    const id = model.tick(bridge).watches[0]!.id;
    model.write(bridge, 0x80000020, 'u16', '50');
    model.toggleHold(bridge, id);
    expect(model.tick(bridge).watches).toMatchObject([{ value: 50, frozen: true }]);
    ram[0x21] = 0;
    bridge.applyFreezes();
    expect(ram[0x21]).toBe(50);
    model.writeWatch(bridge, id, '70');
    ram[0x21] = 0;
    bridge.applyFreezes();
    expect(ram[0x21]).toBe(70);
    model.toggleHold(bridge, id);
    expect(model.tick(bridge).watches[0]!.frozen).toBe(false);
  });

  it('keeps watches in storage', () => {
    const store = memory();
    const a = new MemoryModel(store);
    a.addWatch(0x80000020, 's16');
    expect(loadWatches(store)).toMatchObject([{ addr: 0x80000020, type: 's16' }]);
  });

  it('narrows a changing value to a few addresses', () => {
    const { ram, bridge, model } = setup();
    const view = new DataView(ram.buffer);
    for (let off = 0; off < 0x1000; off += 2) view.setUint16(off, off & 0xffff);
    view.setUint16(0x4000, 7);
    view.setUint16(0x4100, 7);
    model.startSearch(bridge, 'u16');
    view.setUint16(0x4000, 8);
    view.setUint16(0x4100, 8);
    view.setUint16(0x5000, 1);
    expect(model.narrow(bridge, 'changed')).toBe('3 addresses left');
    expect(model.narrow(bridge, 'equal', '8')).toBe('2 addresses left');
    view.setUint16(0x4100, 9);
    expect(model.narrow(bridge, 'unchanged')).toBe('1 address left');
    expect(model.tick(bridge).search).toMatchObject({ count: 1, hits: [{ addr: 0x80004000, value: 8 }] });
    expect(readTyped(ram, 0x80004000, 'u16')).toBe(8);
    expect(() => new MemoryModel(memory()).narrow(bridge, 'changed')).toThrow(Refused);
  });
});

describe('cheat codes', () => {
  it('parses writes and conditionals', () => {
    expect(parseCode('8011A5D0 0063\n81 11A5D2 1234')).toEqual({ holds: [{ addr: 0x8011a5d0, size: 1, value: 0x63 }, { addr: 0x8011a5d2, size: 2, value: 0x1234 }] });
    expect(parseCode('D0100000 0001\n81100002 0005')).toEqual({ holds: [{ addr: 0x80100002, size: 2, value: 5, when: [{ addr: 0x80100000, size: 1, value: 1, equal: true }] }] });
  });

  it('refuses what it cannot hold', () => {
    for (const bad of ['', 'zz', '8011A5D0', '8011A5D0 0163', '8111A5D1 0001', '90000000 0001', '80800000 0001', 'D0100000 0001']) {
      expect(parseCode(bad)).toHaveProperty('error');
    }
  });

  it('holds a 16-bit write every frame while enabled, and stops when disabled', () => {
    const { ram, bridge } = setup();
    const cheat: Cheat = { id: 'a', name: '', code: '81100010 0063', enabled: true };
    applyCheats(bridge.freezes, [cheat]);
    for (let i = 0; i < 3; i++) {
      ram[0x100010] = 0;
      ram[0x100011] = 0;
      bridge.applyFreezes();
      expect([ram[0x100010], ram[0x100011]]).toEqual([0, 0x63]);
    }
    applyCheats(bridge.freezes, [{ ...cheat, enabled: false }]);
    ram[0x100011] = 0;
    bridge.applyFreezes();
    expect(ram[0x100011]).toBe(0);
  });

  it('writes after "if equal" only while the condition holds', () => {
    const { ram, bridge } = setup();
    applyCheats(bridge.freezes, [{ id: 'b', name: '', code: 'D0100000 0001\n80100001 0009', enabled: true }]);
    bridge.applyFreezes();
    expect(ram[0x100001]).toBe(0);
    ram[0x100000] = 1;
    bridge.applyFreezes();
    expect(ram[0x100001]).toBe(9);
  });

  it('keeps cheats in storage', () => {
    const store = memory();
    saveCheats([{ id: 'x', name: 'n', code: '80100000 0001', enabled: false }], store);
    expect(loadCheats(store)).toEqual([{ id: 'x', name: 'n', code: '80100000 0001', enabled: false }]);
    store.setItem('zelda-oot-js:cheats', '{bad');
    expect(loadCheats(store)).toEqual([]);
  });
});
