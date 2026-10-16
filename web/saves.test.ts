import { describe, expect, it } from 'vitest';
import { SaveSync, type SaveMemory, type SaveStore } from './saves.ts';

function memoryStore(): SaveStore & { writes: number } {
  const s = {
    value: null as Uint8Array | null,
    writes: 0,
    load: async () => (s.value ? s.value.slice() : null),
    store: async (b: Uint8Array) => {
      s.value = b.slice();
      s.writes++;
    },
  };
  return s;
}

function fakeGame(size = 8): SaveMemory & { ram: Uint8Array; dirty: boolean } {
  const g = {
    ram: new Uint8Array(size),
    dirty: false,
    write(b: Uint8Array) {
      g.ram.set(b);
    },
    takeIfDirty() {
      const d = g.dirty;
      g.dirty = false;
      return d ? g.ram.slice() : null;
    },
  };
  return g;
}

describe('SaveSync', () => {
  it('restores nothing when no save exists', async () => {
    const game = fakeGame();
    expect(await new SaveSync(game, memoryStore()).restore()).toBe(false);
    expect([...game.ram]).toEqual(new Array(8).fill(0));
  });

  it('keeps a save across a reload', async () => {
    const store = memoryStore();
    const first = fakeGame();
    const sync = new SaveSync(first, store);
    first.ram.set([1, 2, 3]);
    first.dirty = true;
    await sync.flush();

    const second = fakeGame();
    expect(await new SaveSync(second, store).restore()).toBe(true);
    expect([...second.ram.subarray(0, 4)]).toEqual([1, 2, 3, 0]);
  });

  it('writes only when the game wrote the memory', async () => {
    const store = memoryStore();
    const game = fakeGame();
    const sync = new SaveSync(game, store);
    await sync.flush();
    expect(store.writes).toBe(0);
    game.dirty = true;
    await sync.flush();
    await sync.flush();
    expect(store.writes).toBe(1);
  });

  it('keeps saving after a failed write', async () => {
    const store = memoryStore();
    const realStore = store.store;
    let failNext = true;
    store.store = async (b) => {
      if (failNext) {
        failNext = false;
        throw new Error('quota');
      }
      await realStore(b);
    };
    const game = fakeGame();
    const sync = new SaveSync(game, store);
    game.dirty = true;
    await expect(sync.flush()).rejects.toThrow('quota');
    game.dirty = true;
    await sync.flush();
    expect(store.writes).toBe(1);
    await expect(sync.flush()).resolves.toBeUndefined();
  });
});
