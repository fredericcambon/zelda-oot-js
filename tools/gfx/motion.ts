// Motion between two game frames: which matrix of a frame is which matrix of the previous one, and the matrices in
// between. The interpreter (runtime/gfx/dl.c) names every matrix command by where the display list loads it and records
// the matrices a run loads; replaying the run with replacement matrices draws the frame at another moment. Rotation is
// interpolated as a quaternion, translation and scale linearly; matrices of 2D work are never touched.

/** Bits of `MotionMatrix.flags` (GFX_MTX_* in runtime/gfx/gfx.h). */
export const MatrixFlag = { PROJECTION: 1, LOAD: 2, PUSH: 4, PERSPECTIVE: 8 } as const;

/** A matrix as a command loaded it: sixteen values row-major, for row vectors (a point is a row times the matrix). */
export interface MotionMatrix {
  /** Names where the display lists load the matrix, the same from frame to frame (see "Matrix identity" in runtime/gfx/dl.c). */
  name: number;
  /** Counts the loads of that name before this one in the frame; name and ordinal are unique within a frame. */
  ordinal: number;
  flags: number;
  /** Physical address the matrix was read from. */
  source: number;
  m: Float64Array;
}

/** A matrix to load in place of the one the command with this name and ordinal loads. */
export type MatrixOverride = Pick<MotionMatrix, 'name' | 'ordinal' | 'flags' | 'm'>;

/** A vertex load: a hash of the vertex bytes and how many vertices. */
export interface VertexLoad {
  hash: number;
  count: number;
}

/**
 * Where a matrix stops being the same matrix. The units are the game's own (a vertex coordinate; Link is about 56 tall,
 * runs about 6 per game frame and the fastest things in the forest move under 50). A camera is held to a tighter limit
 * than an object because every picture of a camera cut would otherwise slide: a camera is never meant to cover this much in
 * one game frame, an object that does is a teleport.
 */
export const MOTION_LIMITS = {
  /** Largest move of an object's matrix between two game frames that is still interpolated. */
  translation: 300,
  /** The same for the position of the camera. */
  cameraTranslation: 150,
  /** Largest turn (radians) of an object; the shortest way round is ambiguous beyond a half turn. */
  rotation: (2 * Math.PI) / 3,
  /** The same for the camera. */
  cameraRotation: Math.PI / 4,
  /** Largest change of a scale factor, as a ratio either way. */
  scale: 4,
  /** A matrix that is not a rotation, scale and translation (a perspective projection, a shear) may change by this share of its largest entry per entry. */
  shape: 0.5,
} as const;

// ---- Vectors and quaternions --------------------------------------------------------------------------------------

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

const quatDot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

function normalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n === 0 ? [0, 0, 0, 1] : [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** The angle in radians of the turn from `a` to `b` by the shortest way, 0 to pi. */
export function quatAngle(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))));
}

/** Spherical interpolation of unit quaternions (x, y, z, w) along the shortest arc. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = quatDot(a, b);
  const to: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  // Nearly parallel: the sine in the divisor vanishes and a normalised linear blend is the same to within rounding.
  if (d > 0.9995) return normalize([lerp(a[0], to[0], t), lerp(a[1], to[1], t), lerp(a[2], to[2], t), lerp(a[3], to[3], t)]);
  const theta = Math.acos(d);
  const sine = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sine, wb = Math.sin(t * theta) / sine;
  return [wa * a[0] + wb * to[0], wa * a[1] + wb * to[1], wa * a[2] + wb * to[2], wa * a[3] + wb * to[3]];
}

/** Quaternion of the rotation whose rows (as a row-vector matrix) are the unit vectors `r`. */
function quatFromRows(r: [Vec3, Vec3, Vec3]): Quat {
  // The column-vector matrix of the same rotation is the transpose: c[i][j] = r[j][i].
  const c00 = r[0][0], c01 = r[1][0], c02 = r[2][0];
  const c10 = r[0][1], c11 = r[1][1], c12 = r[2][1];
  const c20 = r[0][2], c21 = r[1][2], c22 = r[2][2];
  const trace = c00 + c11 + c22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(c21 - c12) / s, (c02 - c20) / s, (c10 - c01) / s, s / 4];
  } else if (c00 > c11 && c00 > c22) {
    const s = Math.sqrt(1 + c00 - c11 - c22) * 2;
    q = [s / 4, (c01 + c10) / s, (c02 + c20) / s, (c21 - c12) / s];
  } else if (c11 > c22) {
    const s = Math.sqrt(1 + c11 - c00 - c22) * 2;
    q = [(c01 + c10) / s, s / 4, (c12 + c21) / s, (c02 - c20) / s];
  } else {
    const s = Math.sqrt(1 + c22 - c00 - c11) * 2;
    q = [(c02 + c20) / s, (c12 + c21) / s, s / 4, (c10 - c01) / s];
  }
  return normalize(q);
}

/** The rows of the row-vector rotation matrix of a unit quaternion. */
function rowsFromQuat(q: Quat): [Vec3, Vec3, Vec3] {
  const [x, y, z, w] = q;
  const c = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ] as const;
  return [[c[0][0], c[1][0], c[2][0]], [c[0][1], c[1][1], c[2][1]], [c[0][2], c[1][2], c[2][2]]];
}

// ---- Poses ----------------------------------------------------------------------------------------------------------

/**
 * A matrix taken apart. `position` is the translation, or for a camera the eye: the point the view matrix sends to the
 * origin, so that turning the camera on the spot does not drag the translation of the view matrix along an arc.
 */
export interface Pose {
  kind: 'pose';
  camera: boolean;
  position: Vec3;
  scale: Vec3;
  rotation: Quat;
}

/** A matrix that is not a rotation, scale and translation: blended entry by entry. */
export interface Shape {
  kind: 'shape';
  m: Float64Array;
}

export type Blend = Pose | Shape;

const AXES_ORTHOGONAL = 0.01;
const UNIT_SCALE = 0.01;

/** Takes `m` apart into a pose, or returns a shape when it is a projection, a shear or degenerate. */
export function decompose(m: Float64Array, camera = false): Blend {
  const shape: Shape = { kind: 'shape', m };
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) return shape;
  const rows: Vec3[] = [[m[0]!, m[1]!, m[2]!], [m[4]!, m[5]!, m[6]!], [m[8]!, m[9]!, m[10]!]];
  const scale: Vec3 = [Math.hypot(...rows[0]!), Math.hypot(...rows[1]!), Math.hypot(...rows[2]!)];
  if (scale.some((s) => !(s > 1e-6))) return shape;
  const axes = rows.map((r, i) => r.map((v) => v / scale[i]!) as Vec3) as [Vec3, Vec3, Vec3];
  if (Math.abs(dot3(axes[0], axes[1])) > AXES_ORTHOGONAL || Math.abs(dot3(axes[0], axes[2])) > AXES_ORTHOGONAL || Math.abs(dot3(axes[1], axes[2])) > AXES_ORTHOGONAL) return shape;
  // A mirror shows as a left-handed frame: fold it into the first scale factor so the axes stay a rotation.
  if (dot3(axes[0], cross3(axes[1], axes[2])) < 0) {
    axes[0] = [-axes[0][0], -axes[0][1], -axes[0][2]];
    scale[0] = -scale[0];
  }
  const translation: Vec3 = [m[12]!, m[13]!, m[14]!];
  const asCamera = camera && scale.every((s) => Math.abs(s - 1) < UNIT_SCALE);
  // p' = p R + t is zero at p = -t R^T.
  const position: Vec3 = asCamera ? [-dot3(translation, axes[0]), -dot3(translation, axes[1]), -dot3(translation, axes[2])] : translation;
  return { kind: 'pose', camera: asCamera, position, scale, rotation: quatFromRows(axes) };
}

/** The matrix of a pose, or of a shape, which is its own matrix. */
export function compose(b: Blend): Float64Array {
  if (b.kind === 'shape') return b.m;
  const axes = rowsFromQuat(b.rotation);
  const m = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) m[i * 4 + k] = b.scale[i]! * axes[i]![k]!;
  const p = b.position;
  // t = -e R, with R the rows scaled by 1 (a camera has unit scale).
  const t: Vec3 = b.camera ? [-(p[0] * axes[0][0] + p[1] * axes[1][0] + p[2] * axes[2][0]), -(p[0] * axes[0][1] + p[1] * axes[1][1] + p[2] * axes[2][1]), -(p[0] * axes[0][2] + p[1] * axes[1][2] + p[2] * axes[2][2])] : p;
  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

/** Whether `to` is too far from `from` to be taken for the same thing moved: a teleport, a camera cut, a pop. */
export function jumped(from: Blend, to: Blend): boolean {
  if (from.kind === 'shape' || to.kind === 'shape') {
    if (from.kind !== 'shape' || to.kind !== 'shape') return true;
    for (let i = 0; i < 16; i++) {
      const a = from.m[i]!, b = to.m[i]!;
      if (Math.abs(b - a) > MOTION_LIMITS.shape * Math.max(Math.abs(a), Math.abs(b)) && Math.abs(b - a) > 0.05) return true;
    }
    return false;
  }
  if (from.camera !== to.camera) return true;
  const limits = to.camera ? [MOTION_LIMITS.cameraTranslation, MOTION_LIMITS.cameraRotation] as const : [MOTION_LIMITS.translation, MOTION_LIMITS.rotation] as const;
  if (distance3(from.position, to.position) > limits[0]) return true;
  if (quatAngle(from.rotation, to.rotation) > limits[1]) return true;
  for (let i = 0; i < 3; i++) {
    const a = from.scale[i]!, b = to.scale[i]!;
    if (a * b <= 0) return true;
    const ratio = b / a;
    if (ratio > MOTION_LIMITS.scale || ratio < 1 / MOTION_LIMITS.scale) return true;
  }
  return false;
}

/** The blend a fraction `t` of the way from `from` to `to`; both must be of the same kind. */
export function blend(from: Blend, to: Blend, t: number): Float64Array {
  if (from.kind === 'shape' || to.kind === 'shape') {
    const a = (from as Shape).m, b = (to as Shape).m;
    return Float64Array.from(a, (v, i) => lerp(v, b[i]!, t));
  }
  return compose({
    kind: 'pose',
    camera: to.camera,
    position: lerp3(from.position, to.position, t),
    scale: lerp3(from.scale, to.scale, t),
    rotation: slerp(from.rotation, to.rotation, t),
  });
}

// ---- Matching and planning --------------------------------------------------------------------------------------------

const KIND_BITS = MatrixFlag.PROJECTION | MatrixFlag.LOAD | MatrixFlag.PUSH | MatrixFlag.PERSPECTIVE;

/** Whether a matrix belongs to 3D work. Matrices loaded under an orthographic projection (the HUD, text, the 2D backgrounds) do not. */
export const isThreeD = (m: MotionMatrix): boolean => (m.flags & MatrixFlag.PERSPECTIVE) !== 0;

/** A matrix of the projection stack under a perspective projection: the camera. */
export const isCamera = (m: MotionMatrix): boolean => isThreeD(m) && (m.flags & MatrixFlag.PROJECTION) !== 0;

const squaredDistance = (a: Float64Array, b: Float64Array): number => {
  let d = 0;
  for (let i = 0; i < 16; i++) d += (a[i]! - b[i]!) ** 2;
  return d;
};

const group = (list: readonly MotionMatrix[]): Map<number, MotionMatrix[]> => {
  const groups = new Map<number, MotionMatrix[]>();
  for (const m of list) {
    const g = groups.get(m.name);
    if (g) g.push(m);
    else groups.set(m.name, [m]);
  }
  for (const g of groups.values()) g.sort((x, y) => x.ordinal - y.ordinal);
  return groups;
};

/**
 * For each matrix of `cur`, the matrix of `prev` that is the same one, or null. Matrices pair by name; of the matrices that
 * share a name (one limb list drawn for several actors) those in equal numbers pair in order, and when the numbers differ
 * (an actor appeared or went away) the closest pairs go first, so that the ones that stayed keep their partners and the ones
 * left over stay unmatched.
 */
export function matchFrames(prev: readonly MotionMatrix[], cur: readonly MotionMatrix[]): (MotionMatrix | null)[] {
  const before = group(prev);
  const partner = new Map<MotionMatrix, MotionMatrix>();
  for (const [name, now] of group(cur)) {
    const old = before.get(name);
    if (!old) continue;
    if (old.length === now.length) {
      now.forEach((m, i) => partner.set(m, old[i]!));
      continue;
    }
    const pairs = old.flatMap((p) => now.map((m) => ({ p, m, d: squaredDistance(p.m, m.m) }))).sort((x, y) => x.d - y.d);
    const taken = new Set<MotionMatrix>();
    for (const { p, m } of pairs) {
      if (taken.has(p) || partner.has(m)) continue;
      taken.add(p);
      partner.set(m, p);
    }
  }
  return cur.map((m) => {
    const p = partner.get(m);
    return p && (p.flags & KIND_BITS) === (m.flags & KIND_BITS) ? p : null;
  });
}

export interface MotionStats {
  /** Matrices of 3D work in the current frame. */
  threeD: number;
  /** Of those, the ones with a counterpart in the previous frame. */
  matched: number;
  /** Matched ones that moved too far to be interpolated. */
  jumps: number;
  /** Matrices of 2D work, which are never interpolated. */
  flat: number;
  /** The camera changed too much (or has no counterpart): nothing is interpolated. */
  cut: boolean;
}

interface Entry {
  name: number;
  ordinal: number;
  flags: number;
  from: Blend;
  to: Blend;
}

export interface MotionPlan {
  stats: MotionStats;
  /** Matrices that move between the two frames. */
  entries: Entry[];
}

/** Matches the matrices of two consecutive game frames and decides which are interpolated. */
export function planMotion(prev: readonly MotionMatrix[], cur: readonly MotionMatrix[]): MotionPlan {
  const stats: MotionStats = { threeD: 0, matched: 0, jumps: 0, flat: 0, cut: false };
  const entries: Entry[] = [];
  const counterparts = matchFrames(prev, cur);
  cur.forEach((m, i) => {
    if (!isThreeD(m)) {
      stats.flat++;
      return;
    }
    stats.threeD++;
    const p = counterparts[i];
    if (!p) {
      if (isCamera(m)) stats.cut = true;
      return;
    }
    stats.matched++;
    // The matrix a view is multiplied into the projection with is the camera's pose; the perspective matrix itself is a shape.
    const camera = isCamera(m) && (m.flags & MatrixFlag.LOAD) === 0;
    const from = decompose(p.m, camera), to = decompose(m.m, camera);
    if (jumped(from, to)) {
      stats.jumps++;
      if (isCamera(m)) stats.cut = true;
      return;
    }
    entries.push({ name: m.name, ordinal: m.ordinal, flags: m.flags, from, to });
  });
  return { stats, entries };
}

/** The replacement matrices for the picture a fraction `t` (0 = previous frame, 1 = current) of the way between the two; none when it is the current frame. */
export function interpolate(plan: MotionPlan, t: number): MatrixOverride[] {
  if (plan.stats.cut || !(t < 1)) return [];
  const f = Math.max(0, t);
  return plan.entries.map((e) => ({ name: e.name, ordinal: e.ordinal, flags: e.flags, m: blend(e.from, e.to, f) }));
}

// ---- Reading and writing the interpreter's records ------------------------------------------------------------------

/** The interpreter's exports for motion (runtime/gfx/gfx.h). */
export interface MotionCore {
  HEAPU8: Uint8Array;
  _gfx_layout(what: number): number;
  _gfx_motion_record(on: number): void;
  _gfx_motion_count(): number;
  _gfx_motion_matrices(): number;
  _gfx_motion_vertex_load_count(): number;
  _gfx_motion_vertex_loads(): number;
  _gfx_motion_input(n: number): number;
  _gfx_motion_commit(n: number): void;
}

/** Words and doubles of a GfxMatrix: name (2 words), flags, ordinal, source, a spare word, then sixteen doubles. */
const MATRIX_WORDS = 38;
const MATRIX_DOUBLES = 19;
const MATRIX_HEADER_DOUBLES = 3;

const checked = new WeakSet<MotionCore>();

function checkLayout(core: MotionCore): void {
  if (checked.has(core)) return;
  if (core._gfx_layout(6) !== MATRIX_WORDS || core._gfx_layout(7) !== 2) throw new Error('the motion records of the interpreter are not the size the reader expects');
  checked.add(core);
}

/** Copies out the matrices of the last run made with recording on. */
export function readMatrices(core: MotionCore): MotionMatrix[] {
  checkLayout(core);
  const n = core._gfx_motion_count();
  if (n === 0) return [];
  const at = core._gfx_motion_matrices();
  const buffer = core.HEAPU8.buffer as ArrayBuffer;
  const words = new Uint32Array(buffer, at, n * MATRIX_WORDS);
  const doubles = new Float64Array(buffer, at, n * MATRIX_DOUBLES);
  return Array.from({ length: n }, (_, i) => ({
    name: words[i * MATRIX_WORDS + 1]! * 2 ** 32 + words[i * MATRIX_WORDS]!,
    ordinal: words[i * MATRIX_WORDS + 3]!,
    flags: words[i * MATRIX_WORDS + 2]!,
    source: words[i * MATRIX_WORDS + 4]!,
    m: doubles.slice(i * MATRIX_DOUBLES + MATRIX_HEADER_DOUBLES, (i + 1) * MATRIX_DOUBLES),
  }));
}

/** Copies out the vertex loads of the last run made with recording on. */
export function readVertexLoads(core: MotionCore): VertexLoad[] {
  const n = core._gfx_motion_vertex_load_count();
  if (n === 0) return [];
  const words = new Uint32Array(core.HEAPU8.buffer as ArrayBuffer, core._gfx_motion_vertex_loads(), n * 2);
  return Array.from({ length: n }, (_, i) => ({ hash: words[i * 2]!, count: words[i * 2 + 1]! }));
}

/** Makes the runs that follow load `matrices` in place of the matrices of the commands with the same names; an empty list clears it. */
export function writeOverrides(core: MotionCore, matrices: readonly MatrixOverride[]): void {
  checkLayout(core);
  const n = matrices.length;
  if (n === 0) {
    core._gfx_motion_commit(0);
    return;
  }
  const at = core._gfx_motion_input(n);
  const buffer = core.HEAPU8.buffer as ArrayBuffer;
  const words = new Uint32Array(buffer, at, n * MATRIX_WORDS);
  const doubles = new Float64Array(buffer, at, n * MATRIX_DOUBLES);
  matrices.forEach((m, i) => {
    words[i * MATRIX_WORDS] = m.name % 2 ** 32;
    words[i * MATRIX_WORDS + 1] = Math.floor(m.name / 2 ** 32);
    words[i * MATRIX_WORDS + 2] = m.flags;
    words[i * MATRIX_WORDS + 3] = m.ordinal;
    doubles.set(m.m, i * MATRIX_DOUBLES + MATRIX_HEADER_DOUBLES);
  });
  core._gfx_motion_commit(n);
}

/**
 * The share of the vertices of `cur` loaded from bytes that no load of `prev` had: vertices the game wrote anew rather than
 * moved by a matrix (skinned limbs, water, effects), which are drawn as in the current frame whatever the matrices do.
 */
export function rewrittenShare(prev: readonly VertexLoad[], cur: readonly VertexLoad[]): number {
  const seen = new Set(prev.map((l) => l.hash));
  let total = 0, rewritten = 0;
  for (const l of cur) {
    total += l.count;
    if (!seen.has(l.hash)) rewritten += l.count;
  }
  return total === 0 ? 0 : rewritten / total;
}

/** Keeps the matrices of the last game frame and plans the motion into each new one. */
export class MotionTracker {
  private last: MotionMatrix[] | null = null;
  private lastLoads: VertexLoad[] | null = null;
  plan: MotionPlan | null = null;
  /** Share of the current frame's vertices that the game wrote itself; 0 until there are two frames. */
  rewritten = 0;

  /** Takes the record of the run that just finished as the new current frame. */
  push(core: MotionCore): MotionPlan | null {
    const matrices = readMatrices(core), loads = readVertexLoads(core);
    this.plan = this.last ? planMotion(this.last, matrices) : null;
    this.rewritten = this.lastLoads ? rewrittenShare(this.lastLoads, loads) : 0;
    this.last = matrices;
    this.lastLoads = loads;
    return this.plan;
  }

  /** Forgets the previous frame, so that the next one is drawn as it is. */
  reset(): void {
    this.last = this.lastLoads = this.plan = null;
    this.rewritten = 0;
  }
}
