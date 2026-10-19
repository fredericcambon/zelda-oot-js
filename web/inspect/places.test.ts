import { describe, expect, it } from 'vitest';
import { exitList } from './exits.ts';
import { buildPlaces, searchPlaces, type TableEntry } from './places.ts';

// Scenes: 1 has a card ("Town"); 2 is a house off it; 3 is a grotto off the house; 4 has no link at all.
function table(): TableEntry[] {
  const rec = (scene: number, spawn: number, n: number) => Array.from({ length: n }, () => ({ scene, spawn }));
  const records = [...rec(1, 0, 4), ...rec(1, 1, 4), ...rec(2, 0, 4), ...rec(3, 0, 2), ...rec(4, 0, 4), ...rec(1, 0, 4), ...rec(200, 0, 4)];
  return records.map((r, entry) => ({ entry, ...r, valid: r.scene < 101 }));
}

const names: Record<number, string> = { 1: 'Town' };
const exits = new Map<number, number[]>([
  [1, [8, 0]],
  [2, [4, 0]],
  [3, [8]],
]);

describe('places', () => {
  const places = buildPlaces(table(), exits, (s) => names[s]);

  it('folds records of one scene and spawn into one row, however many runs name them', () => {
    const town = places.groups.find((g) => g.scene === 1)!;
    expect(town.arrivals.map((a) => a.spawn)).toEqual([0, 1]);
    expect(town.arrivals[0]!.entries).toEqual([0, 1, 2, 3, 18, 19, 20, 21]);
    expect(town.arrivals[0]!.variants.map((v) => v.label)).toEqual(['day', 'night', 'variant 2', 'variant 3']);
    expect(town.arrivals[0]!.others.map((v) => v.entry)).toEqual([18, 19, 20, 21]);
    expect(places.byEntry.get(20)!.arrival).toBe(town.arrivals[0]);
  });

  it('leaves out records that name a scene the game does not have', () => {
    expect(places.byEntry.has(22)).toBe(false);
  });

  it('names a scene by its card, and the others after the scenes they connect to', () => {
    const byScene = new Map(places.groups.map((g) => [g.scene, g]));
    expect(byScene.get(1)).toMatchObject({ name: 'Town', kind: 'card' });
    expect(byScene.get(2)).toMatchObject({ name: 'Off Town', kind: 'derived' });
    expect(byScene.get(3)).toMatchObject({ name: 'Off Town (2)', kind: 'derived' });
    expect(byScene.get(4)).toMatchObject({ name: 'Scene 0x04', kind: 'none' });
    expect(places.named).toEqual({ card: 2, derived: 2, none: 1 });
  });

  it('names an arrival after the scenes whose exit lists lead to it', () => {
    const town = places.groups.find((g) => g.scene === 1)!;
    expect(town.arrivals.map((a) => a.name)).toEqual(['Town - from a place off Town', 'Town - from a place off Town (arrival 1)']);
    expect(places.rows).toBe(5);
  });

  it('tells scenes of one name apart, and finds rows by name or number', () => {
    expect(places.groups.filter((g) => g.name.startsWith('Off Town')).map((g) => g.name)).toEqual(['Off Town', 'Off Town (2)']);
    expect(searchPlaces(places, 'town').length).toBe(3);
    expect(searchPlaces(places, 'zzz')).toEqual([]);
    expect(searchPlaces(places, '0x08')[0]!.scene).toBe(2);
    expect(searchPlaces(places, 'basement', (scene) => (scene === 4 ? 'my basement' : undefined))[0]!.scene).toBe(4);
  });
});

describe('exit lists', () => {
  it('runs to the next pointer of the header and drops what is not an entrance index or is padding at the end', () => {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    [238, 0, 1504, 0, 0, 0xffff, 5].forEach((v, i) => view.setUint16(8 + i * 2, v));
    expect(exitList(bytes, [0x02000000 | 8, 0x02000000 | 20], 8)).toEqual([238, 0, 1504]);
  });
});
