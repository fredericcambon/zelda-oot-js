// A software renderer for the draw batches of the display-list interpreter (types.ts), used to dump frames without a browser. It follows the same
// rules as the WebGL path (web/shader.ts, web/renderer.ts).
import type { Batch, DecodedTexture, DisplayListResult, DrawState, RectBatch, TileState, TriangleBatch } from './types.ts';
import { Geo } from './opcodes.ts';
import { offscreenRegions, writeRegion } from './offscreen.ts';
import { CycleType, cycleTypeOf, MIN_COVERAGE_ALPHA, OtherL, shiftScale, specOf, type BlendCycle, type ShaderSpec } from '../../web/shader.ts';

export const WIDTH = 320;
export const HEIGHT = 240;

type V3 = [number, number, number];

interface Vertex {
  pos: [number, number, number, number];
  color: [number, number, number, number];
  uv: [number, number];
}

interface Inputs {
  combined: V3;
  combinedA: number;
  t0: [number, number, number, number];
  t1: [number, number, number, number];
  shade: V3;
  shadeA: number;
  prim: [number, number, number, number];
  env: [number, number, number, number];
  primLod: number;
}

const physical = (addr: number): number => addr & 0x1fffffff;
/** Depth (of -1..1) a decal may sit behind the surface under it however flat its triangle is. */
const DECAL_MIN_BIAS = 1e-6;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const unit = (c: { r: number; g: number; b: number; a: number }): [number, number, number, number] => [c.r / 255, c.g / 255, c.b / 255, c.a / 255];

function rgbBase(c: number, i: Inputs): V3 | null {
  switch (c) {
    case 0: return i.combined;
    case 1: return [i.t0[0], i.t0[1], i.t0[2]];
    case 2: return [i.t1[0], i.t1[1], i.t1[2]];
    case 3: return [i.prim[0], i.prim[1], i.prim[2]];
    case 4: return i.shade;
    case 5: return [i.env[0], i.env[1], i.env[2]];
    default: return null;
  }
}

const gray = (v: number): V3 => [v, v, v];

function rgbInput(slot: number, code: number, i: Inputs): V3 {
  if (slot === 2) {
    if (code < 6) return rgbBase(code, i)!;
    switch (code) {
      case 7: return gray(i.combinedA);
      case 8: return gray(i.t0[3]);
      case 9: return gray(i.t1[3]);
      case 10: return gray(i.prim[3]);
      case 11: return gray(i.shadeA);
      case 12: return gray(i.env[3]);
      case 14: return gray(i.primLod);
      default: return [0, 0, 0];
    }
  }
  if (code === 6) return slot === 1 ? [0, 0, 0] : [1, 1, 1];
  if (code === 7 && slot === 0) return [0.5, 0.5, 0.5];
  return (code < 6 ? rgbBase(code, i) : null) ?? [0, 0, 0];
}

function alphaInput(slot: number, code: number, i: Inputs): number {
  if (slot === 2) {
    switch (code) {
      case 1: return i.t0[3];
      case 2: return i.t1[3];
      case 3: return i.prim[3];
      case 4: return i.shadeA;
      case 5: return i.env[3];
      case 6: return i.primLod;
      default: return 0;
    }
  }
  switch (code) {
    case 0: return i.combinedA;
    case 1: return i.t0[3];
    case 2: return i.t1[3];
    case 3: return i.prim[3];
    case 4: return i.shadeA;
    case 5: return i.env[3];
    case 6: return 1;
    default: return 0;
  }
}

function wrap(v: number, size: number, mask: number, mode: number): number {
  if (mode >= 2) v = Math.min(Math.max(v, 0), size - 1);
  if (mask > 0) {
    const period = 1 << mask;
    if (mode & 1) {
      const m = ((v % (2 * period)) + 2 * period) % (2 * period);
      v = m >= period ? 2 * period - 1 - m : m;
    } else v = ((v % period) + period) % period;
  }
  return Math.min(Math.max(v, 0), size - 1);
}

type Rgba = [number, number, number, number];

function fetchTexel(tex: DecodedTexture, tile: TileState, s: number, t: number): Rgba {
  const x = wrap(s, tex.width, tile.maskS, tile.cmS), y = wrap(t, tex.height, tile.maskT, tile.cmT);
  const o = (y * tex.width + x) * 4;
  return [tex.rgba[o]! / 255, tex.rgba[o + 1]! / 255, tex.rgba[o + 2]! / 255, tex.rgba[o + 3]! / 255];
}

/** Samples a tile at texel coordinates (u, v): the nearest texel, or the console's three-point filter when `bilerp`. */
function texel(tex: DecodedTexture | null, tile: TileState | undefined, u: number, v: number, bilerp: boolean): Rgba {
  if (!tex || !tile) return [1, 1, 1, 1];
  const s = u * shiftScale(tile.shiftS) - tile.uls / 4;
  const t = v * shiftScale(tile.shiftT) - tile.ult / 4;
  if (!bilerp) return fetchTexel(tex, tile, Math.floor(s), Math.floor(t));
  const sx = s - 0.5, sy = t - 0.5;
  const bx = Math.floor(sx), by = Math.floor(sy);
  const fx = sx - bx, fy = sy - by;
  const c00 = fetchTexel(tex, tile, bx, by);
  const out: Rgba = [0, 0, 0, 0];
  if (fx + fy <= 1) {
    const c10 = fetchTexel(tex, tile, bx + 1, by), c01 = fetchTexel(tex, tile, bx, by + 1);
    for (let k = 0; k < 4; k++) out[k] = c00[k]! + fx * (c10[k]! - c00[k]!) + fy * (c01[k]! - c00[k]!);
  } else {
    const c11 = fetchTexel(tex, tile, bx + 1, by + 1), c01 = fetchTexel(tex, tile, bx, by + 1), c10 = fetchTexel(tex, tile, bx + 1, by);
    for (let k = 0; k < 4; k++) out[k] = c11[k]! + (1 - fx) * (c01[k]! - c11[k]!) + (1 - fy) * (c10[k]! - c11[k]!);
  }
  return out;
}

export class SoftRenderer {
  /** Colour images by physical address, RGBA8, top row first. */
  readonly images = new Map<number, Uint8Array>();
  /** Pixels written since construction (a rejected or culled primitive writes none). */
  pixelsWritten = 0;
  cullMode: 'normal' | 'swapped' | 'off' = 'normal';
  private readonly depth = new Float32Array(WIDTH * HEIGHT).fill(1);
  /** The colour images the video interface has scanned out. */
  private readonly screens = new Set<number>();

  /**
   * Draws the batches of one graphics task. With `memory` (the guest's RDRAM, indexed by physical address) the colour images that are not
   * screens are copied into it afterwards, as the RDP leaves them there for the game to read (tools/gfx/offscreen.ts).
   */
  drawTask(result: DisplayListResult, memory?: Uint8Array): void {
    for (const b of result.batches) this.drawBatch(b);
    if (!memory) return;
    for (const region of offscreenRegions(result.batches, (addr) => this.screens.has(addr))) {
      const img = this.images.get(region.addr)!;
      const w = region.x1 - region.x0;
      const rgba = new Uint8Array(w * (region.y1 - region.y0) * 4);
      for (let y = region.y0; y < region.y1; y++) rgba.set(img.subarray((y * WIDTH + region.x0) * 4, (y * WIDTH + region.x1) * 4), (y - region.y0) * w * 4);
      writeRegion(memory, region, rgba);
    }
  }

  /** Notes that the video interface scans out the colour image at `address`. */
  present(address: number): void {
    this.screens.add(physical(address));
  }

  /** The image at `address`, or null when none was drawn there (and for 0, the blanked screen). */
  image(address: number): Uint8Array | null {
    return this.images.get(physical(address)) ?? null;
  }

  private target(address: number): Uint8Array {
    const key = physical(address);
    let img = this.images.get(key);
    if (!img) {
      img = new Uint8Array(WIDTH * HEIGHT * 4);
      for (let i = 3; i < img.length; i += 4) img[i] = 255;
      this.images.set(key, img);
    }
    return img;
  }

  /** The state with the textures that the game loaded from a colour image drawn into earlier replaced by that image's pixels. */
  private sampled(state: DrawState): DrawState {
    if (!state.textures.some((t) => t?.source)) return state;
    const textures = state.textures.map((t) => {
      const image = t?.source ? this.images.get(t.source.addr) : undefined;
      if (!t || !t.source || !image || t.source.x + t.width > WIDTH || t.source.y + t.height > HEIGHT) return t;
      const rgba = new Uint8Array(t.width * t.height * 4);
      for (let y = 0; y < t.height; y++) rgba.set(image.subarray(((t.source.y + y) * WIDTH + t.source.x) * 4, ((t.source.y + y) * WIDTH + t.source.x + t.width) * 4), y * t.width * 4);
      return { ...t, rgba, loaded: null };
    }) as DrawState['textures'];
    return { ...state, textures };
  }

  private drawBatch(drawn: Batch): void {
    const state = this.sampled(drawn.state);
    const b = state === drawn.state ? drawn : ({ ...drawn, state } as Batch);
    const img = this.target(state.colorImage.addr);
    if (b.kind === 'triangles') this.triangles(b, img);
    else if (b.kind === 'fillrect' && cycleTypeOf(state.otherModeH) === CycleType.FILL) this.fill(b, img);
    else this.rect(b, img);
  }

  private scissor(state: DrawState): [number, number, number, number] {
    const sc = state.scissor;
    if (sc.xl === 0 && sc.yl === 0) return [0, 0, WIDTH, HEIGHT];
    return [Math.max(0, sc.xh >> 2), Math.max(0, sc.yh >> 2), Math.min(WIDTH, sc.xl >> 2), Math.min(HEIGHT, sc.yl >> 2)];
  }

  private fill(b: RectBatch, img: Uint8Array): void {
    const [sx0, sy0, sx1, sy1] = this.scissor(b.state);
    const x0 = Math.max(sx0, b.xh >> 2), y0 = Math.max(sy0, b.yh >> 2);
    const x1 = Math.min(sx1, (b.xl >> 2) + 1), y1 = Math.min(sy1, (b.yl >> 2) + 1);
    const toDepth = physical(b.state.colorImage.addr) === physical(b.state.depthImage);
    const f = b.state.fillColor >>> 0;
    let rgb: V3;
    if (b.state.colorImage.siz === 3) rgb = [(f >>> 24) & 255, (f >>> 16) & 255, (f >>> 8) & 255];
    else {
      const px = f >>> 16;
      rgb = [(((px >>> 11) & 31) * 255) / 31, (((px >>> 6) & 31) * 255) / 31, (((px >>> 1) & 31) * 255) / 31];
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (toDepth) this.depth[y * WIDTH + x] = 1;
        else img.set([Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), 255], (y * WIDTH + x) * 4);
      }
    }
  }

  private rect(b: RectBatch, img: Uint8Array): void {
    const state = b.state;
    const spec = specOf(state);
    const type = cycleTypeOf(state.otherModeH);
    const inclusive = type >= CycleType.COPY ? 1 : 0;
    const [sx0, sy0, sx1, sy1] = this.scissor(state);
    const x0 = b.xh / 4, y0 = b.yh / 4;
    const x1 = Math.min(sx1, Math.ceil(b.xl / 4) + inclusive), y1 = Math.min(sy1, Math.ceil(b.yl / 4) + inclusive);
    const stepS = b.dsdx / 1024 / (type === CycleType.COPY ? 4 : 1), stepT = b.dtdy / 1024;
    for (let y = Math.max(sy0, Math.floor(y0)); y < y1; y++) {
      for (let x = Math.max(sx0, Math.floor(x0)); x < x1; x++) {
        const u = b.s / 32 + (x + 0.5 - x0) * stepS, v = b.t / 32 + (y + 0.5 - y0) * stepT;
        this.pixel(state, spec, img, x, y, [1, 1, 1, 1], u, v);
      }
    }
  }

  private triangles(b: TriangleBatch, img: Uint8Array): void {
    const n = b.positions.length / 4;
    const verts: Vertex[] = [];
    for (let i = 0; i < n; i++) {
      verts.push({
        pos: [b.positions[i * 4]!, b.positions[i * 4 + 1]!, b.positions[i * 4 + 2]!, b.positions[i * 4 + 3]!],
        color: [b.colors[i * 4]!, b.colors[i * 4 + 1]!, b.colors[i * 4 + 2]!, b.colors[i * 4 + 3]!],
        uv: [b.uvs[i * 2]!, b.uvs[i * 2 + 1]!]
      });
    }
    for (let i = 0; i + 2 < n; i += 3) this.triangle(b.state, img, verts[i]!, verts[i + 1]!, verts[i + 2]!);
  }

  private triangle(state: DrawState, img: Uint8Array, a: Vertex, b: Vertex, c: Vertex): void {
    // Same as the vertex shader: a vertex in front of the near plane is moved onto it rather than clipped away.
    const onNear = (v: Vertex): Vertex => (v.pos[3] > 0 && v.pos[2] < -v.pos[3] ? { ...v, pos: [v.pos[0], v.pos[1], -v.pos[3], v.pos[3]] } : v);
    const poly = clipNear([onNear(a), onNear(b), onNear(c)]);
    for (let k = 1; k + 1 < poly.length; k++) this.projected(state, img, poly[0]!, poly[k]!, poly[k + 1]!);
  }

  private projected(state: DrawState, img: Uint8Array, a: Vertex, b: Vertex, c: Vertex): void {
    const vp = state.viewport;
    const full = vp.scale[0] === 0 || vp.scale[1] === 0;
    const hw = full ? WIDTH / 2 : Math.abs(vp.scale[0]) / 4, hh = full ? HEIGHT / 2 : Math.abs(vp.scale[1]) / 4;
    const cx = full ? WIDTH / 2 : vp.trans[0] / 4, cy = full ? HEIGHT / 2 : vp.trans[1] / 4;
    const sp = (v: Vertex) => ({ x: cx + (v.pos[0] / v.pos[3]) * hw, y: cy - (v.pos[1] / v.pos[3]) * hh, z: v.pos[2] / v.pos[3], iw: 1 / v.pos[3] });
    const p = [sp(a), sp(b), sp(c)] as const;
    // Counter-clockwise on a y-up screen is the front face.
    const area = (p[1].x - p[0].x) * (p[2].y - p[0].y) - (p[2].x - p[0].x) * (p[1].y - p[0].y);
    if (area === 0) return;
    const front = area < 0;
    const gm = state.geometryMode;
    const swap = this.cullMode === 'swapped';
    const cullFront = (gm & Geo.CULL_FRONT) !== 0, cullBack = (gm & Geo.CULL_BACK) !== 0;
    if (this.cullMode !== 'off') {
      const isFront = front !== swap;
      if ((cullBack && !isFront) || (cullFront && isFront)) return;
    }
    const spec = specOf(state);
    const [sx0, sy0, sx1, sy1] = this.scissor(state);
    const minX = Math.max(sx0, Math.floor(Math.min(p[0].x, p[1].x, p[2].x))), maxX = Math.min(sx1 - 1, Math.ceil(Math.max(p[0].x, p[1].x, p[2].x)));
    const minY = Math.max(sy0, Math.floor(Math.min(p[0].y, p[1].y, p[2].y))), maxY = Math.min(sy1 - 1, Math.ceil(Math.max(p[0].y, p[1].y, p[2].y)));
    const l = state.otherModeL;
    const depthOn = (gm & Geo.ZBUFFER) !== 0;
    // A decal passes the depth test where it is as deep as the surface it lies on, give or take the triangle's own depth
    // slope: its depth is moved towards the eye by that slope before the comparison.
    const decal = ((l >>> OtherL.ZMODE_SHIFT) & 3) === 3;
    const dzdx = ((p[1].z - p[0].z) * (p[2].y - p[0].y) - (p[2].z - p[0].z) * (p[1].y - p[0].y)) / area;
    const dzdy = ((p[2].z - p[0].z) * (p[1].x - p[0].x) - (p[1].z - p[0].z) * (p[2].x - p[0].x)) / area;
    const decalBias = decal ? Math.max(Math.abs(dzdx), Math.abs(dzdy)) + DECAL_MIN_BIAS : 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((p[1].x - px) * (p[2].y - py) - (p[2].x - px) * (p[1].y - py)) / area;
        const w1 = ((p[2].x - px) * (p[0].y - py) - (p[0].x - px) * (p[2].y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * p[0].z + w1 * p[1].z + w2 * p[2].z;
        const di = y * WIDTH + x;
        if (depthOn && (l & OtherL.Z_COMPARE) && z - decalBias > this.depth[di]!) continue;
        const q0 = w0 * p[0].iw, q1 = w1 * p[1].iw, q2 = w2 * p[2].iw;
        const qs = q0 + q1 + q2;
        // Texture coordinates are corrected for perspective; the shade (colour and fog factor) is linear in screen space.
        const color: [number, number, number, number] = [
          w0 * a.color[0] + w1 * b.color[0] + w2 * c.color[0], w0 * a.color[1] + w1 * b.color[1] + w2 * c.color[1],
          w0 * a.color[2] + w1 * b.color[2] + w2 * c.color[2], w0 * a.color[3] + w1 * b.color[3] + w2 * c.color[3],
        ];
        const u = (q0 * a.uv[0] + q1 * b.uv[0] + q2 * c.uv[0]) / qs, v = (q0 * a.uv[1] + q1 * b.uv[1] + q2 * c.uv[1]) / qs;
        if (this.pixel(state, spec, img, x, y, color, u, v) && depthOn && (l & OtherL.Z_UPDATE)) this.depth[di] = z;
      }
    }
  }

  /** Combines, tests and blends one pixel; returns whether it was written. */
  private pixel(state: DrawState, spec: ShaderSpec, img: Uint8Array, x: number, y: number, shade: [number, number, number, number], u: number, v: number): boolean {
    const t0 = texel(state.textures[0], state.tiles[state.textures[0]?.tile ?? 0], u, v, spec.bilerp);
    const t1 = texel(state.textures[1], state.tiles[state.textures[1]?.tile ?? 0], u, v, spec.bilerp);
    const inputs: Inputs = {
      combined: [0, 0, 0], combinedA: 0, t0, t1, shade: [shade[0], shade[1], shade[2]], shadeA: shade[3],
      prim: unit(state.primColor), env: unit(state.envColor), primLod: state.primColor.lodFrac / 255,
    };
    let rgb: V3, a: number;
    if (spec.copy) {
      rgb = [t0[0], t0[1], t0[2]];
      a = t0[3];
      if (a < 0.5) return false;
    } else {
      for (let n = 0; n < spec.cycles; n++) {
        const cur = n === 0 ? inputs : { ...inputs, t0: t1, t1: t0 };
        cur.combined = inputs.combined;
        cur.combinedA = inputs.combinedA;
        const rgbCodes = spec.rgb[n]!, alphaCodes = spec.alpha[n]!;
        const ra = rgbInput(0, rgbCodes[0]!, cur), rb = rgbInput(1, rgbCodes[1]!, cur), rc = rgbInput(2, rgbCodes[2]!, cur), rd = rgbInput(3, rgbCodes[3]!, cur);
        const aa = alphaInput(0, alphaCodes[0]!, cur), ab = alphaInput(1, alphaCodes[1]!, cur), ac = alphaInput(2, alphaCodes[2]!, cur), ad = alphaInput(3, alphaCodes[3]!, cur);
        inputs.combined = [clamp01((ra[0] - rb[0]) * rc[0] + rd[0]), clamp01((ra[1] - rb[1]) * rc[1] + rd[1]), clamp01((ra[2] - rb[2]) * rc[2] + rd[2])];
        inputs.combinedA = clamp01((aa - ab) * ac + ad);
      }
      rgb = inputs.combined;
      a = inputs.combinedA;
      if (spec.alphaCompare && a < state.blendColor.a / 255) return false;
      if (spec.coverageTimesAlpha && a < MIN_COVERAGE_ALPHA) return false;
    }
    const dst = (y * WIDTH + x) * 4;
    let weight = 1;
    const pixelAlpha = spec.alphaFromCoverage && !spec.coverageTimesAlpha ? 1 : a;
    if (!spec.copy) {
      for (let n = 0; n < spec.cycles; n++) {
        const t = blendTerms(spec.blend[n]!, rgb, pixelAlpha, state, inputs.shadeA);
        if (n === spec.cycles - 1 && spec.framebufferBlend) {
          const s = t.a + t.b;
          weight = s > 0 ? t.a / s : 1;
          rgb = t.p;
        } else if (!t.usesMemory) {
          const s = t.a + t.b;
          rgb = s > 0 ? [(t.p[0] * t.a + t.m[0] * t.b) / s, (t.p[1] * t.a + t.m[1] * t.b) / s, (t.p[2] * t.a + t.m[2] * t.b) / s] : t.p;
        }
      }
    }
    for (let k = 0; k < 3; k++) img[dst + k] = Math.round(255 * (rgb[k]! * weight + (img[dst + k]! / 255) * (1 - weight)));
    img[dst + 3] = 255;
    this.pixelsWritten++;
    return true;
  }
}

function blendTerms(c: BlendCycle, pixel: V3, pixelA: number, state: DrawState, shadeA: number): { p: V3; m: V3; a: number; b: number; usesMemory: boolean } {
  const f = state.fogColor, bl = state.blendColor;
  const colour = (sel: number): V3 => (sel < 2 ? pixel : sel === 2 ? [bl.r / 255, bl.g / 255, bl.b / 255] : [f.r / 255, f.g / 255, f.b / 255]);
  const a = [pixelA, f.a / 255, shadeA, 0][c.a]!;
  const b = [1 - a, 1, 1, 0][c.b]!;
  return { p: colour(c.p), m: colour(c.m), a, b, usesMemory: c.p === 1 || c.m === 1 || c.b === 1 };
}

/** Clips a triangle against the near plane (z > -w) and returns the polygon's vertices. */
function clipNear(poly: Vertex[]): Vertex[] {
  const dist = (v: Vertex) => v.pos[2] + v.pos[3];
  const out: Vertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!, nxt = poly[(i + 1) % poly.length]!;
    const dc = dist(cur), dn = dist(nxt);
    if (dc >= 0) out.push(cur);
    if ((dc >= 0) !== (dn >= 0)) {
      const t = dc / (dc - dn);
      const lerp = (x: number, y: number) => x + (y - x) * t;
      out.push({
        pos: cur.pos.map((v, k) => lerp(v, nxt.pos[k]!)) as Vertex['pos'],
        color: cur.color.map((v, k) => lerp(v, nxt.color[k]!)) as Vertex['color'],
        uv: [lerp(cur.uv[0], nxt.uv[0]), lerp(cur.uv[1], nxt.uv[1])]
      });
    }
  }
  return out.filter((v) => v.pos[3] > 1e-6);
}

/** How much of an image is one flat colour: the share of pixels with the most common colour (and that colour as 0xRRGGBB), and the number of rows of a single colour. */
export function flatness(img: Uint8Array): { dominant: number; colour: number; flatRows: number } {
  const counts = new Map<number, number>();
  let flatRows = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * WIDTH * 4;
    let same = true;
    for (let x = 0; x < WIDTH; x++) {
      const o = row + x * 4;
      const v = (img[o]! << 16) | (img[o + 1]! << 8) | img[o + 2]!;
      counts.set(v, (counts.get(v) ?? 0) + 1);
      if (same && (img[o]! !== img[row]! || img[o + 1]! !== img[row + 1]! || img[o + 2]! !== img[row + 2]!)) same = false;
    }
    if (same) flatRows++;
  }
  const [colour, count] = [...counts].reduce((best, e) => (e[1] > best[1] ? e : best));
  return { dominant: count / (WIDTH * HEIGHT), colour, flatRows };
}
