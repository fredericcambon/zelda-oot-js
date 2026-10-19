import { describe, expect, it } from 'vitest';
import { defaultSettings } from './gfx-settings.ts';
import { eyeOf, flicker, frameCamera, invert4, gameLights, LIGHT_NODES, pickLights, reconstruct } from './point-lights.ts';
import { MAX_POINT_LIGHTS, POINT_LIGHT_GLSL } from './shader.ts';

// A perspective projection with a view matrix multiplied in, as the game leaves it (row vectors): a camera at (100, 200, 300) looking along -z.
const camera = (): Float64Array => {
  const f = 1.5, near = 10, far = 3000;
  const m = new Float64Array(16);
  // view: translate by -eye (rotation identity), then projection
  m[0] = f; m[5] = f; m[10] = -(far + near) / (far - near); m[11] = -1; m[14] = -(2 * far * near) / (far - near);
  const view = [-100, -200, -300];
  // row-vector product: translation row (view) times the projection
  for (let c = 0; c < 4; c++) m[12 + c] = view[0]! * m[c]! + view[1]! * m[4 + c]! + view[2]! * m[8 + c]! + m[12 + c]!;
  return m;
};

const project = (m: ArrayLike<number>, p: [number, number, number]) => [0, 1, 2, 3].map((c) => p[0] * m[c]! + p[1] * m[4 + c]! + p[2] * m[8 + c]! + m[12 + c]!);

describe('point lights', () => {
  it('inverts a matrix', () => {
    const m = camera(), inv = invert4(m)!;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += m[r * 4 + k]! * inv[k * 4 + c]!;
      expect(sum).toBeCloseTo(r === c ? 1 : 0, 6);
    }
    expect(invert4(new Float64Array(16))).toBeNull();
  });

  it('finds the eye', () => {
    const eye = eyeOf(invert4(camera())!);
    expect(eye[0]).toBeCloseTo(100, 4);
    expect(eye[1]).toBeCloseTo(200, 4);
    expect(eye[2]).toBeCloseTo(300, 4);
  });

  it('gives back the world position of a fragment from its window position, depth and 1 / w', () => {
    const m = camera(), inv = invert4(m)!;
    const viewport = [-40, 12, 1280, 960] as const, xyScale = 0.5;
    const world: [number, number, number] = [130, 180, -250];
    const c = project(m, world);
    const w = c[3]!;
    // What the rasteriser hands the fragment shader: the vertex shader scales x and y by xyScale; depth is z / w mapped to 0..1.
    const ndcX = (c[0]! * xyScale) / w, ndcY = (c[1]! * xyScale) / w;
    const fragX = viewport[0] + (ndcX * 0.5 + 0.5) * viewport[2], fragY = viewport[1] + (ndcY * 0.5 + 0.5) * viewport[3];
    const out = reconstruct(inv, viewport, xyScale, fragX, fragY, (c[2]! / w) * 0.5 + 0.5, 1 / w);
    expect(out[0]).toBeCloseTo(world[0], 2);
    expect(out[1]).toBeCloseTo(world[1], 2);
    expect(out[2]).toBeCloseTo(world[2], 2);
  });

  it('picks the nearest lights to the eye and the camera with most vertices', () => {
    const m = camera();
    const cam = frameCamera([{ vertices: 10, matrix: new Float64Array(16).fill(1) }, { vertices: 500, matrix: m }])!;
    expect(cam.slot).toBe(2);
    const sources = Array.from({ length: 12 }, (_, i) => ({ x: 100, y: 200, z: 300 - 50 * (i + 1) }));
    sources.push({ x: 100, y: 200, z: 340 });
    const picked = pickLights(sources, cam);
    expect(picked).toHaveLength(MAX_POINT_LIGHTS);
    expect(picked.some((p) => p.z === 250)).toBe(true);
    expect(picked.some((p) => p.z === 340)).toBe(false);
    expect(frameCamera([])).toBeNull();
  });

  it('flickers within a narrow band', () => {
    for (let i = 0; i < 8; i++) for (let t = 0; t < 20; t += 0.1) expect(Math.abs(flicker(i, t) - 1)).toBeLessThanOrEqual(0.15);
  });

  it('is off by default, with a strength of 50', () => {
    const s = defaultSettings(false);
    expect(s.pointLights).toBe(false);
    expect(s.pointLightStrength).toBe(50);
    expect(POINT_LIGHT_GLSL).toContain('uPointCount');
  });

  it('reads the burning point lights of the game registry and skips the others', () => {
    const words = new Map<number, number>();
    const info = (at: number, type: number, x: number, y: number, z: number, rgb: number, radius: number) => {
      words.set(at, ((type << 24) | (x & 0xffff)) >>> 0);
      words.set(at + 4, (((y & 0xffff) << 16) | (z & 0xffff)) >>> 0);
      words.set(at + 8, (rgb << 8) >>> 0);
      words.set(at + 12, ((radius & 0xffff) << 16) >>> 0);
    };
    const node = (i: number, at: number) => words.set(LIGHT_NODES + i * 12, at);
    info(0x801e0000, 2, -105, 300, -145, 0x987700, 200);
    info(0x801e0010, 2, 10, 20, 30, 0x000000, -1);
    info(0x801e0020, 2, 10, 20, 30, 0xffffff, 200);
    info(0x801e0030, 0, 10, 20, 30, 0x987700, 200);
    [0x801e0000, 0x801e0010, 0x801e0020, 0x801e0030].forEach((at, i) => node(i + 3, at));
    const lights = gameLights((addr) => words.get(addr) ?? 0);
    expect(lights).toHaveLength(1);
    expect(lights[0]).toMatchObject({ x: -105, y: 300, z: -145 });
    expect(lights[0]!.level).toBeGreaterThan(0.6);
  });
});
