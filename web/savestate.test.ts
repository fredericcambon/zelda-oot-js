import { describe, expect, it } from 'vitest';
import { compress, decompress, formatMismatch, modeMismatch, OLD_FORMAT, SaveStates, SLOT_COUNT, type StateRecord, type StateSource, type StateStore } from './savestate.ts';

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
    const states = new SaveStates(fakeGame(), memoryStore(), 1);
    expect(await states.load()).toBe('Slot 1 empty');
  });

  it('restores what a slot holds and keeps the slots apart', async () => {
    const game = fakeGame();
    const states = new SaveStates(game, memoryStore(), 1);
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
    const states = new SaveStates(fakeGame(), memoryStore(), 1);
    await states.select(-1);
    expect(states.slot).toBe(SLOT_COUNT);
    await states.select(1);
    expect(states.slot).toBe(1);
  });

  it('refuses a state of another format version and leaves the game alone', async () => {
    const game = fakeGame();
    const store = memoryStore();
    game.value = 5;
    await new SaveStates(game, store, 2).save();
    game.value = 6;
    expect(await new SaveStates(game, store, 1).load()).toBe('Slot 1 uses state format 2, this build reads 1');
    expect(game.value).toBe(6);
  });

  it('reports a state of the old format and keeps it', async () => {
    const game = fakeGame();
    const store = memoryStore();
    store.records.set(1, { format: OLD_FORMAT, savedAt: 0, data: new Uint8Array([8]) });
    game.value = 6;
    expect(await new SaveStates(game, store, 1).load()).toBe('Slot 1 was saved in the old format and cannot be loaded');
    expect(game.value).toBe(6);
    expect(store.records.get(1)?.data).toEqual(new Uint8Array([8]));
  });

  it('reports the reason when the game refuses a state', async () => {
    const game = fakeGame();
    game.apply = async () => { throw new Error('function 0x80001234 is not in this build'); };
    const store = memoryStore();
    await new SaveStates(game, store, 1).save();
    expect(await new SaveStates(game, store, 1).load()).toBe('Slot 1 cannot be loaded: function 0x80001234 is not in this build');
  });
});

describe('video rate of a state', () => {
  it('is recorded with the state', async () => {
    const store = memoryStore();
    await new SaveStates(fakeGame(), store, 1, 60).save();
    expect(store.records.get(1)?.hz).toBe(60);
    await new SaveStates(fakeGame(), store, 1).save();
    expect(store.records.get(1)?.hz).toBe(50);
  });

  it('must match the mode the game was booted in, and the game is left alone otherwise', async () => {
    const game = fakeGame();
    const store = memoryStore();
    game.value = 5;
    await new SaveStates(game, store, 1, 60).save();
    game.value = 6;
    expect(await new SaveStates(game, store, 1, 50).load()).toBe('Slot 1 was saved in 60 Hz mode; switch the mode and reload the page to load it');
    expect(game.value).toBe(6);
    expect(await new SaveStates(game, store, 1, 60).load()).toBe('Loaded slot 1');
    expect(game.value).toBe(5);
  });

  it('treats a state without a rate as a 50 Hz one', () => {
    const old: StateRecord = { format: 1, savedAt: 0, data: new Uint8Array() };
    expect(modeMismatch(old, 50, 1)).toBeNull();
    expect(modeMismatch(old, 60, 1)).toContain('50 Hz');
  });
});

describe('formatMismatch', () => {
  it('accepts the readable version only', () => {
    const record: StateRecord = { format: 1, savedAt: 0, data: new Uint8Array() };
    expect(formatMismatch(record, 1, 3)).toBeNull();
    expect(formatMismatch(record, 2, 3)).toContain('Slot 3');
    expect(formatMismatch({ ...record, format: OLD_FORMAT }, 1, 3)).toContain('old format');
  });
});

describe('compression', () => {
  it('round-trips bytes', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i % 251 === 0 ? i & 255 : 0));
    const packed = await compress(bytes);
    expect(packed.length).toBeLessThan(bytes.length / 10);
    expect(await decompress(packed)).toEqual(bytes);
  });

});
