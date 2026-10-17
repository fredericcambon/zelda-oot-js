import { describe, expect, it } from 'vitest';
import {
  blend, compose, decompose, interpolate, jumped, lerp, lerp3, MatrixFlag, matchFrames, MOTION_LIMITS, planMotion, quatAngle, rewrittenShare, slerp,
  type MotionMatrix, type Quat,
} from './motion.ts';
import { smoothFraction } from './smooth.ts';

const THREE_D = MatrixFlag.PERSPECTIVE;
const CAMERA = MatrixFlag.PROJECTION | MatrixFlag.PERSPECTIVE;

/** A row-vector matrix: rotation about y by `angle`, then scale, then translation. */
function matrix(x: number, y: number, z: number, angle = 0, scale = 1): Float64Array {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return Float64Array.of(c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1);
}

const mtx = (name: number, m: Float64Array, flags = THREE_D | MatrixFlag.LOAD, ordinal = 0): MotionMatrix => ({ name, ordinal, flags, source: name * 64, m });

const aboutY = (angle: number): Quat => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

describe('lerp and slerp', () => {
  it('lerp blends linearly', () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 0.25)).toBe(4);
    expect(lerp(2, 10, 1)).toBe(10);
    expect(lerp3([0, 0, 0], [10, -20, 30], 0.5)).toEqual([5, -10, 15]);
  });

  it('slerp keeps the ends and turns evenly between them', () => {
    const a = aboutY(0), b = aboutY(Math.PI / 2);
    expect(slerp(a, b, 0)).toEqual(a);
    expect(slerp(a, b, 1)).toEqual(b);
    const mid = slerp(a, b, 0.5);
    expect(mid[1]).toBeCloseTo(Math.sin(Math.PI / 8), 12);
    expect(mid[3]).toBeCloseTo(Math.cos(Math.PI / 8), 12);
    expect(quatAngle(a, slerp(a, b, 0.25))).toBeCloseTo(Math.PI / 8, 12);
  });

  it('slerp takes the short way when the quaternions are on opposite hemispheres', () => {
    const a = aboutY(0.1);
    const b = aboutY(0.3).map((v) => -v) as Quat;
    expect(quatAngle(a, slerp(a, b, 0.5))).toBeCloseTo(0.1, 12);
  });

  it('slerp of two equal rotations is that rotation', () => {
    const a = aboutY(1);
    const m = slerp(a, a, 0.3);
    for (let i = 0; i < 4; i++) expect(m[i]).toBeCloseTo(a[i]!, 12);
  });
});

describe('decompose and compose', () => {
  it('round-trips a rotation, a scale and a translation', () => {
    const m = matrix(10, -20, 30, 0.7, 2);
    const back = compose(decompose(m));
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(m[i]!, 9);
  });

  it('round-trips a camera through its eye', () => {
    const view = matrix(-300, 40, 1200, 1.1);
    const pose = decompose(view, true);
    expect(pose.kind === 'pose' && pose.camera).toBe(true);
    const back = compose(pose);
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(view[i]!, 9);
  });

  it('keeps a mirror a mirror', () => {
    const m = matrix(1, 2, 3, 0.4);
    for (let i = 0; i < 3; i++) m[i] = -m[i]!;
    const back = compose(decompose(m));
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(m[i]!, 9);
  });

  it('treats a projection and a shear as a shape', () => {
    const projection = Float64Array.of(1.3, 0, 0, 0, 0, 1.7, 0, 0, 0, 0, -1, -1, 0, 0, -20, 0);
    expect(decompose(projection).kind).toBe('shape');
    const shear = matrix(0, 0, 0);
    shear[1] = 0.5;
    expect(decompose(shear).kind).toBe('shape');
  });

  it('rotating a camera on the spot moves the eye nowhere', () => {
    const eye = [900, 100, -1500];
    const view = (angle: number) => {
      const r = matrix(0, 0, 0, angle);
      // t = -e R
      r[12] = -(eye[0]! * r[0]! + eye[1]! * r[4]! + eye[2]! * r[8]!);
      r[13] = -(eye[0]! * r[1]! + eye[1]! * r[5]! + eye[2]! * r[9]!);
      r[14] = -(eye[0]! * r[2]! + eye[1]! * r[6]! + eye[2]! * r[10]!);
      return r;
    };
    const mid = blend(decompose(view(0), true), decompose(view(0.2), true), 0.5);
    const expected = view(0.1);
    for (let i = 0; i < 16; i++) expect(mid[i]).toBeCloseTo(expected[i]!, 9);
  });
});

describe('matrix matching', () => {
  it('pairs matrices with the same name and the same kind', () => {
    const prev = [mtx(1, matrix(0, 0, 0)), mtx(2, matrix(5, 0, 0))];
    const cur = [mtx(2, matrix(6, 0, 0)), mtx(1, matrix(1, 0, 0))];
    const found = matchFrames(prev, cur);
    expect(found[0]).toBe(prev[1]);
    expect(found[1]).toBe(prev[0]);
  });

  it('leaves out a matrix that appeared and ignores one that disappeared', () => {
    const prev = [mtx(1, matrix(0, 0, 0)), mtx(9, matrix(0, 0, 0))];
    const cur = [mtx(1, matrix(1, 0, 0)), mtx(3, matrix(0, 0, 0))];
    expect(matchFrames(prev, cur)).toEqual([prev[0], null]);
  });

  it('pairs matrices of one name in order when the frames have as many', () => {
    const prev = [mtx(1, matrix(0, 0, 0), THREE_D, 0), mtx(1, matrix(100, 0, 0), THREE_D, 1)];
    const cur = [mtx(1, matrix(101, 0, 0), THREE_D, 1), mtx(1, matrix(1, 0, 0), THREE_D, 0)];
    expect(matchFrames(prev, cur)).toEqual([prev[1], prev[0]]);
  });

  it('keeps the partners of the instances that stayed when one of a name went away or appeared', () => {
    const near = mtx(1, matrix(100, 0, 0), THREE_D, 0), far = mtx(1, matrix(500, 0, 0), THREE_D, 1);
    // The first instance is gone: the second, now the only one, is still paired with the second.
    expect(matchFrames([near, far], [mtx(1, matrix(502, 0, 0), THREE_D, 0)])).toEqual([far]);
    // A third appeared in front: the two that stayed keep their partners, the newcomer has none.
    const cur = [mtx(1, matrix(-300, 0, 0), THREE_D, 0), mtx(1, matrix(101, 0, 0), THREE_D, 1), mtx(1, matrix(501, 0, 0), THREE_D, 2)];
    expect(matchFrames([near, far], cur)).toEqual([null, near, far]);
  });

  it('does not pair a matrix whose kind changed', () => {
    const prev = [mtx(5, matrix(0, 0, 0), THREE_D | MatrixFlag.LOAD)];
    expect(matchFrames(prev, [mtx(5, matrix(0, 0, 0), THREE_D)])).toEqual([null]);
    expect(matchFrames(prev, [mtx(5, matrix(0, 0, 0), MatrixFlag.LOAD)])).toEqual([null]);
  });

  it('plans over frames of the same structure: everything pairs, the share is full', () => {
    const frame = (dx: number) => [mtx(1, matrix(dx, 0, 0), CAMERA), mtx(2, matrix(10 + dx, 0, 0)), mtx(3, matrix(20, dx, 0, dx / 10))];
    const plan = planMotion(frame(0), frame(4));
    expect(plan.stats).toEqual({ threeD: 3, matched: 3, jumps: 0, flat: 0, cut: false });
    expect(plan.entries).toHaveLength(3);
  });

  it('counts an object that appears as unmatched and draws it as it is', () => {
    const prev = [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(10, 0, 0))];
    const cur = [mtx(1, matrix(1, 0, 0), CAMERA), mtx(2, matrix(11, 0, 0)), mtx(7, matrix(50, 0, 0))];
    const plan = planMotion(prev, cur);
    expect(plan.stats).toMatchObject({ threeD: 3, matched: 2, cut: false });
    expect(interpolate(plan, 0.5).map((m) => m.name).sort()).toEqual([1, 2]);
  });
});

describe('interpolation', () => {
  const prev = [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(100, 0, 0, 0, 1))];
  const cur = [mtx(1, matrix(10, 0, 0), CAMERA), mtx(2, matrix(120, 0, 40, Math.PI / 2, 1.8))];

  it('puts the matrix a fraction of the way between the two', () => {
    const plan = planMotion(prev, cur);
    const half = interpolate(plan, 0.5);
    const object = half.find((m) => m.name === 2)!;
    expect(object.m[12]).toBeCloseTo(110, 9);
    expect(object.m[14]).toBeCloseTo(20, 9);
    const pose = decompose(object.m);
    expect(pose.kind === 'pose' && pose.scale[1]).toBeCloseTo(1.4, 9);
    expect(pose.kind === 'pose' && quatAngle(pose.rotation, aboutY(0))).toBeCloseTo(Math.PI / 4, 9);
  });

  it('gives the previous frame at 0 and nothing to replace at 1', () => {
    const plan = planMotion(prev, cur);
    const start = interpolate(plan, 0).find((m) => m.name === 2)!;
    for (let i = 0; i < 16; i++) expect(start.m[i]).toBeCloseTo(prev[1]!.m[i]!, 9);
    expect(interpolate(plan, 1)).toEqual([]);
    expect(interpolate(plan, 1.5)).toEqual([]);
  });
});

describe('jumps', () => {
  it('a move within the limit is interpolated, a teleport is not', () => {
    const prev = [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(0, 0, 0))];
    const near = planMotion(prev, [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(MOTION_LIMITS.translation - 1, 0, 0))]);
    expect(near.stats.jumps).toBe(0);
    const far = planMotion(prev, [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(MOTION_LIMITS.translation + 1, 0, 0))]);
    expect(far.stats).toMatchObject({ matched: 2, jumps: 1, cut: false });
    expect(interpolate(far, 0.5).map((m) => m.name)).toEqual([1]);
  });

  it('a turn beyond the limit or a scale change beyond the limit is a jump', () => {
    const a = decompose(matrix(0, 0, 0, 0));
    expect(jumped(a, decompose(matrix(0, 0, 0, MOTION_LIMITS.rotation - 0.05)))).toBe(false);
    expect(jumped(a, decompose(matrix(0, 0, 0, MOTION_LIMITS.rotation + 0.05)))).toBe(true);
    expect(jumped(a, decompose(matrix(0, 0, 0, 0, 3.9)))).toBe(false);
    expect(jumped(a, decompose(matrix(0, 0, 0, 0, 4.2)))).toBe(true);
    expect(jumped(a, decompose(matrix(0, 0, 0, 0, 0.2)))).toBe(true);
  });

  it('a camera that moves too far makes the whole frame the current one', () => {
    const prev = [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(10, 0, 0))];
    const cur = [mtx(1, matrix(MOTION_LIMITS.cameraTranslation * 2, 0, 0), CAMERA), mtx(2, matrix(11, 0, 0))];
    const plan = planMotion(prev, cur);
    expect(plan.stats.cut).toBe(true);
    expect(interpolate(plan, 0.5)).toEqual([]);
  });

  it('a camera with no counterpart is a cut too', () => {
    const plan = planMotion([mtx(2, matrix(10, 0, 0))], [mtx(1, matrix(0, 0, 0), CAMERA), mtx(2, matrix(11, 0, 0))]);
    expect(plan.stats.cut).toBe(true);
  });

  it('a perspective matrix that changes shape completely is a jump, a zoom is not', () => {
    const projection = (fov: number) => Float64Array.of(fov, 0, 0, 0, 0, fov * 1.3, 0, 0, 0, 0, -1, -1, 0, 0, -20, 0);
    const flags = CAMERA | MatrixFlag.LOAD;
    const zoom = planMotion([mtx(1, projection(1.7), flags)], [mtx(1, projection(1.8), flags)]);
    expect(zoom.stats).toMatchObject({ jumps: 0, cut: false });
    const change = planMotion([mtx(1, projection(1.7), flags)], [mtx(1, projection(4), flags)]);
    expect(change.stats.cut).toBe(true);
  });
});

describe('2D work', () => {
  it('is counted apart and never replaced', () => {
    const flat = (key: number, x: number) => mtx(key, matrix(x, 0, 0), MatrixFlag.PROJECTION | MatrixFlag.LOAD);
    const hud = (key: number, x: number) => mtx(key, matrix(x, 0, 0), MatrixFlag.LOAD);
    const prev = [mtx(1, matrix(0, 0, 0), CAMERA), flat(8, 0), hud(9, 0), hud(10, 0)];
    const cur = [mtx(1, matrix(1, 0, 0), CAMERA), flat(8, 5), hud(9, 5), hud(10, 7)];
    const plan = planMotion(prev, cur);
    expect(plan.stats).toMatchObject({ threeD: 1, matched: 1, flat: 3 });
    expect(interpolate(plan, 0.5).map((m) => m.name)).toEqual([1]);
  });
});

describe('vertices the game writes itself', () => {
  it('shares the vertices of loads whose bytes are new', () => {
    const prev = [{ hash: 1, count: 30 }, { hash: 2, count: 10 }];
    const cur = [{ hash: 1, count: 30 }, { hash: 3, count: 10 }, { hash: 2, count: 20 }];
    expect(rewrittenShare(prev, cur)).toBeCloseTo(10 / 60, 12);
    expect(rewrittenShare(prev, [])).toBe(0);
  });
});

describe('timing', () => {
  it('starts at the previous frame when a game frame arrives and reaches it one game-frame interval later', () => {
    // Game frames at video frames 30 and 33 (PAL: every third retrace).
    expect(smoothFraction(33, 33, 30)).toBe(0);
    expect(smoothFraction(34.5, 33, 30)).toBeCloseTo(0.5, 12);
    expect(smoothFraction(36, 33, 30)).toBe(1);
    expect(smoothFraction(40, 33, 30)).toBe(1);
  });

  it('stays at 0 before the frame and copes with two frames in one video frame', () => {
    expect(smoothFraction(32, 33, 30)).toBe(0);
    expect(smoothFraction(34, 33, 33)).toBe(1);
  });
});
