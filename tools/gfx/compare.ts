// Compares two display-list results (the TypeScript interpreter's and the wasm module's) and lists every difference.
// Floats compare by their bit patterns: a -0 or a last-bit rounding difference is a difference.
import { createHash } from 'node:crypto';
import type { Batch, DisplayListResult, DrawState, TriangleBatch } from './dl.ts';

const bits = (a: Float32Array): Uint32Array => new Uint32Array(a.buffer, a.byteOffset, a.length);

const digests = new WeakMap<Uint8Array, string>();

function digest(bytes: Uint8Array): string {
  let d = digests.get(bytes);
  if (d === undefined) {
    d = createHash('sha1').update(bytes).digest('hex');
    digests.set(bytes, d);
  }
  return d;
}

/** Every number of a state in a fixed order (the images apart). */
function flatten(s: DrawState): number[] {
  const o: number[] = [s.geometryMode, s.otherModeH, s.otherModeL, ...s.combine.raw];
  for (const c of s.combine.cycles) o.push(...c.rgb, ...c.alpha);
  const p = s.primColor;
  o.push(p.r, p.g, p.b, p.a, p.minLod, p.lodFrac);
  for (const c of [s.envColor, s.fogColor, s.blendColor]) o.push(c.r, c.g, c.b, c.a);
  const t = s.texture;
  o.push(s.fillColor, t.on ? 1 : 0, t.level, t.tile, t.scaleS, t.scaleT);
  for (const f of s.tiles) {
    o.push(f.fmt, f.siz, f.line, f.tmem, f.palette, f.cmT, f.maskT, f.shiftT, f.cmS, f.maskS, f.shiftS, f.uls, f.ult, f.lrs, f.lrt, f.sized ? 1 : 0);
  }
  o.push(...s.viewport.scale, ...s.viewport.trans, s.scissor.mode, s.scissor.xh, s.scissor.yh, s.scissor.xl, s.scissor.yl);
  o.push(s.colorImage.fmt, s.colorImage.siz, s.colorImage.width, s.colorImage.addr, s.depthImage);
  for (const img of s.textures) o.push(img ? 1 : 0, img?.width ?? 0, img?.height ?? 0, img?.tile ?? 0, img?.rgba.length ?? 0);
  return o;
}

/** Where two states differ, or undefined when they are the same (images are compared by their pixels). */
function diffStates(e: DrawState, a: DrawState): string | undefined {
  const x = flatten(e), y = flatten(a);
  const at = x.findIndex((v, i) => v !== y[i]);
  if (at >= 0) return `number ${at} of the state is ${x[at]} vs ${y[at]}`;
  for (let i = 0; i < 2; i++) {
    const p = e.textures[i], q = a.textures[i];
    if (p && q && digest(p.rgba) !== digest(q.rgba)) return `pixels of image ${i} differ`;
  }
  return undefined;
}

function sameFloats(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -2;
  const x = bits(a), y = bits(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i;
  return -1;
}

const FLOAT_FIELDS = ['positions', 'colors', 'uvs'] as const;

/** Differences between an expected and an actual result; empty when they are identical. */
export function diffResults(expected: DisplayListResult, actual: DisplayListResult, limit = 10): string[] {
  const out: string[] = [];
  const note = (message: string): boolean => {
    out.push(message);
    return out.length >= limit;
  };
  if (expected.commands !== actual.commands && note(`commands ${expected.commands} vs ${actual.commands}`)) return out;
  if (JSON.stringify([...expected.opcodes]) !== JSON.stringify([...actual.opcodes]) && note(`opcode counts differ: ${JSON.stringify([...expected.opcodes])} vs ${JSON.stringify([...actual.opcodes])}`)) return out;
  if (JSON.stringify(expected.unknown) !== JSON.stringify(actual.unknown) && note(`unknown commands differ: ${JSON.stringify(expected.unknown.slice(0, 3))} vs ${JSON.stringify(actual.unknown.slice(0, 3))}`)) return out;
  if (JSON.stringify(expected.problems) !== JSON.stringify(actual.problems) && note(`problems differ: ${JSON.stringify(expected.problems.slice(0, 3))} vs ${JSON.stringify(actual.problems.slice(0, 3))}`)) return out;
  if (expected.batches.length !== actual.batches.length) {
    note(`${expected.batches.length} batches vs ${actual.batches.length}`);
    return out;
  }
  for (let i = 0; i < expected.batches.length; i++) {
    const e: Batch = expected.batches[i]!, a: Batch = actual.batches[i]!;
    if (e.kind !== a.kind) {
      if (note(`batch ${i}: ${e.kind} vs ${a.kind}`)) return out;
      continue;
    }
    if (e.kind === 'triangles') {
      for (const field of FLOAT_FIELDS) {
        const at = sameFloats(e[field], (a as TriangleBatch)[field]);
        if (at !== -1 && note(`batch ${i} ${field}: ${at === -2 ? `length ${e[field].length} vs ${(a as TriangleBatch)[field].length}` : `element ${at} is ${e[field][at]} vs ${(a as TriangleBatch)[field][at]}`}`)) return out;
      }
    } else {
      for (const field of ['xl', 'yl', 'xh', 'yh', 'tile', 's', 't', 'dsdx', 'dtdy'] as const) {
        if (e[field] !== (a as typeof e)[field] && note(`batch ${i} ${field}: ${e[field]} vs ${(a as typeof e)[field]}`)) return out;
      }
    }
    const why = diffStates(e.state, a.state);
    if (why !== undefined && note(`batch ${i} state: ${why}`)) return out;
  }
  return out;
}
