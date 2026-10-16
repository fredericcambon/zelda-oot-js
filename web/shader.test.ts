import { describe, expect, it } from 'vitest';
import { decodeCombine, type DrawState } from '../tools/gfx/dl.ts';
import { CycleType, equation, fragmentSource, MIN_COVERAGE_ALPHA, rgbInput, shiftScale, specKey, specOf, VERTEX_SHADER } from './shader.ts';

const rgba = { r: 0, g: 0, b: 0, a: 0 };

function state(over: Partial<DrawState> = {}): DrawState {
  return {
    geometryMode: 0, otherModeH: 0, otherModeL: 0, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: rgba, fogColor: rgba, blendColor: rgba, fillColor: 0, texture: { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [], textures: [null, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] }, scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 },
    fog: { multiplier: 0, offset: 0 }, colorImage: { fmt: 0, siz: 2, width: 320, addr: 0 }, depthImage: 0, ...over,
  };
}

/** Packs the four colour inputs and four alpha inputs of one cycle into a combine command, duplicated for both cycles. */
function combine(rgb: number[], alpha: number[]) {
  const [a, b, c, d] = rgb as [number, number, number, number];
  const [aa, ab, ac, ad] = alpha as [number, number, number, number];
  const w0 = (0xfc << 24) | (a << 20) | (c << 15) | (aa << 12) | (ac << 9) | (a << 5) | c;
  const w1 = (b << 28) | (b << 24) | (ab << 21) | (ab << 3) | (d << 15) | (ad << 12) | (d << 6) | (ad << 9) | (ac << 18) | ac;
  return decodeCombine(w0 >>> 0, w1 >>> 0);
}

describe('combiner equation', () => {
  it('folds zero operands away', () => {
    expect(equation('a', null, 'c', null, '0')).toBe('a * c');
    expect(equation('a', 'b', 'c', 'd', '0')).toBe('(a - b) * c + d');
    expect(equation('a', 'a', 'c', 'd', '0')).toBe('d');
    expect(equation('a', 'b', null, 'd', '0')).toBe('d');
    expect(equation(null, null, 'c', null, '0')).toBe('0');
  });

  it('selects inputs by the hardware codes', () => {
    const i = { combinedRgb: 'cRgb', combinedAlpha: 'cA', texel0: 't0', texel1: 't1' };
    expect(rgbInput(0, 1, i)).toBe('t0.rgb');
    expect(rgbInput(0, 2, i)).toBe('t1.rgb');
    expect(rgbInput(0, 15, i)).toBeNull();
    expect(rgbInput(2, 8, i)).toBe('vec3(t0.a)');
    expect(rgbInput(2, 11, i)).toBe('vec3(shadeAlpha)');
    expect(rgbInput(3, 6, i)).toBe('vec3(1.0)');
    expect(rgbInput(3, 7, i)).toBeNull();
  });
});

describe('shader generation', () => {
  it('modulates the texel by the shade colour', () => {
    // (TEXEL0 - 0) * SHADE + 0, alpha TEXEL0 * SHADE
    const s = state({ combine: combine([1, 15, 4, 7], [1, 7, 4, 7]) });
    const src = fragmentSource(specOf(s));
    expect(src).toContain('clamp(t0.rgb * vColor.rgb, 0.0, 1.0)');
    expect(src).toContain('clamp(t0.a * shadeAlpha, 0.0, 1.0)');
    expect(src).toContain('#version 300 es');
  });

  it('feeds the second cycle with the first and swaps its texel inputs', () => {
    const otherModeH = CycleType.TWO << 20;
    const w0 = 0xfc000000 | (1 << 20) | (3 << 15) | (1 << 5) | 4;
    const s = state({ otherModeH, combine: decodeCombine(w0 >>> 0, (15 << 28) | (15 << 24) | (7 << 15) | (7 << 6)) });
    const spec = specOf(s);
    expect(spec.cycles).toBe(2);
    const src = fragmentSource(spec);
    expect(src).toContain('t0.rgb * uPrim.rgb');
    expect(src).toContain('t1.rgb * vColor.rgb');
  });

  it('uses the fog factor as shade alpha only with the fog geometry bit', () => {
    expect(fragmentSource(specOf(state()))).toContain('float shadeAlpha = vColor.a;');
    expect(fragmentSource(specOf(state({ geometryMode: 0x10000 })))).toContain('float shadeAlpha = vFog;');
  });

  it('turns on bilinear filtering, alpha test and framebuffer blending from the other modes', () => {
    const plain = specOf(state());
    expect(plain.bilerp).toBe(false);
    expect(plain.alphaCompare).toBe(false);
    expect(plain.framebufferBlend).toBe(false);
    // Blender: pixel colour, pixel alpha, framebuffer colour, one minus alpha; blend forced.
    const blendL = ((0 << 30) | (0 << 26) | (1 << 22) | (0 << 18) | (1 << 14) | 1) >>> 0;
    const s = specOf(state({ otherModeH: 2 << 12, otherModeL: blendL }));
    expect(s.bilerp).toBe(true);
    expect(s.alphaCompare).toBe(true);
    expect(s.framebufferBlend).toBe(true);
    const src = fragmentSource(s);
    expect(src).toContain('#define BILERP 1');
    expect(src).toContain('if (cA < uBlend.a) discard;');
    expect(src).toContain('outColor = vec4(pixel, weight);');
  });

  it('mixes fog into the pixel inside the shader when the framebuffer is not involved', () => {
    // pixel * shade alpha + fog colour * (1 - shade alpha)
    const l = ((0 << 30) | (2 << 26) | (3 << 22) | (0 << 18)) >>> 0;
    const s = specOf(state({ otherModeL: l }));
    expect(s.framebufferBlend).toBe(false);
    const src = fragmentSource(s);
    expect(src).toContain('uFog.rgb * b');
    expect(src).toContain('float a = shadeAlpha;');
    expect(src).toContain('outColor = vec4(pixel, 1.0);');
  });

  it('discards pixels without coverage when the coverage is multiplied by alpha', () => {
    const plain = specOf(state({ otherModeL: 1 << 13 }));
    expect(plain.coverageTimesAlpha).toBe(false);
    expect(plain.alphaFromCoverage).toBe(true);
    expect(fragmentSource(plain)).not.toContain(`if (cA < ${MIN_COVERAGE_ALPHA.toFixed(6)}) discard;`);
    expect(fragmentSource(plain)).toContain('float pixelA = 1.0;');
    const edge = specOf(state({ otherModeL: (1 << 13) | (1 << 12) }));
    expect(edge.coverageTimesAlpha).toBe(true);
    expect(fragmentSource(edge)).toContain(`if (cA < ${MIN_COVERAGE_ALPHA.toFixed(6)}) discard;`);
    expect(fragmentSource(edge)).toContain('float pixelA = cA;');
    expect(specKey(edge)).not.toBe(specKey(plain));
  });

  it('copies the texel in copy mode', () => {
    const s = specOf(state({ otherModeH: CycleType.COPY << 20 }));
    expect(s.copy).toBe(true);
    const src = fragmentSource(s);
    expect(src).toContain('vec3 cRgb = t0.rgb;');
    expect(src).toContain('if (cA < 0.5) discard;');
  });

  it('keys programs by what changes the source only', () => {
    const a = specKey(specOf(state({ combine: combine([1, 15, 4, 7], [1, 7, 4, 7]), primColor: { r: 9, g: 9, b: 9, a: 9, minLod: 0, lodFrac: 3 } })));
    const b = specKey(specOf(state({ combine: combine([1, 15, 4, 7], [1, 7, 4, 7]) })));
    const c = specKey(specOf(state({ combine: combine([1, 15, 3, 7], [1, 7, 4, 7]) })));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('balances braces in every variant', () => {
    for (const geometryMode of [0, 0x10000]) {
      for (const otherModeH of [0, CycleType.TWO << 20, CycleType.COPY << 20, 2 << 12]) {
        const src = fragmentSource(specOf(state({ geometryMode, otherModeH })));
        expect(src.split('{').length).toBe(src.split('}').length);
      }
    }
  });
});

describe('vertex shader', () => {
  it('moves a vertex in front of the near plane onto it and leaves the others alone', () => {
    expect(VERTEX_SHADER).toContain('aPos.w > 0.0 ? max(aPos.z, -aPos.w) : aPos.z');
  });
});

describe('tile shift', () => {
  it('divides for shifts up to 10 and multiplies above', () => {
    expect(shiftScale(0)).toBe(1);
    expect(shiftScale(2)).toBe(0.25);
    expect(shiftScale(10)).toBe(1 / 1024);
    expect(shiftScale(11)).toBe(32);
    expect(shiftScale(15)).toBe(2);
  });
});
