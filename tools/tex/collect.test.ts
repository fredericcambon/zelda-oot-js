import { describe, expect, it } from 'vitest';
import type { DisplayListResult, DrawState } from '../gfx/types.ts';
import { alphaKindOf, edgeOf, isGray, TextureCollector } from './collect.ts';

const tile = { fmt: 0, siz: 2, maskS: 5, maskT: 5, cmS: 0, cmT: 1, shiftS: 0, shiftT: 0, uls: 0, ult: 0 };
function stateOf(id: number, texels: number[], t = tile): DrawState {
  const rgba = Uint8Array.from(texels);
  return { textures: [{ id, width: 2, height: 1, rgba, tile: 0 }, null], tiles: [t] } as unknown as DrawState;
}
const resultOf = (state: DrawState): DisplayListResult => ({ batches: [{ kind: 'triangles', state, uvs: Float32Array.of(0, 0, 2, 1) }] }) as unknown as DisplayListResult;

describe('texture facts', () => {
  it('edgeOf follows the mask and the clamp and mirror bits', () => {
    expect(edgeOf(0, 0)).toBe('clamp');
    expect(edgeOf(5, 0)).toBe('wrap');
    expect(edgeOf(5, 1)).toBe('mirror');
    expect(edgeOf(5, 2)).toBe('clamp');
    expect(edgeOf(5, 3)).toBe('clamp');
  });

  it('alphaKindOf tells opaque, cut-out and blended alpha apart', () => {
    expect(alphaKindOf(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 255))).toBe('opaque');
    expect(alphaKindOf(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 0))).toBe('binary');
    expect(alphaKindOf(Uint8Array.of(1, 2, 3, 255, 4, 5, 6, 77))).toBe('blend');
  });

  it('isGray ignores transparent texels', () => {
    expect(isGray(Uint8Array.of(9, 9, 9, 255, 1, 2, 3, 0))).toBe(true);
    expect(isGray(Uint8Array.of(9, 9, 9, 255, 1, 2, 3, 255))).toBe(false);
  });
});

describe('TextureCollector', () => {
  it('names equal pixels once and unions how tiles wrap them', () => {
    const c = new TextureCollector();
    c.nextFrame(85);
    c.add(resultOf(stateOf(1, [1, 2, 3, 255, 4, 5, 6, 255])));
    c.nextFrame(85);
    c.add(resultOf(stateOf(2, [1, 2, 3, 255, 4, 5, 6, 255], { ...tile, cmS: 1, cmT: 0 })));
    const { records, pixels } = c.finish();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ frames: 2, first: 1, last: 2, scenes: [85], edgeS: 'wrap', edgeT: 'wrap', alpha: 'opaque', volatile: false, family: null, reach: [0, 0, 2, 1] });
    expect(pixels.get(records[0]!.hash)).toHaveLength(8);
  });

  it('flags short-lived pixels of a group that is new in most frames, and only those', () => {
    const c = new TextureCollector();
    for (let f = 0; f < 40; f++) {
      c.nextFrame(1);
      c.add(resultOf(stateOf(1000 + f, [f, 0, 0, 255, 0, 0, 0, 255])));
      c.add(resultOf(stateOf(7, [9, 9, 9, 255, 9, 9, 9, 255], { ...tile, fmt: 3 })));
    }
    const { records, churningGroups } = c.finish();
    expect(churningGroups.map((g) => g.group)).toEqual(['2x1:0.2']);
    expect(records.filter((r) => r.volatile)).toHaveLength(40);
    expect(records.find((r) => r.fmt === 3)).toMatchObject({ volatile: false, frames: 40 });
  });

  it('gives textures that differ only in their upper half a shared key', () => {
    const c = new TextureCollector();
    c.nextFrame(1);
    for (let k = 0; k < 3; k++) {
      const rgba = Uint8Array.from({ length: 2 * 4 * 4 }, (_, i) => (i < 16 ? k : 9));
      const state = { textures: [{ id: k + 1, width: 2, height: 4, rgba, tile: 0 }, null], tiles: [tile] } as unknown as DrawState;
      c.add(resultOf(state));
    }
    const { records } = c.finish();
    expect(new Set(records.map((r) => r.family)).size).toBe(1);
    expect(records[0]!.family).not.toBeNull();
  });
});
