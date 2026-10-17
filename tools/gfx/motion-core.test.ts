import { describe, expect, it } from 'vitest';
import { sharedGfxModule, sharedInterpreter } from './c-dl-node.ts';
import { MatrixFlag, readMatrices, readVertexLoads, writeOverrides, type MotionCore, type MotionMatrix } from './motion.ts';
import type { TriangleBatch } from './types.ts';

const core = (await sharedGfxModule()) as unknown as MotionCore;
const interpreter = await sharedInterpreter();

class Ram {
  readonly bytes = new Uint8Array(0x100000);
  readonly dv = new DataView(this.bytes.buffer);
  list(addr: number, ...cmds: [number, number][]): number {
    let a = addr;
    for (const [w0, w1] of cmds) {
      this.dv.setUint32(a, w0 >>> 0);
      this.dv.setUint32(a + 4, w1 >>> 0);
      a += 8;
    }
    return a;
  }
  vertex(addr: number, x: number, y: number, z: number): void {
    this.dv.setInt16(addr, x);
    this.dv.setInt16(addr + 2, y);
    this.dv.setInt16(addr + 4, z);
    this.bytes.set([255, 255, 255, 255], addr + 12);
  }
  matrix(addr: number, m: number[]): void {
    m.forEach((v, i) => {
      const fixed = Math.round(v * 65536);
      this.dv.setInt16(addr + i * 2, fixed >> 16);
      this.dv.setUint16(addr + 32 + i * 2, fixed & 0xffff);
    });
  }
}

const END: [number, number] = [0xdf000000, 0];
const SYNC: [number, number] = [0xe7000000, 0];
const SEGMENT_1: [number, number] = [0xdb060004, 0x4000];
const vtx = (n: number, v0: number, addr: number): [number, number] => [0x01000000 | (n << 12) | ((v0 + n) << 1), addr];
const tri = (a: number, b: number, c: number): [number, number] => [0x05000000 | ((a * 2) << 16) | ((b * 2) << 8) | (c * 2), 0];
// The parameter byte has the push bit inverted: 0x07 loads the projection, 0x03 loads the model-view, 0x01 multiplies it in.
const PROJECTION_LOAD: [number, number] = [0xda380007, 0];
const loadModel = (addr: number): [number, number] => [0xda380003, addr];
const mulModel = (addr: number): [number, number] => [0xda380001, addr];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PERSPECTIVE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1];
const ORTHOGRAPHIC = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SCALE_TENTH = [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1];

interface Layout {
  /** Where the list the game builds each frame starts, and where its matrices are. */
  root: number;
  matrices: number;
  /** Commands the game put in front of the actor, which differ from frame to frame. */
  padding: number;
  projection?: number[];
}

/**
 * A frame as the game builds it: its own list (a projection, a model matrix, a call of the actor's list behind segment 1) and the
 * actor's static list (a local matrix, three vertices, a triangle). Matrices are copied out of the module's records.
 */
function frame(layout: Layout, local: number[] = IDENTITY): { ram: Ram; start: number } {
  const ram = new Ram();
  ram.matrix(layout.matrices, layout.projection ?? PERSPECTIVE);
  ram.matrix(layout.matrices + 0x40, SCALE_TENTH);
  ram.matrix(layout.matrices + 0x80, local);
  for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i * 2, i === 1 ? 2 : 0, 0);
  const sync = Array.from({ length: layout.padding }, () => SYNC);
  ram.list(layout.root, SEGMENT_1, ...sync, [PROJECTION_LOAD[0], layout.matrices], loadModel(layout.matrices + 0x40), [0xde000000, 0x01000100], END);
  ram.list(0x4100, mulModel(layout.matrices + 0x80), vtx(3, 0, 0x2000), tri(0, 1, 2), END);
  return { ram, start: layout.root };
}

/** Clip-space positions of the first batch's vertices, copied out of the module's memory before the next run overwrites them. */
const positionsOf = (batch: TriangleBatch | undefined): number[] => Array.from(batch!.positions);

function record(ram: Ram, start: number): { matrices: MotionMatrix[]; positions: number[] } {
  core._gfx_motion_record(1);
  const result = interpreter.run(ram.bytes, start);
  core._gfx_motion_record(0);
  expect(result.problems).toEqual([]);
  return { matrices: readMatrices(core), positions: positionsOf(result.batches[0] as TriangleBatch) };
}

describe('matrix names', () => {
  it('stay the same when the game builds its lists elsewhere, in another order of matrices and with other commands in front', () => {
    const a = frame({ root: 0x1000, matrices: 0x3000, padding: 0 });
    const b = frame({ root: 0x1800, matrices: 0x3400, padding: 5 });
    const one = record(a.ram, a.start).matrices, two = record(b.ram, b.start).matrices;
    expect(one).toHaveLength(3);
    expect(two.map((m) => m.name)).toEqual(one.map((m) => m.name));
    expect(two.map((m) => m.source)).not.toEqual(one.map((m) => m.source));
    expect(new Set(one.map((m) => m.name)).size).toBe(3);
    expect(one.map((m) => m.ordinal)).toEqual([0, 0, 0]);
  });

  it('tell the matrix kinds apart and mark what is under a perspective projection', () => {
    const f = frame({ root: 0x1000, matrices: 0x3000, padding: 0 });
    const [projection, model, local] = record(f.ram, f.start).matrices;
    expect(projection!.flags).toBe(MatrixFlag.PROJECTION | MatrixFlag.LOAD | MatrixFlag.PERSPECTIVE);
    expect(model!.flags).toBe(MatrixFlag.LOAD | MatrixFlag.PERSPECTIVE);
    expect(local!.flags).toBe(MatrixFlag.PERSPECTIVE);
    const flat = frame({ root: 0x1000, matrices: 0x3000, padding: 0, projection: ORTHOGRAPHIC });
    expect(record(flat.ram, flat.start).matrices.map((m) => m.flags & MatrixFlag.PERSPECTIVE)).toEqual([0, 0, 0]);
  });

  it('count a list drawn twice by ordinal', () => {
    const ram = new Ram();
    ram.matrix(0x3000, PERSPECTIVE);
    ram.matrix(0x3040, SCALE_TENTH);
    ram.matrix(0x3080, IDENTITY);
    for (let i = 0; i < 3; i++) ram.vertex(0x2000 + i * 16, i, 0, 0);
    ram.list(0x1000, SEGMENT_1, [PROJECTION_LOAD[0], 0x3000], loadModel(0x3040), [0xde000000, 0x01000100], [0xde000000, 0x01000100], END);
    ram.list(0x4100, mulModel(0x3080), vtx(3, 0, 0x2000), tri(0, 1, 2), END);
    const matrices = record(ram, 0x1000).matrices;
    expect(matrices).toHaveLength(4);
    expect(matrices[2]!.name).toBe(matrices[3]!.name);
    expect([matrices[2]!.ordinal, matrices[3]!.ordinal]).toEqual([0, 1]);
  });
});

describe('matrix overrides', () => {
  const layout = { root: 0x1000, matrices: 0x3000, padding: 0 };

  it('replace the matrix of the command with that name and ordinal, and only that', () => {
    const f = frame(layout);
    const plain = record(f.ram, f.start);
    const local = plain.matrices[2]!;
    const moved = Float64Array.from(IDENTITY);
    moved[12] = 3;
    writeOverrides(core, [{ ...local, m: moved }]);
    const shifted = positionsOf(interpreter.run(f.ram.bytes, f.start).batches[0] as TriangleBatch);
    for (let i = 0; i < 3; i++) {
      expect(shifted[i * 4]! - plain.positions[i * 4]!).toBeCloseTo(0.3, 3);
      expect(shifted[i * 4 + 1]).toBe(plain.positions[i * 4 + 1]);
    }
    // A name with another ordinal matches no command.
    writeOverrides(core, [{ ...local, ordinal: 1, m: moved }]);
    expect(positionsOf(interpreter.run(f.ram.bytes, f.start).batches[0] as TriangleBatch)).toEqual(plain.positions);
    writeOverrides(core, []);
    expect(positionsOf(interpreter.run(f.ram.bytes, f.start).batches[0] as TriangleBatch)).toEqual(plain.positions);
  });

  it('are not applied while recording', () => {
    const f = frame(layout);
    const plain = record(f.ram, f.start);
    const moved = Float64Array.from(IDENTITY);
    moved[12] = 3;
    writeOverrides(core, [{ ...plain.matrices[2]!, m: moved }]);
    const again = record(f.ram, f.start);
    expect(again.positions).toEqual(plain.positions);
    expect(again.matrices[2]!.m[12]).toBe(0);
    writeOverrides(core, []);
  });
});

describe('vertex loads', () => {
  it('record a hash of the bytes and the count', () => {
    const f = frame({ root: 0x1000, matrices: 0x3000, padding: 0 });
    record(f.ram, f.start);
    const [load] = readVertexLoads(core);
    expect(load!.count).toBe(3);
    const g = frame({ root: 0x1000, matrices: 0x3000, padding: 0 });
    g.ram.vertex(0x2000, 7, 7, 7);
    record(g.ram, g.start);
    expect(readVertexLoads(core)[0]!.hash).not.toBe(load!.hash);
  });
});
