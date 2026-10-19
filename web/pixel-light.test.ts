import { describe, expect, it } from 'vitest';
import { CDisplayListInterpreter } from '../tools/gfx/c-dl.ts';
import { sharedGfxModule } from '../tools/gfx/c-dl-node.ts';
import type { LightSet, TriangleBatch } from '../tools/gfx/types.ts';
import { mergeRuns } from './batching.ts';

/** The per-pixel lighting of web/shader.ts (`PIXEL_LIGHT_GLSL`) in TypeScript, on the normal bytes interpolated at a pixel; 0..1 per channel. */
function pixelLight(n: number[], set: LightSet): number[] {
  const c = [...set.ambient];
  for (let i = 0; i < set.count; i++) {
    const d = Math.min(32767, Math.max(0, 2 * (n[0]! * set.dirs[i * 3]! + n[1]! * set.dirs[i * 3 + 1]! + n[2]! * set.dirs[i * 3 + 2]!)));
    for (let k = 0; k < 3; k++) c[k]! += Math.floor((set.colors[i * 3 + k]! * d) / 32768);
  }
  return c.map((v) => Math.min(255, v) / 255);
}

const bytes = new Uint8Array(0x10000);
const dv = new DataView(bytes.buffer);
const END: [number, number] = [0xdf000000, 0];
const vtx = (n: number, v0: number, addr: number): [number, number] => [0x01000000 | (n << 12) | ((v0 + n) << 1), addr];
const tri = (a: number, b: number, c: number): [number, number] => [0x05000000 | ((a * 2) << 16) | ((b * 2) << 8) | (c * 2), 0];
const list = (addr: number, cmds: [number, number][]) => cmds.forEach(([w0, w1], i) => (dv.setUint32(addr + i * 8, w0 >>> 0), dv.setUint32(addr + i * 8 + 4, w1 >>> 0)));
const vertex = (addr: number, p: number[], n: number[]) => {
  p.forEach((v, i) => dv.setInt16(addr + i * 2, v));
  n.forEach((v, i) => dv.setInt8(addr + 12 + i, v));
  dv.setUint8(addr + 15, 255);
};
const matrix = (addr: number, scale: number) => {
  [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1].forEach((v, i) => {
    const fixed = Math.round(v * 65536);
    dv.setInt16(addr + i * 2, fixed >> 16);
    dv.setUint16(addr + 32 + i * 2, fixed & 0xffff);
  });
};
/** Two lights and the ambient colour, as MOVEMEM loads them (slots 2, 3 and 4). */
const lights = () => {
  bytes.set([200, 100, 50, 0, 200, 100, 50, 0, 20, 90, 100, 0, 0, 0, 0, 0], 0x2800);
  bytes.set([60, 90, 120, 0, 60, 90, 120, 0, 0xec, 0x40, 0xf0, 0, 0, 0, 0, 0], 0x2810);
  bytes.set([20, 30, 40, 0, 20, 30, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0x2820);
};
const LIGHT_SETUP: [number, number][] = [[0xdb020000, 48], [0xdc08060a, 0x2800], [0xdc08090a, 0x2810], [0xdc080c0a, 0x2820]];

const core = await sharedGfxModule();
const interpreter = new CDisplayListInterpreter(core);
function run(mode: number, normals: number[][], positions: number[][], scale: number) {
  lights();
  matrix(0x3000, scale);
  normals.forEach((n, i) => vertex(0x2000 + i * 16, positions[i]!, n));
  list(0x1000, [...LIGHT_SETUP, [0xda380003, 0x3000], [0xd9ffffff, 0x20000], vtx(3, 0, 0x2000), tri(0, 1, 2), END]);
  core._gfx_set_pixel_lighting!(mode);
  try {
    return interpreter.run(bytes, 0x1000);
  } finally {
    core._gfx_set_pixel_lighting!(0);
  }
}
const FACE = [[0, 0, 0], [100, 0, 0], [0, 100, 0]];

describe('per-pixel lighting output', () => {
  it.each([[2, [10, 20, 100]], [0.01, [-60, 70, 80]], [1, [0, 0, 119]], [0.5, [-100, -20, 60]]])(
    'matches the vertex colour within 2/255 where the normal is the same at every vertex (matrix scale %s)', (scale, n) => {
      const vertexMode = run(0, [n!, n!, n!] as number[][], FACE, scale as number).batches[0] as TriangleBatch;
      const r = run(1, [n!, n!, n!] as number[][], FACE, scale as number);
      const b = r.batches[0] as TriangleBatch;
      expect(Array.from(b.normals!.subarray(0, 4))).toEqual([...n!, 1]);
      const pixel = pixelLight(Array.from(b.normals!.subarray(0, 3)), b.lights!);
      for (let k = 0; k < 3; k++) expect(Math.abs(pixel[k]! - vertexMode.colors[k]!) * 255).toBeLessThanOrEqual(2);
      expect(vertexMode.normals).toBeUndefined();
    });

  it('leaves the output out in vertex mode and the vertex colours as they were', () => {
    const n = [10, 20, 100];
    const off = run(0, [n, n, n], FACE, 1);
    expect(off.lighting).toBeUndefined();
    const on = run(1, [n, n, n], FACE, 1);
    expect(Array.from((on.batches[0] as TriangleBatch).colors)).toEqual(Array.from((off.batches[0] as TriangleBatch).colors));
  });

  it('keeps a triangle whose normals point away from its face on the vertex path, and lights it per pixel when asked', () => {
    // The face's normal from the winding is +z; the vertex normals are -z.
    const back = [0, 0, -100];
    const kept = run(1, [back, back, back], [[0, 0, 0], [100, 0, 0], [0, 100, 0]], 1);
    expect(kept.lighting).toEqual({ lit: 1, reversed: 1, mixed: 0, vertexPath: 1 });
    expect((kept.batches[0] as TriangleBatch).normals![3]).toBe(0);
    const all = run(2, [back, back, back], [[0, 0, 0], [100, 0, 0], [0, 100, 0]], 1);
    expect(all.lighting).toEqual({ lit: 1, reversed: 1, mixed: 0, vertexPath: 0 });
    expect((all.batches[0] as TriangleBatch).normals![3]).toBe(1);
    const front = run(1, [[0, 0, 100], [0, 0, 100], [0, 0, 100]], FACE, 1);
    expect(front.lighting).toEqual({ lit: 1, reversed: 0, mixed: 0, vertexPath: 0 });
  });

  it('gives equal light sets one shared set so that their batches merge, and splits runs at another set', () => {
    const n = [10, 20, 100];
    const r = run(1, [n, n, n], FACE, 1);
    const b = r.batches[0] as TriangleBatch;
    const same: TriangleBatch = { ...b, lights: { ...b.lights!, colors: b.lights!.colors.slice() } };
    const other: TriangleBatch = { ...b, lights: { ...b.lights!, ambient: [1, 2, 3] } };
    expect(mergeRuns([b, same]).length).toBe(1);
    expect(mergeRuns([b, other]).length).toBe(2);
  });
});
