// Turns the RDP's per-draw configuration (combiner, blender, filtering, fog and alpha tests) into GLSL ES 3.00 fragment
// shaders. A shader depends only on the `ShaderSpec` derived from the draw state; colours, tile sizes and the like are
// uniforms, so a handful of programs cover a whole scene.
import type { DrawState } from '../tools/gfx/types.ts';
import type { FilterMode } from './gfx-settings.ts';

/** Cycle type, bits 20-21 of the high half of the other modes. */
export const CycleType = { ONE: 0, TWO: 1, COPY: 2, FILL: 3 } as const;

/** One term of the blender equation `(p * a + m * b) / (a + b)`; the numbers are the hardware's selector codes. */
export interface BlendCycle {
  /** p: 0 pixel colour, 1 framebuffer colour, 2 blend colour, 3 fog colour. */
  p: number;
  /** a: 0 pixel alpha, 1 fog colour alpha, 2 shade alpha, 3 zero. */
  a: number;
  /** m: as p. */
  m: number;
  /** b: 0 one minus a, 1 framebuffer alpha, 2 one, 3 zero. */
  b: number;
}

export interface ShaderSpec {
  /** 1 or 2 combiner/blender cycles; copy mode is one cycle with the combiner replaced by the texel. */
  cycles: 1 | 2;
  copy: boolean;
  rgb: [[number, number, number, number], [number, number, number, number]];
  alpha: [[number, number, number, number], [number, number, number, number]];
  /** Bilinear texture filtering instead of nearest. */
  bilerp: boolean;
  /** With `bilerp`: standard four-texel bilinear instead of the console's 3-point filter. */
  smooth: boolean;
  /** Textures that the draw marks (uniform `uTexC.z`) are sampled from mip levels, with anisotropic taps. */
  mip: boolean;
  alphaCompare: boolean;
  /**
   * With `alphaCompare`, or coverage scaled by alpha: the alpha test becomes a coverage fraction for alpha-to-coverage (the
   * draw must go to a multisampled target, with the GL blend unit off).
   */
  cutout: boolean;
  /** The coverage is scaled by the pixel alpha: a pixel whose alpha rounds to no coverage is not written. */
  coverageTimesAlpha: boolean;
  /** The blender's pixel alpha is the coverage (1 for a pixel inside the triangle, the pixel alpha when scaled by it). */
  alphaFromCoverage: boolean;
  blend: [BlendCycle, BlendCycle];
  /**
   * The last blender cycle mixes with the framebuffer and the mix is applied by the GL blend unit: the shader
   * outputs the pixel colour and the weight of the pixel in alpha.
   */
  framebufferBlend: boolean;
}

export const OtherL = {
  ALPHA_COMPARE_MASK: 3,
  Z_COMPARE: 1 << 4,
  Z_UPDATE: 1 << 5,
  ZMODE_SHIFT: 10,
  CVG_TIMES_ALPHA: 1 << 12,
  ALPHA_CVG_SELECT: 1 << 13,
  FORCE_BLEND: 1 << 14,
} as const;

/**
 * Smallest alpha that leaves a pixel any coverage when coverage is multiplied by alpha: with eight sub-pixel samples and
 * an 8-bit alpha, `(8 * alpha + 4) >> 8` is zero up to an alpha of 31.
 */
export const MIN_COVERAGE_ALPHA = 32 / 255;

export const cycleTypeOf = (otherModeH: number): number => (otherModeH >>> 20) & 3;

function blendCycles(l: number): [BlendCycle, BlendCycle] {
  return [
    { p: (l >>> 30) & 3, a: (l >>> 26) & 3, m: (l >>> 22) & 3, b: (l >>> 18) & 3 },
    { p: (l >>> 28) & 3, a: (l >>> 24) & 3, m: (l >>> 20) & 3, b: (l >>> 16) & 3 },
  ];
}

export interface SpecOptions {
  filter?: FilterMode;
  mip?: boolean;
  /** Smooth cut-out edges; takes effect only on an alpha-compare or coverage-times-alpha draw that does not blend with the framebuffer. */
  cutout?: boolean;
  /** Four-texel bilinear in place of the 3-point filter for this draw, whose textures are soft gradients (`web/low-contrast.ts`). */
  smoothTexels?: boolean;
}

/** `filter` replaces what the draw asked for: `sharp` makes every texture nearest, `smooth` swaps the 3-point filter for bilinear. */
export function specOf(state: DrawState, { filter = 'n64', mip = false, cutout = false, smoothTexels = false }: SpecOptions = {}): ShaderSpec {
  const type = cycleTypeOf(state.otherModeH);
  const cycles: 1 | 2 = type === CycleType.TWO ? 2 : 1;
  const [c0, c1] = state.combine.cycles;
  const blend = blendCycles(state.otherModeL);
  const last = blend[cycles - 1]!;
  const alphaCompare = (state.otherModeL & OtherL.ALPHA_COMPARE_MASK) === 1;
  const coverageTimesAlpha = (state.otherModeL & OtherL.CVG_TIMES_ALPHA) !== 0;
  const alphaFromCoverage = (state.otherModeL & OtherL.ALPHA_CVG_SELECT) !== 0;
  const framebufferBlend = (state.otherModeL & OtherL.FORCE_BLEND) !== 0 && last.m === 1 && last.p !== 1 && !(last.a === 3 && last.b === 3);
  return {
    cycles,
    copy: type === CycleType.COPY,
    rgb: [c0.rgb, c1.rgb],
    alpha: [c0.alpha, c1.alpha],
    // A copy-mode rectangle takes the texel under each pixel, whatever the filter field says.
    bilerp: type !== CycleType.COPY && ((state.otherModeH >>> 12) & 3) !== 0 && filter !== 'sharp',
    smooth: filter === 'smooth' || smoothTexels,
    mip: mip && type !== CycleType.COPY,
    alphaCompare,
    cutout: cutout && (alphaCompare || (coverageTimesAlpha && alphaFromCoverage)) && !framebufferBlend && type !== CycleType.COPY,
    coverageTimesAlpha,
    alphaFromCoverage,
    blend,
    framebufferBlend,
  };
}

/** Stable text for a spec, used as the program cache key. */
export function specKey(s: ShaderSpec): string {
  return JSON.stringify([s.cycles, s.copy, s.cycles === 2 ? s.rgb : s.rgb[0], s.cycles === 2 ? s.alpha : s.alpha[0], s.bilerp, s.smooth, s.mip, s.alphaCompare, s.cutout, s.coverageTimesAlpha, s.alphaFromCoverage, s.cycles === 2 ? s.blend : s.blend[0], s.framebufferBlend]);
}

// ---- Combiner -------------------------------------------------------------------------------------------------------

interface Inputs {
  /** GLSL expressions for the previous cycle's colour (vec3) and alpha (float). */
  combinedRgb: string;
  combinedAlpha: string;
  texel0: string;
  texel1: string;
}

const ZERO3 = 'vec3(0.0)';
const ONE3 = 'vec3(1.0)';

/** The colour input selected by `code` in slot A, B, C or D. `null` stands for a constant zero. */
export function rgbInput(slot: 0 | 1 | 2 | 3, code: number, i: Inputs): string | null {
  const alphaOf = (e: string) => `vec3(${e})`;
  const common = (c: number): string | null => {
    switch (c) {
      case 0: return i.combinedRgb;
      case 1: return `${i.texel0}.rgb`;
      case 2: return `${i.texel1}.rgb`;
      case 3: return 'uPrim.rgb';
      case 4: return 'shade.rgb';
      case 5: return 'uEnv.rgb';
      default: return null;
    }
  };
  switch (slot) {
    case 0: // A
      if (code === 6) return ONE3;
      if (code === 7) return 'vec3(0.5)'; // noise
      return code < 6 ? common(code) : null;
    case 1: // B
      if (code === 6) return ZERO3; // key centre: chroma keying is not used
      return code < 6 ? common(code) : null;
    case 2: // C
      if (code < 6) return common(code);
      switch (code) {
        case 6: return ZERO3; // key scale
        case 7: return alphaOf(i.combinedAlpha);
        case 8: return alphaOf(`${i.texel0}.a`);
        case 9: return alphaOf(`${i.texel1}.a`);
        case 10: return alphaOf('uPrim.a');
        case 11: return alphaOf('shadeAlpha');
        case 12: return alphaOf('uEnv.a');
        case 13: return ZERO3; // level of detail fraction: no mip levels are selected
        case 14: return alphaOf('uPrimLod');
        default: return null;
      }
    default: // D
      if (code === 6) return ONE3;
      return code < 6 ? common(code) : null;
  }
}

/** The alpha input selected by `code` in slot A, B, C or D. */
export function alphaInput(slot: 0 | 1 | 2 | 3, code: number, i: Inputs): string | null {
  if (slot === 2) {
    switch (code) {
      case 1: return `${i.texel0}.a`;
      case 2: return `${i.texel1}.a`;
      case 3: return 'uPrim.a';
      case 4: return 'shadeAlpha';
      case 5: return 'uEnv.a';
      case 6: return 'uPrimLod';
      default: return null; // 0 (level of detail fraction) and 7
    }
  }
  switch (code) {
    case 0: return i.combinedAlpha;
    case 1: return `${i.texel0}.a`;
    case 2: return `${i.texel1}.a`;
    case 3: return 'uPrim.a';
    case 4: return 'shadeAlpha';
    case 5: return 'uEnv.a';
    case 6: return '1.0';
    default: return null;
  }
}

/** `(A - B) * C + D` with the zero and one operands folded away. */
export function equation(a: string | null, b: string | null, c: string | null, d: string | null, zero: string): string {
  let product: string | null;
  if (c === null) product = null;
  else if (a === null && b === null) product = null;
  else {
    const diff = a !== null && b !== null ? (a === b ? null : `(${a} - ${b})`) : a !== null ? a : `-${b!.startsWith('-') ? `(${b})` : b}`;
    product = diff === null ? null : `${diff} * ${c}`;
  }
  if (product === null) return d ?? zero;
  return d === null ? product : `${product} + ${d}`;
}

function combinerSource(spec: ShaderSpec): string {
  const lines: string[] = [];
  if (spec.copy) {
    lines.push('  vec3 cRgb = t0.rgb;', '  float cA = t0.a;');
    return lines.join('\n');
  }
  lines.push('  vec3 cRgb = vec3(0.0);', '  float cA = 0.0;');
  for (let n = 0; n < spec.cycles; n++) {
    // The second cycle's first texture lookup is the first cycle's second one.
    const inputs: Inputs = { combinedRgb: 'cRgb', combinedAlpha: 'cA', texel0: n === 0 ? 't0' : 't1', texel1: n === 0 ? 't1' : 't0' };
    const [ra, rb, rc, rd] = spec.rgb[n]!;
    const [aa, ab, ac, ad] = spec.alpha[n]!;
    const rgb = equation(rgbInput(0, ra, inputs), rgbInput(1, rb, inputs), rgbInput(2, rc, inputs), rgbInput(3, rd, inputs), ZERO3);
    const alpha = equation(alphaInput(0, aa, inputs), alphaInput(1, ab, inputs), alphaInput(2, ac, inputs), alphaInput(3, ad, inputs), '0.0');
    lines.push(`  { vec3 nRgb = clamp(${rgb}, 0.0, 1.0); float nA = clamp(${alpha}, 0.0, 1.0); cRgb = nRgb; cA = nA; }`);
  }
  return lines.join('\n');
}

// ---- Blender --------------------------------------------------------------------------------------------------------

const BLEND_COLOR = ['pixel', 'pixel', 'uBlend.rgb', 'uFog.rgb'];

function blendTerms(c: BlendCycle, pixel: string, pixelAlpha: string): { p: string; m: string; a: string; b: string; usesMemory: boolean } {
  const colour = (sel: number) => (sel === 0 || sel === 1 ? pixel : BLEND_COLOR[sel]!);
  const a = [pixelAlpha, 'uFog.a', 'shadeAlpha', '0.0'][c.a]!;
  const b = ['(1.0 - ' + a + ')', '1.0', '1.0', '0.0'][c.b]!;
  return { p: colour(c.p), m: colour(c.m), a, b, usesMemory: c.p === 1 || c.m === 1 || c.b === 1 };
}

function blenderSource(spec: ShaderSpec): string {
  const pixelAlpha = spec.alphaFromCoverage ? (spec.coverageTimesAlpha ? 'cA' : '1.0') : 'cA';
  const lines: string[] = ['  vec3 pixel = cRgb;', `  float pixelA = ${pixelAlpha};`, '  float weight = 1.0;'];
  if (spec.copy) return lines.join('\n');
  for (let n = 0; n < spec.cycles; n++) {
    const last = n === spec.cycles - 1;
    const t = blendTerms(spec.blend[n]!, 'pixel', 'pixelA');
    if (last && spec.framebufferBlend) {
      // out = pixel * w + framebuffer * (1 - w) with w = a / (a + b), the framebuffer's alpha being 1.
      lines.push(`  { float a = ${t.a}; float b = ${t.b}; float s = a + b; weight = s > 0.0 ? a / s : 1.0; pixel = ${t.p}; }`);
    } else if (!t.usesMemory) {
      // Without the framebuffer the mix is exact and local to the pixel.
      lines.push(`  { float a = ${t.a}; float b = ${t.b}; float s = a + b; vec3 mixed = s > 0.0 ? (${t.p} * a + ${t.m} * b) / s : ${t.p}; pixel = mixed; }`);
    }
    // A cycle that reads the framebuffer without forcing the blend leaves the pixel as it is: the hardware only blends
    // at partially covered edges then.
  }
  return lines.join('\n');
}

// ---- Texture lookup -------------------------------------------------------------------------------------------------

function textureFunction(index: number): string {
  return `
vec4 fetch${index}(ivec2 p, int lvl) {
  vec4 m = uTexB[${index}];
  vec2 size = vec2(textureSize(uTex${index}, lvl));
  float shrink = exp2(-float(lvl));
  float x = wrapCoord(float(p.x), size.x, m.x > 0.0 ? max(exp2(m.x) * shrink, 1.0) : 0.0, m.z);
  float y = wrapCoord(float(p.y), size.y, m.y > 0.0 ? max(exp2(m.y) * shrink, 1.0) : 0.0, m.w);
  return texelFetch(uTex${index}, ivec2(int(x), int(y)), lvl);
}
// st is in texels of level 0.
vec4 filter${index}(vec2 st, int lvl) {
  st *= exp2(-float(lvl));
#ifdef BILERP
  st -= 0.5;
  vec2 f = fract(st);
  ivec2 b = ivec2(floor(st));
  // The console's filter blends the three texels of the triangle that holds the point (the corner at (0,0) or at (1,1), and
  // the two others); smooth bilinear blends the four around it.
  vec4 c10 = fetch${index}(b + ivec2(1, 0), lvl);
  vec4 c01 = fetch${index}(b + ivec2(0, 1), lvl);
#ifdef SMOOTH
  vec4 c00 = fetch${index}(b, lvl);
  vec4 c11 = fetch${index}(b + ivec2(1, 1), lvl);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
#else
  bool upper = f.x + f.y > 1.0;
  vec4 corner = fetch${index}(upper ? b + ivec2(1, 1) : b, lvl);
  return upper ? corner * (f.x + f.y - 1.0) + c01 * (1.0 - f.x) + c10 * (1.0 - f.y)
               : corner * (1.0 - f.x - f.y) + c10 * f.x + c01 * f.y;
#endif
#else
  return fetch${index}(ivec2(floor(st)), lvl);
#endif
}
vec4 sample${index}(vec2 uv) {
  vec4 a = uTexA[${index}]; vec4 sh = uTexC[${index}];
  vec2 st = uv * sh.xy - a.zw;
#ifdef MIP
  // The footprint of the pixel in texels, taken as an ellipse with the longer screen derivative as its major axis: the level
  // is picked from the shorter side and the taps are spread along the longer one. One loop with a single filter call
  // covers the taps and the two levels, which keeps the program small enough to compile quickly.
  vec2 axis = vec2(0.0);
  float taps = 1.0; float t = 0.0; int l0 = 0; int l1 = 0;
  if (sh.z > 0.5) {
    vec2 dx = dFdx(st); vec2 dy = dFdy(st);
    float lx = dot(dx, dx); float ly = dot(dy, dy);
    float longSide = sqrt(max(lx, ly));
    if (longSide > 1.0) {
      axis = lx >= ly ? dx : dy;
      float shortSide = max(sqrt(min(lx, ly)), 1.0);
      taps = clamp(ceil(longSide / shortSide), 1.0, uAniso);
      int top = int(floor(log2(max(a.x, a.y))));
      float lod = clamp(log2(longSide / taps), 0.0, float(top));
      l0 = int(floor(lod));
      l1 = min(l0 + 1, top);
      t = lod - float(l0);
      gLod = max(gLod, lod);
#ifndef BILERP
      t = t >= 0.5 ? 1.0 : 0.0;
#endif
    }
  }
  vec4 sum = vec4(0.0);
  int steps = 2 * int(taps);
  for (int k = 0; k < steps; k++) {
    bool far = (k & 1) == 1;
    float w = far ? t : 1.0 - t;
    if (w <= 0.0) continue;
    sum += w * filter${index}(st + axis * ((float(k >> 1) + 0.5) / taps - 0.5), far ? l1 : l0);
  }
  return sum / taps;
#else
  return filter${index}(st, 0);
#endif
}`;
}

const WRAP_FUNCTION = `
// Mip level (log2 of the shorter side of the footprint, in texels) of the coarsest mip-mapped lookup so far; 0 without mip levels.
float gLod = 0.0;
// Applies the tile's clamp, mirror and mask to an integer texel coordinate (relative to the tile's origin). The period is
// the mask's size in texels, 0 without a mask.
float wrapCoord(float v, float size, float period, float mode) {
  if (mode >= 2.0) v = clamp(v, 0.0, size - 1.0);
  if (period > 0.0) {
    if (mod(mode, 2.0) >= 1.0) {
      float m = mod(v, 2.0 * period);
      v = m >= period ? 2.0 * period - 1.0 - m : m;
    } else {
      v = mod(v, period);
    }
  }
  return clamp(v, 0.0, size - 1.0);
}`;

// ---- Programs -------------------------------------------------------------------------------------------------------

export const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec2 aUv;
out vec4 vColor;
out vec2 vUv;
// 0.5 for triangles, whose viewport is twice the screen (renderer.ts); 1 for rectangles.
uniform float uXyScale;
void main() {
  // A vertex in front of the near plane is drawn at the nearest depth instead of being clipped away.
  gl_Position = vec4(aPos.xy * uXyScale, aPos.w > 0.0 ? max(aPos.z, -aPos.w) : aPos.z, aPos.w);
  // The shade (colour and fog factor) is interpolated linearly in screen space on the console, not corrected for
  // perspective like the texture coordinates: scaled by w here, and by 1 / w of the pixel in the fragment shader, the
  // perspective-correct interpolation of GL gives the linear one.
  vColor = aColor * aPos.w;
  vUv = aUv;
}
`;

/**
 * Distant vegetation loses alpha in the mip levels (thin leaves average toward transparent), so alpha is raised by a quarter
 * per level, up to a factor of two, before the test. The alpha is then rescaled around the game's threshold by its screen
 * derivative, which gives a one-pixel ramp at the edge: crisp when magnified, anti-aliased when small. The ramp is the
 * coverage that alpha-to-coverage turns into samples.
 */
const EDGE_THRESHOLD = '0.5';

function alphaTest(spec: ShaderSpec): string {
  if (spec.copy) return '  if (cA < 0.5) discard;';
  if (!spec.cutout) return spec.alphaCompare ? '  if (cA < uBlend.a) discard;' : '';
  return `  float edgeA = ${spec.mip ? 'cA * min(1.0 + 0.25 * gLod, 2.0)' : 'cA'};
  float cover = clamp((edgeA - ${spec.alphaCompare ? 'uBlend.a' : EDGE_THRESHOLD}) / max(fwidth(edgeA), 1e-4) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;`;
}

export function fragmentSource(spec: ShaderSpec): string {
  return `#version 300 es
precision highp float;
precision highp int;
${spec.bilerp ? '#define BILERP 1' : ''}
${spec.bilerp && spec.smooth ? '#define SMOOTH 1' : ''}
${spec.mip ? '#define MIP 1' : ''}
in vec4 vColor;
in vec2 vUv;
out vec4 outColor;
uniform vec4 uPrim;
uniform vec4 uEnv;
uniform vec4 uFog;
uniform vec4 uBlend;
uniform float uPrimLod;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
// size.xy, origin.xy (in texels, after shifting)
uniform vec4 uTexA[2];
// maskS, maskT, modeS, modeT (mode: bit 0 mirror, bit 1 clamp)
uniform vec4 uTexB[2];
// scale to apply to the coordinates (from the tile's shift) in .xy; .z is 1 for a texture sampled from mip levels
uniform vec4 uTexC[2];
// most taps along the long axis of a footprint
uniform float uAniso;
${WRAP_FUNCTION}
${textureFunction(0)}
${textureFunction(1)}
void main() {
  vec4 shade = vColor * gl_FragCoord.w;
  float shadeAlpha = shade.a;
  vec4 t0 = sample0(vUv);
  vec4 t1 = sample1(vUv);
${combinerSource(spec)}
${alphaTest(spec)}
${spec.coverageTimesAlpha && !spec.copy ? `  if (cA < ${MIN_COVERAGE_ALPHA.toFixed(6)}) discard;` : ''}
${blenderSource(spec)}
  outColor = vec4(pixel, ${spec.framebufferBlend ? 'weight' : spec.cutout ? 'cover' : '1.0'});
}
`;
}

/** Scale applied to a texture coordinate for a tile's shift field (0-10 divide by 2^shift, 11-15 multiply by 2^(16-shift)). */
export function shiftScale(shift: number): number {
  return shift <= 10 ? 1 / (1 << shift) : 1 << (16 - shift);
}
