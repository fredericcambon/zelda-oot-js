import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { CDisplayListInterpreter, loadGfxModule } from './c-dl.ts';
import { DisplayListInterpreter, decodeCombine, type DisplayListResult, type TriangleBatch } from './dl.ts';
import { Op } from './opcodes.ts';
import { SoftRenderer } from './raster.ts';

class Ram {
  readonly bytes = new Uint8Array(0x100000);
  readonly dv = new DataView(this.bytes.buffer);
  /** A command list at `addr`: pairs of words. */
  list(addr: number, ...cmds: [number, number][]): void {
    let a = addr;
    for (const [w0, w1] of cmds) {
      this.dv.setUint32(a, w0 >>> 0);
      this.dv.setUint32(a + 4, w1 >>> 0);
      a += 8;
    }
  }
  vertex(addr: number, x: number, y: number, z: number, s: number, t: number, rgba: [number, number, number, number]): void {
    this.dv.setInt16(addr, x);
    this.dv.setInt16(addr + 2, y);
    this.dv.setInt16(addr + 4, z);
    this.dv.setInt16(addr + 8, s);
    this.dv.setInt16(addr + 10, t);
    this.bytes.set(rgba, addr + 12);
  }
  triangleVertices(addr: number, color: [number, number, number, number] = [0, 0, 0, 255]): void {
    for (let i = 0; i < 3; i++) this.vertex(addr + i * 16, i, 0, 0, 0, 0, color);
  }
  /** A matrix in the fixed-point layout: sixteen integer parts, then sixteen fractions. */
  matrix(addr: number, m: number[]): void {
    m.forEach((v, i) => {
      const fixed = Math.round(v * 65536);
      this.dv.setInt16(addr + i * 2, fixed >> 16);
      this.dv.setUint16(addr + 32 + i * 2, fixed & 0xffff);
    });
  }
}

const END: [number, number] = [0xdf000000, 0];
const vtx = (n: number, v0: number, addr: number): [number, number] => [0x01000000 | (n << 12) | ((v0 + n) << 1), addr];
const tri = (a: number, b: number, c: number): [number, number] => [0x05000000 | ((a * 2) << 16) | ((b * 2) << 8) | (c * 2), 0];
type Run = (ram: Ram, at: number) => DisplayListResult;
// Every case runs against the TypeScript interpreter and the one in the wasm module.
const cInterpreter = new CDisplayListInterpreter(await loadGfxModule(ensureToolchain(), resolve('out', 'gfx-test')));
const IMPLEMENTATIONS: [string, Run][] = [
  ['TypeScript', (ram, at) => new DisplayListInterpreter().run(ram.bytes, at)],
  ['C', (ram, at) => cInterpreter.run(ram.bytes, at)],
];
const trianglesIn = (batches: { kind: string }[]) =>
  (batches as TriangleBatch[]).reduce((n, b) => n + (b.kind === 'triangles' ? b.positions.length / 12 : 0), 0);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe.each(IMPLEMENTATIONS)('display list interpreter (%s)', (_name, run) => {
  it('draws a triangle from loaded vertices', () => {
    const ram = new Ram();
    ram.vertex(0x2000, 1, 0, 0, 32, 64, [255, 0, 0, 255]);
    ram.vertex(0x2010, 0, 1, 0, 0, 0, [0, 255, 0, 128]);
    ram.vertex(0x2020, 0, 0, 1, 0, 0, [0, 0, 255, 255]);
    ram.list(0x1000, vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const r = run(ram, 0x1000);
    expect(r.unknown).toEqual([]);
    expect(r.problems).toEqual([]);
    const b = r.batches[0] as TriangleBatch;
    expect(Array.from(b.positions.subarray(0, 8))).toEqual([1, 0, 0, 1, 0, 1, 0, 1]);
    expect(Array.from(b.colors.subarray(4, 8)).map((v) => Math.round(v * 255))).toEqual([0, 255, 0, 128]);
  });

  it('scales texture coordinates by the texture command', () => {
    const ram = new Ram();
    for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i, 0, 0, 64, 96, [255, 255, 255, 255]);
    ram.list(0x1000, [0xd7000002, 0xffffffff], vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const b = run(ram, 0x1000).batches[0] as TriangleBatch;
    // Coordinates are in 10.5 fixed point; the scaled value is rounded down to it.
    expect(b.uvs[0]).toBe(Math.floor((64 * 65535) / 65536) / 32);
    expect(b.uvs[1]).toBe(Math.floor((96 * 65535) / 65536) / 32);
  });

  it('follows segment addresses, calls and branches', () => {
    const ram = new Ram();
    ram.triangleVertices(0x3000);
    // Segment 1 is based at 0x4000 (lists), segment 2 at 0x3000 (vertices).
    ram.list(0x1000,
      [0xdb060004, 0x4000], [0xdb060008, 0x3000],
      [0xde000000, 0x01000100], // call: returns here
      [0xde010000, 0x01000200]); // branch: does not return
    ram.list(0x4100, vtx(3, 0, 0x02000000), tri(0, 1, 2), END);
    ram.list(0x4200, tri(0, 2, 1), END);
    ram.list(0x1020, tri(0, 1, 2), END); // after the branch; must not run
    const r = run(ram, 0x1000);
    expect(r.problems).toEqual([]);
    expect(trianglesIn(r.batches)).toBe(2);
  });

  it('ends a called list at its ENDDL and returns to the caller', () => {
    const ram = new Ram();
    ram.list(0x1000, [0xde000000, 0x2000], [0xe7000000, 0], END);
    ram.list(0x2000, [0xe7000000, 0], END);
    const r = run(ram, 0x1000);
    expect(r.commands).toBe(5);
    expect(r.opcodes.get(Op.RDPPIPESYNC)).toBe(2);
  });

  it('transforms vertices by the model-view and projection matrices and pops the stack', () => {
    const ram = new Ram();
    ram.vertex(0x2000, 1, 1, 0, 0, 0, [0, 0, 0, 255]);
    ram.vertex(0x2010, 0, 0, 0, 0, 0, [0, 0, 0, 255]);
    ram.vertex(0x2020, 0, 0, 0, 0, 0, [0, 0, 0, 255]);
    ram.matrix(0x3000, [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1]);
    ram.matrix(0x3040, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    ram.matrix(0x3080, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
    // The parameter byte is stored with the push bit inverted: 0x07 loads the projection, 0x03 loads the model-view
    // without pushing, 0x00 multiplies and pushes.
    ram.list(0x1000,
      [0xda380007, 0x3000], [0xda380003, 0x3040], [0xda380000, 0x3080],
      vtx(3, 0, 0x2000), tri(0, 1, 2),
      [0xd8380002, 64],
      vtx(3, 0, 0x2000), tri(0, 1, 2),
      END);
    const r = run(ram, 0x1000);
    expect(r.problems).toEqual([]);
    // Both triangles share a batch: neither the multiplication nor the pop changes the render state.
    const [batch] = r.batches as TriangleBatch[];
    // The multiplied matrix applies to the vertex first, then the scale.
    // The projection scale 0.01 is held to 16 fractional bits.
    const near = (got: Float32Array, want: number[]) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w, 3));
    near(batch!.positions.subarray(0, 4), [0.22, 0.02, 0, 1]);
    near(batch!.positions.subarray(12, 16), [0.02, 0.02, 0, 1]);
  });

  it('reports a matrix stack underflow', () => {
    const ram = new Ram();
    ram.list(0x1000, [0xd8380002, 64], END);
    expect(run(ram, 0x1000).problems).toEqual(['matrix stack underflow']);
  });

  it('lights vertices from the normals when lighting is on, and not otherwise', () => {
    const ram = new Ram();
    for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i, 0, 0, 0, 0, [0, 0, 127, 255]);
    // One white light shining along +z, then the ambient colour 0x40.
    ram.bytes.set([255, 255, 255, 0, 255, 255, 255, 0, 0, 0, 127, 0, 0, 0, 0, 0], 0x2800);
    ram.bytes.set([0x40, 0x40, 0x40, 0, 0x40, 0x40, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0x2810);
    const draw = [vtx(3, 0, 0x2000), tri(0, 1, 2), END] as [number, number][];
    ram.list(0x1000, [0xdb020000, 24], [0xdc08060a, 0x2800], [0xdc08090a, 0x2810], [0xd9ffffff, 0x20000], ...draw);
    const lit = run(ram, 0x1000).batches[0] as TriangleBatch;
    // Ambient 0x40 plus the full light, clamped; the light faces +z where the normal (0, 0, 127) points.
    expect(lit.colors[0]).toBe(1);
    ram.list(0x1000, ...draw);
    const plain = run(ram, 0x1000).batches[0] as TriangleBatch;
    expect(plain.colors[2]).toBeCloseTo(127 / 255);
  });

  describe('what the graphics microcode does with vertices (checked against its execution, tools/gfx/ucode-ref.ts)', () => {
    /** Loads three vertices with normal bytes n through a model-view matrix of the given scale and returns the first colour. */
    const lit = (n: [number, number, number], scale: number, light = [0, 0, 127], rgb = [200, 100, 50]) => {
      const ram = new Ram();
      for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, 0, 0, 0, 0, 0, [n[0] & 255, n[1] & 255, n[2] & 255, 255]);
      ram.bytes.set([...rgb, 0, ...rgb, 0, light[0]! & 255, light[1]! & 255, light[2]! & 255, 0, 0, 0, 0, 0], 0x2800);
      ram.bytes.set([20, 30, 40, 0, 20, 30, 40, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0x2810);
      ram.matrix(0x3000, [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1]);
      ram.list(0x1000, [0xdb020000, 24], [0xdc08060a, 0x2800], [0xdc08090a, 0x2810], [0xda380003, 0x3000], [0xd9ffffff, 0x20000],
        vtx(3, 0, 0x2000), tri(0, 1, 2), END);
      return Array.from((run(ram, 0x1000).batches[0] as TriangleBatch).colors.subarray(0, 3)).map((c) => c * 255);
    };

    it('lights with the normal as it is, not normalised: half the length, half the light', () => {
      // Microcode: ambient 20 plus 200 * 64 * 127 / 16384 = 99 for a normal of length 64.
      expect(lit([0, 0, 64], 2)[0]).toBeCloseTo(119, 0);
      expect(lit([0, 0, 127], 2)[0]).toBeCloseTo(216, 0);
    });

    it('gives nothing to a face that looks away, and caps one light at 1 - 2^-15', () => {
      lit([0, 0, -127], 2).forEach((c, i) => expect(c).toBeCloseTo([20, 30, 40][i]!, 3));
      expect(lit([127, 127, 0], 2, [90, 90, 0])[0]).toBeCloseTo(20 + Math.floor((200 * 32767) / 32768), 3);
    });

    it('takes the light direction through the model matrix: a vector of 1.27 is kept, one of 0.58 is dimmed', () => {
      expect(lit([0, 0, 64], 0.01)[0]).toBeCloseTo(lit([0, 0, 64], 2)[0]!, 3);
      expect(lit([0, 0, 127], 0.0046)[0]).toBeLessThan(lit([0, 0, 127], 2)[0]! - 50);
    });

    it('generates texture coordinates from the normal and the look-at vectors', () => {
      const ram = new Ram();
      for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, 0, 0, 0, 0, 0, [127, 0, 0, 255]);
      // Look-at x along +x, look-at y along +y, then one light and the ambient.
      ram.bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0, 0, 0, 0, 0], 0x2800);
      ram.bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0, 0, 0, 0], 0x2810);
      ram.bytes.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 0, 0, 0], 0x2820);
      ram.bytes.set(new Uint8Array(16), 0x2830);
      ram.matrix(0x3000, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const draw = (mode: number) => {
        ram.list(0x1000, [0xdb020000, 24], [0xdc08000a, 0x2800], [0xdc08030a, 0x2810], [0xdc08060a, 0x2820], [0xdc08090a, 0x2830],
          [0xda380003, 0x3000], [0xd7000001, 0xffffffff], [0xd9ffffff, 0x20000 | mode], vtx(3, 0, 0x2000), tri(0, 1, 2), END);
        return run(ram, 0x1000).batches[0] as TriangleBatch;
      };
      // Plain mode: 0x3FFF + 127 * 127 along the look-at x, 0x3FFF across it. Linear mode: the cubic, 32281 at the end.
      expect(draw(0x40000).uvs[0]! * 32).toBeCloseTo(32512, -1);
      expect(draw(0x40000).uvs[1]! * 32).toBeCloseTo(0x3fff, -1);
      expect(draw(0xc0000).uvs[0]! * 32).toBeCloseTo(32281, -1);
    });

    /** Three vertices through a projection whose w is 0.3 + 0.0004 z, so that z below -750 is behind the eye. */
    const perspective = (zs: [number, number, number], mult: number, offset: number) => {
      const ram = new Ram();
      zs.forEach((z, i) => ram.vertex(0x2000 + i * 16, [0, 20, -20][i]!, 10, z, 0, 0, [255, 255, 255, 255]));
      ram.matrix(0x3000, [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.0005, 0.0004, 0, 0, 0.2, 0.3]);
      ram.list(0x1000, [0xdb080000, ((mult & 0xffff) << 16) | (offset & 0xffff)], [0xda380007, 0x3000], [0xd9ffffff, 0x10000], vtx(3, 0, 0x2000), tri(0, 1, 2), END);
      return run(ram, 0x1000);
    };

    it('takes the fog factor from z / w, and gives a vertex behind the eye the lowest depth', () => {
      // z / w = 0.6666 at z = 0: 200 * 0.6666 - 50 = 83.
      const [front] = perspective([0, 0, 0], 200, -50).batches as TriangleBatch[];
      expect(front!.colors[3]! * 255).toBeCloseTo(83, 0);
      // With w < 0 z / w would exceed 1 and give the far end's fog (1); the microcode stores 0 for a positive multiplier, so the
      // vertices the clipper makes towards it fade down from the fog of the two in front (233 of 255) instead of up.
      const behind = perspective([0, 0, -2000], 200, 100).batches as TriangleBatch[];
      const alphas = behind.flatMap((b) => Array.from(b.colors).filter((_, i) => i % 4 === 3));
      expect(Math.min(...alphas)).toBeLessThan(0.8);
      expect(alphas.every((a) => a >= 0 && a <= 1)).toBe(true);
    });

    it('clips a triangle behind the eye to twice the screen and keeps w positive', () => {
      const [b] = perspective([0, 0, -2000], 0, 0).batches as TriangleBatch[];
      expect(b!.positions.length / 12).toBeGreaterThan(1);
      for (let i = 0; i < b!.positions.length; i += 4) {
        expect(b!.positions[i + 3]).toBeGreaterThan(0);
        expect(Math.abs(b!.positions[i]!)).toBeLessThanOrEqual(2 * b!.positions[i + 3]! + 1e-4);
        expect(Math.abs(b!.positions[i + 1]!)).toBeLessThanOrEqual(2 * b!.positions[i + 3]! + 1e-4);
      }
    });

    it('drops a triangle whose vertices are all beyond the far plane, and ends a list culled for it', () => {
      expect(trianglesIn(perspective([1500, 2000, 2500], 0, 0).batches)).toBe(0);
      const ram = new Ram();
      for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i, 0, 3000, 0, 0, [0, 0, 0, 255]);
      ram.matrix(0x3000, [0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.0005, 0.0004, 0, 0, 0.2, 0.3]);
      ram.list(0x1000, [0xda380007, 0x3000], vtx(3, 0, 0x2000), [0x03000000, 4], tri(0, 1, 2), END);
      expect(run(ram, 0x1000).batches).toHaveLength(0);
    });

    it('branches to the list of the last RDPHALF_1 when the integer part of a vertex w is below the value', () => {
      const ram = new Ram();
      ram.triangleVertices(0x2000);
      ram.list(0x1000, vtx(3, 0, 0x2000), [0xe1000000, 0x3000], [0x04000000, 5], [0xfa000000, 0x11223344], tri(0, 1, 2), END);
      ram.list(0x3000, [0xfa000000, 0x55667788], tri(0, 1, 2), END);
      // The vertices are not transformed, so w is 1: below 5 the branch is taken and the first list's draw never happens.
      const taken = run(ram, 0x1000).batches as TriangleBatch[];
      expect(taken).toHaveLength(1);
      expect(taken[0]!.state.primColor.r).toBe(0x55);
      ram.list(0x1000, vtx(3, 0, 0x2000), [0xe1000000, 0x3000], [0x04000000, 1], [0xfa000000, 0x11223344], tri(0, 1, 2), END);
      expect((run(ram, 0x1000).batches[0] as TriangleBatch).state.primColor.r).toBe(0x11);
    });

    it('overwrites the colour or the texture coordinates of a loaded vertex', () => {
      const ram = new Ram();
      ram.triangleVertices(0x2000);
      ram.list(0x1000, vtx(3, 0, 0x2000), [0x02100002, 0x11223344], [0x02140002, 0x00370ece], tri(0, 1, 2), END);
      const b = run(ram, 0x1000).batches[0] as TriangleBatch;
      expect(Array.from(b.colors.subarray(0, 4)).map((c) => Math.round(c * 255))).toEqual([0, 0, 0, 255]);
      expect(Array.from(b.colors.subarray(4, 8)).map((c) => Math.round(c * 255))).toEqual([0x11, 0x22, 0x33, 0x44]);
      expect(b.uvs[2]).toBe(0x37 / 32);
      expect(b.uvs[3]).toBe(0xece / 32);
    });
  });

  it('starts a new batch when the render state changes and keeps the state of each', () => {
    const ram = new Ram();
    ram.triangleVertices(0x2000);
    ram.list(0x1000,
      vtx(3, 0, 0x2000),
      [0xfa000000, 0x11223344], tri(0, 1, 2), tri(0, 1, 2),
      [0xfa000000, 0x55667788], tri(0, 1, 2),
      END);
    const r = run(ram, 0x1000);
    expect(r.batches).toHaveLength(2);
    const [a, b] = r.batches as TriangleBatch[];
    expect(a!.positions.length / 12).toBe(2);
    expect(a!.state.primColor).toMatchObject({ r: 0x11, g: 0x22, b: 0x33, a: 0x44 });
    expect(b!.state.primColor).toMatchObject({ r: 0x55, a: 0x88 });
  });

  it('keeps geometry mode, other modes, combiner and colours in the state', () => {
    const ram = new Ram();
    ram.triangleVertices(0x2000);
    ram.list(0x1000,
      [0xd9ffffff, 0x220405], [0xd9fffffb, 0],
      [0xe3000a01, 0x00300000], [0xe200001c, 0x0c184340],
      [0xfc267e60, 0x350cf37f], [0xfb000000, 0x96003280], [0xf8000000, 0x1e1e1e00], [0xf9000000, 8],
      vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const s = (run(ram, 0x1000).batches[0] as TriangleBatch).state;
    expect(s.geometryMode).toBe(0x220401);
    // SETOTHERMODE_H of 2 bits at bit 20 is the cycle type; SETOTHERMODE_L of 29 bits from bit 3 replaces the rest.
    expect((s.otherModeH >>> 20) & 3).toBe(3);
    expect(s.otherModeL >>> 3).toBe(0x0c184340 >>> 3);
    expect(s.envColor).toEqual({ r: 0x96, g: 0, b: 0x32, a: 0x80 });
    expect(s.fogColor.r).toBe(0x1e);
    expect(s.blendColor.a).toBe(8);
    expect(s.combine.raw).toEqual([0x267e60, 0x350cf37f]);
  });

  it('splits the combiner word into its fields', () => {
    // sub_a_rgb0 3, mul_rgb0 5, sub_a_a0 1, mul_a0 2, sub_a_rgb1 4, mul_rgb1 6
    const w0 = (3 << 20) | (5 << 15) | (1 << 12) | (2 << 9) | (4 << 5) | 6;
    // sub_b_rgb0 7, sub_b_rgb1 8, sub_a_a1 1, mul_a1 2, add_rgb0 3, sub_b_a0 4, add_a0 5, add_rgb1 6, sub_b_a1 7, add_a1 1
    const w1 = (7 << 28) | (8 << 24) | (1 << 21) | (2 << 18) | (3 << 15) | (4 << 12) | (5 << 9) | (6 << 6) | (7 << 3) | 1;
    const c = decodeCombine(w0, w1);
    expect(c.cycles[0]).toEqual({ rgb: [3, 7, 5, 3], alpha: [1, 4, 2, 5] });
    expect(c.cycles[1]).toEqual({ rgb: [4, 8, 6, 6], alpha: [1, 7, 2, 1] });
  });

  it('loads a texture block into a tile and decodes it for the draw', () => {
    const ram = new Ram();
    ram.triangleVertices(0x2000);
    // A 4x2 I8 texture at 0x5000, loaded as one block of 8 bytes through a 16-bit load tile (4 texels).
    ram.bytes.set([10, 20, 30, 40, 50, 60, 70, 80], 0x5000);
    const settile = (fmt: number, siz: number, line: number, tmem: number, tile: number): [number, number] =>
      [0xf5000000 | (fmt << 21) | (siz << 19) | (line << 9) | tmem, tile << 24];
    ram.list(0x1000,
      [0xfd000000 | (2 << 19) | 3, 0x5000], // 16-bit image, 4 texels wide
      settile(0, 2, 0, 0, 7),
      [0xf3000000, (7 << 24) | (3 << 12)], // load 4 16-bit texels = 8 bytes
      settile(4, 1, 1, 0, 0), // I8 render tile, rows of one 8-byte word
      [0xf2000000, (0 << 24) | (3 << 14) | (1 << 2)], // 4x2 texels (tile 0 bounds in 10.2)
      [0xd7000002, 0xffffffff],
      vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const r = run(ram, 0x1000);
    expect(r.problems).toEqual([]);
    const tex = (r.batches[0] as TriangleBatch).state.textures[0]!;
    expect([tex.width, tex.height]).toEqual([4, 2]);
    // Rows are one TMEM word (8 bytes) apart, so the second row begins at byte 8.
    expect(Array.from(tex.rgba).filter((_, i) => i % 4 === 0).slice(0, 4)).toEqual([10, 20, 30, 40]);
  });

  it('decodes a tile from where its load put the upper-left texel, whatever the tile bounds are', () => {
    const ram = new Ram();
    ram.triangleVertices(0x2000);
    ram.bytes.set([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33], 0x5000);
    const bounds = (1 << 2) << 12 | (1 << 2);
    const end = (2 << 2) << 12 | (2 << 2);
    ram.list(0x1000,
      [0xfd000000 | (4 << 21) | (1 << 19) | 3, 0x5000],
      [0xf5000000 | (4 << 21) | (1 << 19) | (1 << 9), 7 << 24],
      [0xf4000000 | bounds, (7 << 24) | end],
      [0xf5000000 | (4 << 21) | (1 << 19) | (1 << 9), 0],
      [0xf2000000 | bounds, end],
      vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const tex = (run(ram, 0x1000).batches[0] as TriangleBatch).state.textures[0]!;
    expect([tex.width, tex.height]).toEqual([2, 2]);
    expect(Array.from(tex.rgba).filter((_, i) => i % 4 === 0)).toEqual([11, 12, 21, 22]);
  });

  it('resolves a CI texture through the palette loaded by LOADTLUT', () => {
    const ram = new Ram();
    ram.triangleVertices(0x2000);
    ram.bytes.set([0xf8, 0x01, 0x07, 0xc1], 0x5100); // red, green
    ram.bytes.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0x5000);
    const settile = (fmt: number, siz: number, line: number, tmem: number, tile: number): [number, number] =>
      [0xf5000000 | (fmt << 21) | (siz << 19) | (line << 9) | tmem, tile << 24];
    ram.list(0x1000,
      [0xfd000000 | (2 << 21) | (2 << 19), 0x5100],
      settile(0, 0, 0, 256, 7),
      [0xf0000000, (7 << 24) | (1 << 14)], // two colours
      [0xfd000000 | (2 << 21) | (1 << 19) | 7, 0x5000],
      settile(2, 1, 1, 0, 0),
      [0xf4000000, (0 << 24) | (7 << 14)],
      [0xf2000000, (7 << 14) | (0 << 12)],
      [0xe3000e01, 0x00008000], // TLUT enabled (RGBA16)
      vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const tex = (run(ram, 0x1000).batches[0] as TriangleBatch).state.textures[0]!;
    // The first texel's index is 1: the green entry.
    expect(Array.from(tex.rgba.subarray(0, 4))).toEqual([0, 255, 0, 255]);
  });

  it('emits texture and fill rectangles', () => {
    const ram = new Ram();
    ram.list(0x1000,
      [0xf6000000 | ((319 * 4) << 12) | (239 * 4), 0],
      [0xe4000000 | (200 << 12) | 100, 0x01000000 | (10 << 12) | 20], [0xe1000000, 0x00200040], [0xf1000000, 0x04000400],
      END);
    const r = run(ram, 0x1000);
    expect(r.unknown).toEqual([]);
    const [fill, rect] = r.batches;
    expect(fill).toMatchObject({ kind: 'fillrect', xl: 1276, yl: 956 });
    expect(rect).toMatchObject({ kind: 'texrect', tile: 1, xl: 200, yl: 100, xh: 10, yh: 20, s: 0x20, t: 0x40, dsdx: 0x400, dtdy: 0x400 });
  });

  it('ends the list when CULLDL finds every vertex outside one side of the screen', () => {
    const ram = new Ram();
    for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, 100 + i, 0, 0, 0, 0, [0, 0, 0, 255]);
    ram.matrix(0x3000, IDENTITY);
    ram.list(0x1000, [0xda380007, 0x3000], vtx(3, 0, 0x2000), [0x03000000, 4], tri(0, 1, 2), END);
    const r = run(ram, 0x1000);
    expect(r.batches).toHaveLength(0);
    expect(r.commands).toBe(3);
  });

  it('reports commands it does not know and keeps going', () => {
    const ram = new Ram();
    ram.list(0x1000, [0xb1234567, 0x89abcdef], [0xe7000000, 0], END);
    const r = run(ram, 0x1000);
    expect(r.unknown).toEqual([{ addr: 0x1000, w0: 0xb1234567, w1: 0x89abcdef }]);
    expect(r.opcodes.get(Op.RDPPIPESYNC)).toBe(1);
  });

  it('reports vertices that were never loaded', () => {
    const ram = new Ram();
    ram.list(0x1000, tri(0, 1, 2), END);
    expect(run(ram, 0x1000).problems).toHaveLength(1);
  });
});

describe.each(IMPLEMENTATIONS)('background pictures of the 2D microcode (%s)', (_name, run) => {
  const RECORD = 0x3000, UCODE_DATA = 0x4000, UCODE_TEXT = 0x5000, PICTURE = 0x10000;
  const IMAGE = 0x8000;

  /** 4x2 RGBA16 texels (red, green, blue, white; then black, and three half-intensity ones), a 2D microcode and a record. */
  function scene(op: number, mode: number, record: Partial<Record<'imageX' | 'frameX' | 'frameY' | 'scaleW', number>> = {}): Ram {
    const ram = new Ram();
    const texels = [0xf801, 0x07c1, 0x003f, 0xffff, 0x0001, 0x7bdf, 0x7bdf, 0x7bdf];
    texels.forEach((t, i) => ram.dv.setUint16(PICTURE + i * 2, t));
    ram.bytes.set(Array.from('RSP Gfx[Safe] S2DEX fifo 2.05', (c) => c.charCodeAt(0)), UCODE_DATA + 0x138);
    const r = RECORD;
    ram.dv.setUint16(r, record.imageX ?? 0);
    ram.dv.setUint16(r + 2, 4 * 4);
    ram.dv.setInt16(r + 4, (record.frameX ?? 2) * 4);
    ram.dv.setUint16(r + 6, 4 * 4);
    ram.dv.setUint16(r + 10, 2 * 4);
    ram.dv.setInt16(r + 12, (record.frameY ?? 1) * 4);
    ram.dv.setUint16(r + 14, 2 * 4);
    ram.dv.setUint32(r + 16, PICTURE);
    ram.dv.setUint16(r + 20, 0xfff4);
    ram.dv.setUint8(r + 22, 0);
    ram.dv.setUint8(r + 23, 2);
    ram.dv.setUint16(r + 28, record.scaleW ?? 0x400);
    ram.dv.setUint16(r + 30, 0x400);
    ram.list(0x1000,
      [0xff000000 | (2 << 19) | 319, 0x80000000 | IMAGE],
      [0xe1000000, UCODE_DATA], [0xdd0007ff, UCODE_TEXT],
      [0xef000000 | mode, 1], [op << 24, 0x80000000 | RECORD], END);
    return ram;
  }

  it('is one copy-mode texture rectangle over the frame window, taking the picture from the record', () => {
    const r = run(scene(0x0a, 0x200000), 0x1000);
    expect(r.unknown).toEqual([]);
    expect(r.problems).toEqual([]);
    const rect = r.batches.at(-1)!;
    // The last pixel of a copy-mode rectangle is included: a 4x2 frame at (2,1) ends at (5,2).
    expect(rect).toMatchObject({ kind: 'texrect', xh: 8, yh: 4, xl: 8 + 16 - 4, yl: 4 + 8 - 4, s: 0, t: 0, dsdx: 4096, dtdy: 1024 });
    const tex = (rect as { state: { textures: ({ width: number; height: number; rgba: Uint8Array } | null)[] } }).state.textures[0]!;
    expect([tex.width, tex.height]).toEqual([4, 2]);
    expect(Array.from(tex.rgba.subarray(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('draws the picture 1:1 into the colour image, texels with alpha 0 left alone', () => {
    const soft = new SoftRenderer();
    soft.drawTask(run(scene(0x0a, 0x200000), 0x1000));
    const img = soft.image(IMAGE)!;
    const at = (x: number, y: number) => Array.from(img.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 3));
    expect(at(2, 1)).toEqual([255, 0, 0]);
    expect(at(5, 1)).toEqual([255, 255, 255]);
    expect(at(6, 1)).toEqual([0, 0, 0]);
    expect(at(2, 2)).toEqual([0, 0, 0]);
    expect(at(4, 2)).toEqual([123, 123, 123]);
    expect(at(1, 1)).toEqual([0, 0, 0]);
  });

  it('scales a one-cycle picture by the record and starts at its image offset', () => {
    const r = run(scene(0x09, 0x000000, { imageX: 32, scaleW: 0x800 }), 0x1000);
    const rect = r.batches.at(-1)!;
    expect(rect).toMatchObject({ kind: 'texrect', xl: 8 + 16, yl: 4 + 8, s: 32, dsdx: 512, dtdy: 1024 });
  });

  it('is an unknown command while the 3D microcode is loaded', () => {
    const ram = new Ram();
    ram.list(0x1000, [0x0a000000, 0x80000000 | RECORD], END);
    expect(run(ram, 0x1000).unknown).toHaveLength(1);
  });
});
