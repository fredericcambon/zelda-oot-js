import { describe, expect, it } from 'vitest';
import { guestRam } from '../../tools/headless/load-save.ts';
import { ENTRANCE_COUNT, ENTRANCE_INDEX, ENTRANCE_TABLE, SCENE_RECORD_SIZE, SCENE_TABLE, SETUP_VARIANT, setupVariantFor } from '../../tools/headless/state.ts';
import { Bridge } from './bridge.ts';
import { Refused } from './queue.ts';
import { entranceName, loadBookmarks, thumbUrl, loadSceneLabels, readEntrances, readLive, saveBookmarks, saveSceneLabels, search, warpTo } from './warp.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const CONTEXT = 0x80300000;

function world() {
  const bytes = new Uint8Array(0x800000);
  const mem = guestRam(bytes);
  mem.write32(ENTRANCE_TABLE + 5 * 4, 0x55 << 24 | 3 << 16);
  mem.write32(ENTRANCE_TABLE + 6 * 4, 0xf0 << 24);
  mem.write32(0x80112be0, CONTEXT);
  mem.write32(CONTEXT + 0xa4, 0x55 << 16);
  mem.write32(CONTEXT + 0x1242c, SCENE_TABLE + 0x55 * SCENE_RECORD_SIZE);
  mem.write32(ENTRANCE_INDEX, 3);
  mem.write32(SETUP_VARIANT, 2);
  return { mem, bridge: new Bridge(() => bytes, () => undefined) };
}

describe('entrances', () => {
  it('reads the scene and spawn, and flags scenes past the table', () => {
    const rows = readEntrances(world().mem);
    expect(rows).toHaveLength(ENTRANCE_COUNT);
    expect(rows[5]).toEqual({ entry: 5, scene: 0x55, spawn: 3, flags: 0, valid: true });
    expect(rows[6]!.valid).toBe(false);
  });

  it('searches by scene or entrance number, decimal or hex', () => {
    const rows = readEntrances(world().mem);
    expect(search(rows, '0x55').map((r) => r.entry)).toEqual([5, 0x55]);
    expect(search(rows, '85').map((r) => r.entry)).toEqual([5, 85]);
    expect(search(rows, '5').map((r) => r.entry)).toContain(5);
    expect(search(rows, 'zzz')).toEqual([]);
    expect(search(rows, '')).toHaveLength(ENTRANCE_COUNT);
  });

  it('names the picture file of an entrance by its number, four digits', () => {
    expect(thumbUrl(238)).toBe('/warp-thumbs/0238.png');
  });

  it('names an entrance by its numbers only', () => {
    expect(entranceName(0x55, 0xee)).toBe('scene 0x55 / entrance 0x0EE');
  });
});

describe('live state', () => {
  it('gives the scene and the entry it was loaded from', () => {
    expect(readLive(world().mem)).toMatchObject({ scene: 0x55, entry: 5, language: 0 });
  });

  it('has no entry when the table names another scene for it', () => {
    const { mem } = world();
    mem.write32(ENTRANCE_INDEX, 9);
    expect(readLive(mem)?.entry).toBeNull();
  });

  it('is null outside a scene', () => {
    expect(readLive(guestRam(new Uint8Array(0x800000)))).toBeNull();
  });
});

describe('warpTo', () => {
  it('ends the play state into the entry', () => {
    const { mem, bridge } = world();
    expect(warpTo(bridge, 5)).toBe('Warping to scene 0x55 / entrance 0x005');
    expect(mem.rd32(CONTEXT + 0x98)).toBe(0);
    expect(mem.rd32(ENTRANCE_INDEX) + setupVariantFor((a) => mem.rd32(a))).toBe(5);
  });

  it('refuses a bad entry, a scene past the table and an unsafe state', () => {
    const { bridge } = world();
    expect(() => warpTo(bridge, ENTRANCE_COUNT)).toThrow(Refused);
    expect(() => warpTo(bridge, 6)).toThrow(/does not have/);
    const unsafe = new Bridge(() => new Uint8Array(0x800000), () => 'a scene transition is in progress');
    expect(() => warpTo(unsafe, 5)).toThrow('Not now: a scene transition is in progress');
  });
});

describe('stored lists', () => {
  it('keeps bookmarks and scene labels across loads and drops damaged entries', () => {
    const store = memory();
    saveBookmarks([{ label: 'home', entry: 5, scene: 0x55 }], store);
    expect(loadBookmarks(store)).toEqual([{ label: 'home', entry: 5, scene: 0x55 }]);
    saveSceneLabels({ 85: 'mine' }, store);
    expect(loadSceneLabels(store)).toEqual({ 85: 'mine' });
    store.setItem('zelda-oot-js:bookmarks', JSON.stringify([{ label: 1 }, { label: 'x', entry: 99999, scene: 1 }]));
    expect(loadBookmarks(store)).toEqual([]);
    store.setItem('zelda-oot-js:bookmarks', '{bad');
    expect(loadBookmarks(store)).toEqual([]);
  });
});
