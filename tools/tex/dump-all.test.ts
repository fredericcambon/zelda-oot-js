import { describe, expect, it } from 'vitest';
import type { TextureRecord } from './collect.ts';
import { mergeVisits, plannedEntrances, visitKey, type VisitFile } from './dump-all.ts';

const record = (hash: string, over: Partial<TextureRecord> = {}): TextureRecord => ({
  hash, width: 2, height: 1, fmt: 0, siz: 2, edgeS: 'clamp', edgeT: 'clamp', alpha: 'opaque', gray: false, frames: 1, first: 1, last: 1, scenes: [1],
  tile: {} as TextureRecord['tile'], reach: [0, 0, 1, 1], unloaded: 0, pictures: 1, volatile: false, ...over,
});
const visit = (scene: number, age: 'child' | 'adult', records: TextureRecord[], groups = [{ group: '2x1:0.2', present: 1, withNew: 0 }]): VisitFile => ({
  key: visitKey(scene, 0, age, 'day'), entrance: 0, scene, spawn: 0, age, time: 'day', status: 'ok', sceneAtCheck: scene, sceneAtEnd: scene, frames: 10, tasks: 10, records, groups,
});

describe('mergeVisits', () => {
  it('adds frames and unions scenes, ages, edges and reach', () => {
    const { textures } = mergeVisits([
      visit(1, 'child', [record('a', { frames: 3, edgeS: 'mirror', reach: [0, 0, 1, 1] })]),
      visit(2, 'adult', [record('a', { frames: 4, edgeS: 'wrap', scenes: [2], reach: [-1, 0, 2, 3] })]),
    ]);
    expect(textures).toHaveLength(1);
    expect(textures[0]).toMatchObject({ frames: 7, edgeS: 'wrap', scenes: [1, 2], ages: ['child', 'adult'], times: ['day'], reach: [-1, 0, 2, 3] });
  });

  it('applies the churn rule to the groups of all visits together', () => {
    const churn = { group: '2x1:0.2', present: 15, withNew: 15 };
    const { textures, churningGroups } = mergeVisits([
      visit(1, 'child', [record('short', { frames: 2 }), record('long', { frames: 9 })], [churn]),
      visit(2, 'child', [], [churn]),
    ]);
    expect(churningGroups).toHaveLength(1);
    expect(textures.find((t) => t.hash === 'short')!.volatile).toBe(true);
    expect(textures.find((t) => t.hash === 'long')!.volatile).toBe(false);
  });
});

describe('plannedEntrances', () => {
  it('keeps the first entry of each scene and spawn and lists the entries without a scene', () => {
    const table = [{ scene: 5, spawn: 0 }, { scene: 5, spawn: 0 }, { scene: 5, spawn: 1 }, { scene: 99, spawn: 0 }];
    expect(plannedEntrances(table, 10)).toEqual({ chosen: [{ entrance: 0, scene: 5, spawn: 0 }, { entrance: 2, scene: 5, spawn: 1 }], invalid: [3] });
    expect(plannedEntrances(table, 10, [1, 2]).chosen.map((c) => c.entrance)).toEqual([1, 2]);
  });
});
