import { describe, expect, it } from 'vitest';
import { buildIdOf, buildMismatch, compress, decompress, SaveStates, SLOT_COUNT, type StateRecord, type StateSource, type StateStore } from './savestate.ts';

function memoryStore(): StateStore & { records: Map<number, StateRecord> } {
  const records = new Map<number, StateRecord>();
  return { records, get: async (slot) => records.get(slot) ?? null, put: async (slot, record) => void records.set(slot, record) };
}

function fakeGame(): StateSource & { value: number } {
  const g = {
    value: 0,
    capture: async () => new Uint8Array([g.value]),
    apply: async (data: Uint8Array) => void (g.value = data[0]!),
  };
  return g;
}

describe('SaveStates', () => {
  it('reports an empty slot', async () => {
    const states = new SaveStates(fakeGame(), memoryStore(), 'a');
    expect(await states.load()).toBe('Slot 1 empty');
  });

  it('restores what a slot holds and keeps the slots apart', async () => {
    const game = fakeGame();
    const states = new SaveStates(game, memoryStore(), 'a');
    game.value = 7;
    expect(await states.save()).toBe('Saved slot 1');
    expect(await states.select(1)).toBe('Slot 2 (empty)');
    game.value = 9;
    await states.save();
    game.value = 0;
    expect(await states.load()).toBe('Loaded slot 2');
    expect(game.value).toBe(9);
    await states.select(-1);
    expect(await states.load()).toBe('Loaded slot 1');
    expect(game.value).toBe(7);
  });

  it('wraps around the four slots', async () => {
    const states = new SaveStates(fakeGame(), memoryStore(), 'a');
    await states.select(-1);
    expect(states.slot).toBe(SLOT_COUNT);
    await states.select(1);
    expect(states.slot).toBe(1);
  });

  it('refuses a state from another build and leaves the game alone', async () => {
    const game = fakeGame();
    const store = memoryStore();
    game.value = 5;
    await new SaveStates(game, store, 'old').save();
    game.value = 6;
    const message = await new SaveStates(game, store, 'new').load();
    expect(message).toBe('Slot 1 was saved by another build of the game and cannot be loaded');
    expect(game.value).toBe(6);
  });
});

describe('buildMismatch', () => {
  it('accepts the same build only', () => {
    const record: StateRecord = { build: 'x', savedAt: 0, data: new Uint8Array() };
    expect(buildMismatch(record, 'x', 3)).toBeNull();
    expect(buildMismatch(record, 'y', 3)).toContain('Slot 3');
  });
});

describe('compression and build ids', () => {
  it('round-trips bytes', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i % 251 === 0 ? i & 255 : 0));
    const packed = await compress(bytes);
    expect(packed.length).toBeLessThan(bytes.length / 10);
    expect(await decompress(packed)).toEqual(bytes);
  });

  it('hashes a file to a hex SHA-256', async () => {
    const id = await buildIdOf(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(id).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
