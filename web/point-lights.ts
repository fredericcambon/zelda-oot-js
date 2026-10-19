// Point lights the port adds at torches and fires: which actors are sources, which lights a frame uses, and the maths the shader's world-position
// reconstruction relies on. The original game has no such lights; nothing here comes from its lighting data.
import type { CameraProjection } from '../tools/gfx/types.ts';
import { readActors } from '../tools/headless/actors.ts';
import { playState } from '../tools/headless/state.ts';
import { MAX_POINT_LIGHTS } from './shader.ts';

/**
 * Actor ids treated as light sources. Id 0x0008 (category 7) is the flame of the three wall torches at the top of the stairs in the Fire Temple's
 * first room, observed with the Actors tab's data: the three records stand at (-105, 260, -145), (0, 280, -140) and (105, 260, -145), and a
 * flame is drawn at each projected position (docs/re/actors.md, "Light sources"). Whether a record is lit is not proven, so every instance lights.
 */
export const LIGHT_ACTOR_IDS: ReadonlySet<number> = new Set([0x0008]);

/** Reach of a light in world units (Link stands about 60 high), and its height above the actor's origin. */
export const POINT_LIGHT_RADIUS = 160;
export const POINT_LIGHT_LIFT = 20;
/** Colour of the flame light (linear 0..1), and the contribution at strength 50 in the middle of the light. */
export const POINT_LIGHT_COLOR: readonly [number, number, number] = [1, 0.5, 0.18];
export const POINT_LIGHT_GAIN = 0.9;

export interface PointLight {
  x: number;
  y: number;
  z: number;
}

/** Inverse of a 4x4 matrix stored as sixteen values (row-major or column-major alike: the inverse of the transpose is the transpose of the inverse); null when singular. */
export function invert4(m: ArrayLike<number>): Float64Array | null {
  const a = m, inv = new Float64Array(16);
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  for (let i = 0; i < 16; i++) inv[i]! /= det;
  return inv;
}

/** The camera the frame's lights are drawn under: the projection most vertices were transformed under, with its inverse and the eye. */
export interface FrameCamera {
  /** Index of the projection among the run's cameras, 1-based as in the vertex data's flag. */
  slot: number;
  matrix: Float64Array;
  inverse: Float64Array;
  eye: [number, number, number];
}

/** Position of the eye: the world point whose clip-space w is 0 on the axis, found as the third row of the inverse (a row vector (0, 0, z, 0) times it). */
export function eyeOf(inverse: ArrayLike<number>): [number, number, number] {
  const w = inverse[11]!;
  return w === 0 ? [0, 0, 0] : [inverse[8]! / w, inverse[9]! / w, inverse[10]! / w];
}

export function frameCamera(cameras: readonly CameraProjection[] | undefined): FrameCamera | null {
  if (!cameras || cameras.length === 0) return null;
  let best = 0;
  cameras.forEach((c, i) => {
    if (c.vertices > cameras[best]!.vertices) best = i;
  });
  const matrix = cameras[best]!.matrix, inverse = invert4(matrix);
  return inverse ? { slot: best + 1, matrix, inverse, eye: eyeOf(inverse) } : null;
}

/** Clip-space w of a world position under a camera matrix (row vector times matrix). */
export const clipW = (m: ArrayLike<number>, p: PointLight): number => p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;

/**
 * The lights of a frame: the nearest `MAX_POINT_LIGHTS` to the eye, those behind the eye last. Each entry is (x, y, z, radius) for the
 * shader; colours are `lightColors`.
 */
export function pickLights(sources: readonly PointLight[], camera: FrameCamera): PointLight[] {
  const [ex, ey, ez] = camera.eye;
  const score = (p: PointLight) => Math.hypot(p.x - ex, p.y - ey, p.z - ez) + (clipW(camera.matrix, p) > 0 ? 0 : 1e6);
  return sources.map((p) => ({ p, s: score(p) })).sort((a, b) => a.s - b.s).slice(0, MAX_POINT_LIGHTS).map(({ p }) => ({ x: p.x, y: p.y + POINT_LIGHT_LIFT, z: p.z }));
}

/** Brightness factor of the light at index `i` at `seconds`: two incommensurate sines with a phase of its own, within about 0.85 to 1.15. */
export function flicker(i: number, seconds: number): number {
  const phase = i * 2.399;
  return 1 + 0.09 * Math.sin(seconds * 11.3 + phase) + 0.06 * Math.sin(seconds * 17.9 + phase * 1.7 + 1.3);
}

/** The shader's reconstruction of a world position from a fragment, in JS: `fragX`, `fragY` in window pixels, `depth` in 0..1, `fragW` = 1 / clip w. */
export function reconstruct(inverse: ArrayLike<number>, viewport: readonly [number, number, number, number], xyScale: number, fragX: number, fragY: number, depth: number, fragW: number): [number, number, number] {
  const w = 1 / fragW;
  const x = ((fragX - viewport[0]) / viewport[2] * 2 - 1) / xyScale * w, y = ((fragY - viewport[1]) / viewport[3] * 2 - 1) / xyScale * w, z = (depth * 2 - 1) * w;
  const h = [0, 1, 2, 3].map((c) => x * inverse[c]! + y * inverse[4 + c]! + z * inverse[8 + c]! + w * inverse[12 + c]!);
  return [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
}

/** The world positions of the light-source actors alive in the scene; none while no scene is loaded. */
export function lightSources(rd32: (addr: number) => number): PointLight[] {
  const play = playState(rd32);
  if (!play) return [];
  return readActors(rd32, play).flatMap((list) => list.actors.filter((a) => LIGHT_ACTOR_IDS.has(a.id)).map((a) => a.position));
}
