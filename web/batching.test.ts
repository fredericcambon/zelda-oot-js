import { describe, expect, it } from 'vitest';
import { decodeCombine, type Batch, type DrawState, type RectBatch, type TriangleBatch } from '../tools/gfx/types.ts';
import { mergeRuns, rectEnd } from './batching.ts';

const rgba = { r: 0, g: 0, b: 0, a: 0 };
const tile = { fmt: 0, siz: 3, line: 0, tmem: 0, palette: 0, cmT: 0, maskT: 0, shiftT: 0, cmS: 0, maskS: 0, shiftS: 0, uls: 0, ult: 0, lrs: 0, lrt: 0, sized: true };

function state(over: Partial<DrawState> = {}): DrawState {
  return {
    geometryMode: 0, otherModeH: 0, otherModeL: 0, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: { ...rgba }, fogColor: { ...rgba }, blendColor: { ...rgba }, fillColor: 0, texture: { on: true, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [{ ...tile }, { ...tile }], textures: [null, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] },
    scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 }, colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x80100000 }, depthImage: 0,
    ...over,
  };
}

const image = (id: number) => ({ id, width: 1, height: 1, rgba: new Uint8Array(4), tile: 0 });
const tri = (s: DrawState): TriangleBatch => ({ kind: 'triangles', state: s, positions: new Float32Array(12), colors: new Float32Array(12), uvs: new Float32Array(6) });
const rect = (s: DrawState, kind: RectBatch['kind'] = 'texrect'): RectBatch => ({ kind, state: s, xl: 0, yl: 0, xh: 0, yh: 0, tile: 0, s: 0, t: 0, dsdx: 0, dtdy: 0 });
const sizes = (batches: Batch[]) => mergeRuns(batches).map((r) => (r.kind === 'fill' ? 'fill' : r.batches.length));

describe('mergeRuns', () => {
  it('merges consecutive batches with equal state, whether they share the object or not', () => {
    const a = state();
    expect(sizes([tri(a), tri(a), tri(state()), tri(state({ primColor: { ...rgba, minLod: 0, lodFrac: 0 } }))])).toEqual([4]);
  });

  it('keeps the order of the batches inside a run', () => {
    const batches = [tri(state()), tri(state()), tri(state())];
    const [run] = mergeRuns(batches);
    expect(run!.kind === 'draw' && run!.batches).toEqual(batches);
  });

  it.each([
    ['colour', { primColor: { ...rgba, r: 1, minLod: 0, lodFrac: 0 } }],
    ['texture', { textures: [image(1), null] as DrawState['textures'] }],
    ['render mode', { otherModeL: 0x20 }],
    ['geometry mode', { geometryMode: 1 }],
    ['scissor', { scissor: { mode: 0, xh: 0, yh: 0, xl: 40, yl: 40 } }],
    ['viewport', { viewport: { scale: [1, 1, 0], trans: [0, 0, 0] } as DrawState['viewport'] }],
    ['colour image', { colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x80200000 } }],
  ])('splits at a change of %s', (_, over) => {
    expect(sizes([tri(state()), tri(state(over)), tri(state())])).toEqual([1, 1, 1]);
  });

  it('merges batches with the same texture id and tile placement, splits on another id or tile', () => {
    const t = (id: number, uls = 0) => state({ textures: [image(id), null], tiles: [{ ...tile, uls }, { ...tile }] });
    expect(sizes([tri(t(7)), tri(t(7)), tri(t(8)), tri(t(8, 4))])).toEqual([2, 1, 1]);
  });

  it('does not merge triangles with rectangles', () => {
    expect(sizes([tri(state()), rect(state()), rect(state()), tri(state())])).toEqual([1, 2, 1]);
  });

  it('ends a run at a fill rectangle and keeps the fill in place', () => {
    const fill = rect(state({ otherModeH: 3 << 20 }), 'fillrect');
    expect(sizes([tri(state()), fill, tri(state())])).toEqual([1, 'fill', 1]);
  });

  it('skips empty triangle batches without ending a run', () => {
    const empty: TriangleBatch = { ...tri(state()), positions: new Float32Array(0) };
    expect(sizes([tri(state()), empty, tri(state())])).toEqual([2]);
  });
});

describe('rectEnd', () => {
  const at = (mode: number, kind: RectBatch['kind'], xl: number, yl: number): RectBatch => ({ ...rect(state({ otherModeH: mode << 20 }), kind), xl, yl });

  it('includes the corner pixel in copy and fill mode', () => {
    expect(rectEnd(at(2, 'texrect', 1276, 956), 320, 240)).toEqual([320, 240]);
    expect(rectEnd(at(3, 'fillrect', 100, 60), 320, 240)).toEqual([26, 16]);
  });

  it('leaves the corner pixel out of a texture rectangle in one-cycle mode', () => {
    expect(rectEnd(at(0, 'texrect', 1276, 956), 320, 240)).toEqual([319, 239]);
  });

  it('extends a one-cycle fill rectangle that ends on the last pixel of the screen, and no other', () => {
    expect(rectEnd(at(0, 'fillrect', 1276, 956), 320, 240)).toEqual([320, 240]);
    expect(rectEnd(at(1, 'fillrect', 1276, 124), 320, 240)).toEqual([320, 31]);
    expect(rectEnd(at(0, 'fillrect', 1280, 960), 320, 240)).toEqual([320, 240]);
    expect(rectEnd(at(0, 'fillrect', 400, 200), 320, 240)).toEqual([100, 50]);
  });
});
