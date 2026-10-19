// Groups the batches of one graphics task into runs that one WebGL draw call can cover, without changing the order of anything drawn.
import type { Batch, DrawState, LightSet, RectBatch, TileState, TriangleBatch } from '../tools/gfx/types.ts';
import { CycleType, cycleTypeOf, specKey, specOf } from './shader.ts';

export interface FillRun {
  kind: 'fill';
  batch: RectBatch;
}

export interface DrawRun {
  kind: 'draw';
  /** State of the first batch; every batch of the run draws the same as it. */
  state: DrawState;
  /** Triangles use the viewport and depth buffer; rectangles are drawn in screen space. */
  triangles: boolean;
  batches: (TriangleBatch | RectBatch)[];
  /** Triangles to light per pixel: the light set every batch of the run shares; null for the vertex path. */
  lights: LightSet | null;
}

export type Run = FillRun | DrawRun;

export const isFill = (b: Batch): b is RectBatch => b.kind === 'fillrect' && cycleTypeOf(b.state.otherModeH) === CycleType.FILL;

const specKeys = new WeakMap<DrawState, string>();
const specKeyOf = (s: DrawState): string => {
  let key = specKeys.get(s);
  if (key === undefined) specKeys.set(s, (key = specKey(specOf(s))));
  return key;
};

const sameFields = (a: object, b: object): boolean => {
  const x = a as Record<string, number>, y = b as Record<string, number>;
  for (const k in x) if (x[k] !== y[k]) return false;
  return true;
};

const sameTile = (a: TileState, b: TileState): boolean =>
  a.uls === b.uls && a.ult === b.ult && a.maskS === b.maskS && a.maskT === b.maskT && a.cmS === b.cmS && a.cmT === b.cmT && a.shiftS === b.shiftS && a.shiftT === b.shiftT;

/** Whether two states give a draw the same program, uniforms, textures and raster state. */
export function sameDrawState(a: DrawState, b: DrawState): boolean {
  if (a === b) return true;
  if (a.geometryMode !== b.geometryMode || a.otherModeH !== b.otherModeH || a.otherModeL !== b.otherModeL) return false;
  if ((a.colorImage.addr & 0x1fffffff) !== (b.colorImage.addr & 0x1fffffff)) return false;
  if (!sameFields(a.primColor, b.primColor) || !sameFields(a.envColor, b.envColor) || !sameFields(a.fogColor, b.fogColor) || !sameFields(a.blendColor, b.blendColor)) return false;
  if (!sameFields(a.scissor, b.scissor) || !a.viewport.scale.every((v, i) => v === b.viewport.scale[i]) || !a.viewport.trans.every((v, i) => v === b.viewport.trans[i])) return false;
  for (let i = 0; i < 2; i++) {
    const x = a.textures[i], y = b.textures[i];
    if (!x || !y) {
      if (x !== y) return false;
      continue;
    }
    if (x.id !== y.id || !sameTile(a.tiles[x.tile]!, b.tiles[y.tile]!)) return false;
  }
  return specKeyOf(a) === specKeyOf(b);
}

const sameLights = (a: LightSet | undefined, b: LightSet | undefined): boolean =>
  a === b || (!!a && !!b && a.count === b.count && a.ambient.every((v, i) => v === b.ambient[i]) && a.colors.every((v, i) => v === b.colors[i]) && a.dirs.every((v, i) => v === b.dirs[i]));

const lightsOf = (b: TriangleBatch | RectBatch): LightSet | undefined => (b.kind === 'triangles' ? b.lights : undefined);

/** Consecutive drawable batches with the same state, target and light set become one run; a fill or a state change ends it. */
export function mergeRuns(batches: readonly Batch[]): Run[] {
  const runs: Run[] = [];
  let open: DrawRun | null = null;
  for (const batch of batches) {
    if (isFill(batch)) {
      runs.push({ kind: 'fill', batch });
      open = null;
      continue;
    }
    const triangles = batch.kind === 'triangles';
    if (triangles && batch.positions.length === 0) continue;
    if (open && open.triangles === triangles && sameDrawState(open.state, batch.state) && sameLights(open.lights ?? undefined, lightsOf(batch))) open.batches.push(batch);
    else runs.push((open = { kind: 'draw', state: batch.state, triangles, batches: [batch], lights: lightsOf(batch) ?? null }));
  }
  return runs;
}
