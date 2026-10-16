import { describe, expect, it } from 'vitest';
import { captureMemory, decodeMemory, encodeMemory, restoreMemory, type SnapshotCore } from './snapshot.ts';

const exportA = () => 'a';
const exportB = () => 'b';
const exportC = () => 'c';
const SRAM_AT = 0x100;
const SRAM_SIZE = 8;
const ROM_AT = 0x200;
const ROM_SIZE = 0x40;

/** A module whose memory is a plain array that grows when an allocation does not fit. */
function fakeModule(length: number): SnapshotCore & { frees: number[] } {
  const m = {
    HEAPU8: new Uint8Array(length),
    frees: [] as number[],
    _malloc(n: number) {
      if (n > 0x100) {
        const grown = new Uint8Array(m.HEAPU8.length + n);
        grown.set(m.HEAPU8);
        m.HEAPU8 = grown;
      }
      return 8;
    },
    _free: (p: number) => void m.frees.push(p),
    _oot_rom_base: () => ROM_AT,
    _oot_rom_size: () => ROM_SIZE,
    _oot_sram: () => SRAM_AT,
    _oot_sram_size: () => SRAM_SIZE,
    Asyncify: {
      state: 0,
      currData: null,
      exportCallStack: [] as unknown[],
      callStackId: 2,
      callstackFuncToId: new Map<unknown, number>([[exportB, 0], [exportA, 1]]),
      callStackIdToFunc: new Map<number, unknown>([[0, exportB], [1, exportA]]),
      funcWrappers: new Map<unknown, unknown>([[exportA, 0], [exportB, 0], [exportC, 0]]),
    },
  };
  return m as unknown as SnapshotCore & { frees: number[] };
}

describe('memory snapshots', () => {
  it('restores everything but the cartridge image and the save memory', () => {
    const mod = fakeModule(0x400);
    mod.HEAPU8.fill(1);
    mod.HEAPU8.fill(2, SRAM_AT, SRAM_AT + SRAM_SIZE);
    const snap = captureMemory(mod);
    mod.HEAPU8.fill(3);
    restoreMemory(mod, snap);
    expect(mod.HEAPU8[0]).toBe(1);
    expect(mod.HEAPU8[0x3ff]).toBe(1);
    expect(mod.HEAPU8[ROM_AT]).toBe(3);
    expect(mod.HEAPU8[SRAM_AT]).toBe(3);
  });

  it('grows a smaller module and clears what it grew into after the state was taken', () => {
    const mod = fakeModule(0x400);
    mod.HEAPU8.fill(1);
    const snap = captureMemory(mod);
    const small = fakeModule(0x300);
    restoreMemory(small, snap);
    expect(small.HEAPU8.length).toBeGreaterThanOrEqual(0x400);
    expect(small.HEAPU8[0x3ff]).toBe(1);

    const larger = fakeModule(0x800);
    larger.HEAPU8.fill(9);
    restoreMemory(larger, snap);
    expect(larger.HEAPU8[0x7ff]).toBe(0);
    expect(larger.HEAPU8[0x3ff]).toBe(1);
  });

  it('carries the numbers Asyncify handed out to a module that has handed out none', () => {
    const mod = fakeModule(0x400);
    const snap = captureMemory(mod);
    expect(snap.asyncifyFunctions).toEqual([1, 0]);
    const fresh = fakeModule(0x400);
    fresh.Asyncify.callstackFuncToId.clear();
    fresh.Asyncify.callStackIdToFunc.clear();
    fresh.Asyncify.callStackId = 0;
    restoreMemory(fresh, decodeMemory(encodeMemory(snap)));
    expect(fresh.Asyncify.callStackIdToFunc.get(0)).toBe(exportB);
    expect(fresh.Asyncify.callstackFuncToId.get(exportA)).toBe(1);
    expect(fresh.Asyncify.callStackId).toBe(2);
  });

  it('refuses to copy a module that is in the middle of a frame', () => {
    const mod = fakeModule(0x400);
    mod.Asyncify.state = 1;
    expect(() => captureMemory(mod)).toThrow('middle of a frame');
  });

  it('refuses a state taken with the cartridge image somewhere else', () => {
    const mod = fakeModule(0x400);
    const snap = { ...captureMemory(mod), romStart: 0x300 };
    expect(() => restoreMemory(mod, snap)).toThrow('different cartridge image');
  });

  it('round-trips through the byte encoding and rejects other data', () => {
    const mod = fakeModule(0x400);
    mod.HEAPU8.forEach((_, i) => (mod.HEAPU8[i] = i * 7));
    const snap = captureMemory(mod);
    const back = decodeMemory(encodeMemory(snap));
    expect(back.length).toBe(snap.length);
    expect(back.head).toEqual(snap.head);
    expect(back.tail).toEqual(snap.tail);
    expect(() => decodeMemory(new Uint8Array(64))).toThrow('not a saved game state');
    expect(() => decodeMemory(encodeMemory(snap).subarray(0, 100))).toThrow('damaged');
  });
});
