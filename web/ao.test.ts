import { describe, expect, it } from 'vitest';
import { decodeCombine, type DrawState, type TriangleBatch } from '../tools/gfx/types.ts';
import { Geo } from '../tools/gfx/opcodes.ts';
import { distanceOf, fitProjection } from './ao.ts';
import { OtherL } from './shader.ts';

const rgba = { r: 0, g: 0, b: 0, a: 0 };

const state = (over: Partial<DrawState> = {}): DrawState => ({
  geometryMode: Geo.ZBUFFER, otherModeH: 0, otherModeL: OtherL.Z_COMPARE | OtherL.Z_UPDATE, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
  envColor: { ...rgba }, fogColor: { ...rgba }, blendColor: { ...rgba }, fillColor: 0, texture: { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
  tiles: [], textures: [null, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] }, scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 },
  colorImage: { fmt: 0, siz: 2, width: 320, addr: 0 }, depthImage: 0, ...over,
});

/** Triangles at the distances `ws` in front of a perspective projection with clip planes at `near` and `far`: the clip-space z is affine in w, as in the display lists. */
const batch = (ws: number[], near: number, far: number, over: Partial<DrawState> = {}): TriangleBatch => {
  const a = -(far + near) / (far - near), b = -(2 * far * near) / (far - near);
  const positions = new Float32Array(ws.length * 4);
  ws.forEach((w, i) => positions.set([i * 7, i * 3, -a * w + b, w], i * 4));
  return { kind: 'triangles', state: state(over), positions, colors: new Float32Array(ws.length * 4), uvs: new Float32Array(ws.length * 2) };
};

describe('fitProjection', () => {
  it('recovers the distance of a depth value under a perspective projection', () => {
    const fit = fitProjection([batch([30, 120, 400, 900, 2500], 20, 3000)])!;
    for (const w of [25, 60, 800, 2900]) {
      const depth = ((-(3000 + 20) / (3000 - 20)) * -1 + (-(2 * 3000 * 20) / (3000 - 20)) / w + 1) / 2;
      expect(distanceOf(depth, fit)).toBeCloseTo(w, 1);
    }
  });

  it('takes the projection that most of the vertices were drawn under', () => {
    const world = batch([30, 90, 400, 2000, 2500, 100], 20, 3000);
    const hands = batch([5, 9, 12], 1, 40);
    const fit = fitProjection([hands, world, batch([50, 700], 20, 3000)])!;
    expect(distanceOf(0.5, fit)).toBeCloseTo(distanceOf(0.5, fitProjection([world])!), 3);
  });

  it('ignores draws without the depth buffer, orthographic draws and vertices behind the eye', () => {
    expect(fitProjection([batch([30, 400], 20, 3000, { geometryMode: 0 })])).toBeNull();
    expect(fitProjection([batch([30, 400], 20, 3000, { otherModeL: 0 })])).toBeNull();
    expect(fitProjection([batch([100, 100, 100], 20, 3000)])).toBeNull();
    expect(fitProjection([batch([-5, -300, 30, 40], 20, 3000)])).not.toBeNull();
  });
});
