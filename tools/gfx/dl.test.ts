import { describe, expect, it } from 'vitest';
import { DisplayListInterpreter, decodeCombine, type TriangleBatch } from './dl.ts';
import { Op } from './opcodes.ts';

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
const run = (ram: Ram, at: number) => new DisplayListInterpreter().run(ram.bytes, at);
const trianglesIn = (batches: { kind: string }[]) =>
  (batches as TriangleBatch[]).reduce((n, b) => n + (b.kind === 'triangles' ? b.positions.length / 12 : 0), 0);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('display list interpreter', () => {
  it('draws a triangle from loaded vertices', () => {
    const ram = new Ram();
    ram.vertex(0x2000, 1, 2, 3, 32, 64, [255, 0, 0, 255]);
    ram.vertex(0x2010, 4, 5, 6, 0, 0, [0, 255, 0, 128]);
    ram.vertex(0x2020, 7, 8, 9, 0, 0, [0, 0, 255, 255]);
    ram.list(0x1000, vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const r = run(ram, 0x1000);
    expect(r.unknown).toEqual([]);
    expect(r.problems).toEqual([]);
    const b = r.batches[0] as TriangleBatch;
    expect(Array.from(b.positions.subarray(0, 8))).toEqual([1, 2, 3, 1, 4, 5, 6, 1]);
    expect(Array.from(b.colors.subarray(4, 8)).map((v) => Math.round(v * 255))).toEqual([0, 255, 0, 128]);
  });

  it('scales texture coordinates by the texture command', () => {
    const ram = new Ram();
    for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i, 0, 0, 64, 96, [255, 255, 255, 255]);
    ram.list(0x1000, [0xd7000002, 0xffffffff], vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const b = run(ram, 0x1000).batches[0] as TriangleBatch;
    expect(b.uvs[0]).toBeCloseTo((64 / 32) * (65535 / 65536), 5);
    expect(b.uvs[1]).toBeCloseTo((96 / 32) * (65535 / 65536), 5);
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
    ram.matrix(0x3000, IDENTITY);
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
    expect(Array.from(batch!.positions.subarray(0, 4))).toEqual([22, 2, 0, 1]);
    expect(Array.from(batch!.positions.subarray(12, 16))).toEqual([2, 2, 0, 1]);
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
