import { describe, expect, it } from 'vitest';
import { decodeCombine, type DecodedTexture, type DisplayListResult, type DrawState, type TileState, type TriangleBatch } from './types.ts';
import { HEIGHT, SoftRenderer, WIDTH } from './raster.ts';

const IMAGE = 0x80100000;
const rgba = { r: 0, g: 0, b: 0, a: 0 };

const tile: TileState = {
  fmt: 0, siz: 3, line: 0, tmem: 0, palette: 0, cmT: 0, maskT: 0, shiftT: 0, cmS: 0, maskS: 0, shiftS: 0,
  uls: 0, ult: 0, lrs: 0, lrt: 0, sized: true,
};

function state(over: Partial<DrawState> = {}): DrawState {
  return {
    geometryMode: 0, otherModeH: 0, otherModeL: 0, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: rgba, fogColor: rgba, blendColor: rgba, fillColor: 0, texture: { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [tile], textures: [null, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] }, scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 },
    colorImage: { fmt: 0, siz: 3, width: 320, addr: IMAGE }, depthImage: 0, ...over,
  };
}

/** The colour combiner equations (A - B) * C + D by selector code, the same for both cycles. */
function combine(rgb: [number, number, number, number], alpha: [number, number, number, number]) {
  const [a, b, c, d] = rgb;
  const [aa, ab, ac, ad] = alpha;
  const w0 = (0xfc << 24) | (a << 20) | (c << 15) | (aa << 12) | (ac << 9) | (a << 5) | c;
  const w1 = (b << 28) | (b << 24) | (ab << 21) | (ab << 3) | (d << 15) | (ad << 12) | (d << 6) | (ad << 9) | (ac << 18) | ac;
  return decodeCombine(w0 >>> 0, w1 >>> 0);
}

/**
 * Two triangles over the whole screen at clip depth `z` (w = 1), texture coordinates spanning `uSpan` texels across, the
 * vertex alpha (the shade alpha: the fog factor with the fog geometry bit) being `alpha`.
 */
function screen(s: DrawState, z = 0, uSpan = 1, alpha = 1): TriangleBatch {
  const corners = [[-1, 1, 0, 0], [-1, -1, 0, 1], [1, -1, uSpan, 1], [-1, 1, 0, 0], [1, -1, uSpan, 1], [1, 1, uSpan, 0]] as const;
  return {
    kind: 'triangles',
    state: s,
    positions: Float32Array.from(corners.flatMap(([x, y]) => [x, y, z, 1])),
    colors: Float32Array.from(corners.flatMap(() => [1, 1, 1, alpha])),
    uvs: Float32Array.from(corners.flatMap(([, , u, v]) => [u, v])),
  };
}

const task = (...batches: TriangleBatch[]): DisplayListResult => ({ batches, commands: 0, opcodes: new Map(), unknown: [], problems: [] });

function pixel(img: Uint8Array, x: number, y: number): [number, number, number] {
  const o = (y * WIDTH + x) * 4;
  return [img[o]!, img[o + 1]!, img[o + 2]!];
}

/** A width x 1 texture, each texel an [r, g, b, a] byte quadruple. */
function strip(texels: number[][]): DecodedTexture {
  return { width: texels.length, height: 1, rgba: Uint8Array.from(texels.flat()), tile: 0 };
}

const TEXEL_TIMES_SHADE = combine([1, 15, 4, 7], [1, 7, 4, 7]);
const COVERAGE_TIMES_ALPHA = 1 << 12;
const ALPHA_COVERAGE_SELECT = 1 << 13;

describe('alpha cutouts', () => {
  // Left texel opaque, right texel transparent: the left half of the screen shows the texel, the right half the picture below.
  const cutout = strip([[255, 255, 255, 255], [255, 255, 255, 0]]);
  const draw = (otherModeL: number, texture = cutout) => {
    const soft = new SoftRenderer();
    soft.drawTask(task(screen(state({ otherModeL, combine: TEXEL_TIMES_SHADE, textures: [texture, null] }), 0, 2)));
    return soft.image(IMAGE)!;
  };

  it('does not write a texel whose alpha leaves no coverage when coverage is multiplied by alpha', () => {
    const img = draw(COVERAGE_TIMES_ALPHA | ALPHA_COVERAGE_SELECT);
    expect(pixel(img, 40, 120)).toEqual([255, 255, 255]);
    expect(pixel(img, 280, 120)).toEqual([0, 0, 0]);
  });

  it('writes the same texel when the coverage is not scaled by alpha', () => {
    expect(pixel(draw(ALPHA_COVERAGE_SELECT), 280, 120)).toEqual([255, 255, 255]);
  });

  it('keeps a texel with alpha 32 and above, drops one with alpha 31 and below', () => {
    const edge = (alpha: number) => pixel(draw(COVERAGE_TIMES_ALPHA | ALPHA_COVERAGE_SELECT, strip([[255, 255, 255, 255], [255, 255, 255, alpha]])), 280, 120);
    expect(edge(32)).toEqual([255, 255, 255]);
    expect(edge(31)).toEqual([0, 0, 0]);
  });

  it('uses the blend colour alpha as the threshold of the alpha compare', () => {
    const img = (threshold: number, alpha: number) => {
      const soft = new SoftRenderer();
      const s = state({ otherModeL: 1, blendColor: { ...rgba, a: threshold }, combine: TEXEL_TIMES_SHADE, textures: [strip([[255, 255, 255, alpha]]), null] });
      soft.drawTask(task(screen(s)));
      return pixel(soft.image(IMAGE)!, 160, 120);
    };
    expect(img(128, 127)).toEqual([0, 0, 0]);
    expect(img(128, 128)).toEqual([255, 255, 255]);
  });
});

describe('geometry in front of the near plane', () => {
  // The beating heart of the status display is drawn with z / w = -1.4.
  it('is drawn instead of clipped away', () => {
    const soft = new SoftRenderer();
    const prim = { r: 255, g: 70, b: 50, a: 255, minLod: 0, lodFrac: 0 };
    soft.drawTask(task(screen(state({ primColor: prim, combine: combine([15, 15, 31, 3], [7, 7, 7, 6]) }), -1.4)));
    expect(soft.pixelsWritten).toBe(WIDTH * HEIGHT);
    expect(pixel(soft.image(IMAGE)!, 160, 120)).toEqual([255, 70, 50]);
  });

  it('is still dropped when the vertices are behind the eye', () => {
    const soft = new SoftRenderer();
    const batch = screen(state({ combine: combine([15, 15, 31, 3], [7, 7, 7, 6]) }));
    batch.positions.forEach((_, i) => { if (i % 4 === 3) batch.positions[i] = -1; });
    soft.drawTask(task(batch));
    expect(soft.pixelsWritten).toBe(0);
  });
});

describe('the shadow under Link', () => {
  // Two-cycle decal with the force-blend bit: the fog blend of the first cycle, then the pixel over the framebuffer by its alpha.
  const SHADOW_H = 0x182c10;
  const SHADOW_L = 0xc8104f50;
  const SHADOW_COMBINE = decodeCombine(0xfc1197ff, 0xfffffe38);
  const FOG = 0x10000;

  const shadowOver = (ground: number) => {
    const soft = new SoftRenderer();
    const floor = state({ primColor: { r: ground, g: ground, b: ground, a: 255, minLod: 0, lodFrac: 0 }, combine: combine([15, 15, 31, 3], [7, 7, 7, 6]) });
    const shadowState = state({
      otherModeH: SHADOW_H, otherModeL: SHADOW_L, geometryMode: FOG, combine: SHADOW_COMBINE,
      primColor: { r: 0, g: 0, b: 0, a: 246, minLod: 0, lodFrac: 0 }, fogColor: { r: 200, g: 200, b: 150, a: 0 },
      // Intensity 255, alpha 255: the combiner scales both by the primitive colour.
      textures: [strip([[255, 255, 255, 255]]), null],
    });
    // The fog factor of the ground under Link is 0.
    const shadow = screen(shadowState, 0, 1, 0);
    soft.drawTask(task(screen(floor), shadow));
    return pixel(soft.image(IMAGE)!, 160, 120);
  };

  it('darkens the ground', () => {
    const [r, g, b] = shadowOver(160);
    expect(Math.max(r, g, b)).toBeLessThan(20);
  });
});

describe('fog', () => {
  const TWO_CYCLES = 0x182c10;
  // First blender cycle mixes the fog colour in by the shade alpha, which is the fog factor; the second cycle outputs the pixel.
  const FOG_BLEND = 0xc8112078;
  const FOG = 0x10000;
  const fogged = (alpha: number) => {
    const soft = new SoftRenderer();
    const s = state({
      otherModeH: TWO_CYCLES, otherModeL: FOG_BLEND, geometryMode: FOG, combine: combine([15, 15, 31, 3], [7, 7, 7, 6]),
      primColor: { r: 0, g: 0, b: 0, a: 255, minLod: 0, lodFrac: 0 }, fogColor: { r: 255, g: 255, b: 255, a: 0 },
    });
    soft.drawTask(task(screen(s, 0, 1, alpha)));
    return pixel(soft.image(IMAGE)!, 160, 120)[0];
  };

  it('fades to the fog colour with the shade alpha, which carries the fog factor', () => {
    expect(fogged(0)).toBe(0);
    expect(fogged(0.5)).toBeGreaterThan(120);
    expect(fogged(0.5)).toBeLessThan(135);
    expect(fogged(1)).toBe(255);
  });
});

describe('shade interpolation', () => {
  // A triangle from the eye's near side (w = 1, colour 0) to its far side (w = 4, colour 1): halfway across the screen the
  // texture coordinate is corrected for perspective, the colour is simply the average of the two.
  it('is linear in screen space while texture coordinates are corrected for perspective', () => {
    const soft = new SoftRenderer();
    const s = state({ combine: combine([15, 15, 31, 4], [7, 7, 7, 6]) });
    // x and y are in clip space, so the screen x of a vertex is x / w: -1 / 1 and 4 / 4 put the two ends at -1 and 1.
    const batch: TriangleBatch = {
      kind: 'triangles', state: s,
      positions: Float32Array.of(-1, -1, 0, 1, 4, -1, 0, 4, -1, 1, 0, 1),
      colors: Float32Array.of(0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1),
      uvs: new Float32Array(6),
    };
    soft.drawTask(task(batch));
    const mid = pixel(soft.image(IMAGE)!, 160, 150)[0];
    expect(mid).toBeGreaterThan(110);
    expect(mid).toBeLessThan(145);
  });
});

describe('texture filtering', () => {
  const bilerp = 2 << 12;
  const draw = (otherModeH: number) => {
    const soft = new SoftRenderer();
    const s = state({ otherModeH, combine: TEXEL_TIMES_SHADE, textures: [strip([[0, 0, 0, 255], [255, 255, 255, 255]]), null] });
    soft.drawTask(task(screen(s, 0, 2)));
    return soft.image(IMAGE)!;
  };

  it('blends neighbouring texels with the three-point filter, and takes the nearest one without it', () => {
    // The two texels meet at x = 160: halfway between their centres the filtered colour is the average.
    expect(pixel(draw(bilerp), 160, 120)[0]).toBeGreaterThan(110);
    expect(pixel(draw(bilerp), 160, 120)[0]).toBeLessThan(145);
    expect(pixel(draw(0), 150, 120)[0]).toBe(0);
    expect(pixel(draw(0), 170, 120)[0]).toBe(255);
  });

  it('does not filter a copy-mode rectangle', () => {
    expect(pixel(draw(bilerp | (2 << 20)), 150, 120)[0]).toBe(0);
  });
});

describe('depth modes', () => {
  const COMPARE_AND_UPDATE = 0x30;
  const DECAL = 3 << 10;
  const ZBUFFER = 1;
  const draw = (decal: boolean) => {
    const soft = new SoftRenderer();
    const ground = state({ geometryMode: ZBUFFER, otherModeL: COMPARE_AND_UPDATE, combine: combine([15, 15, 31, 3], [7, 7, 7, 6]), primColor: { r: 200, g: 0, b: 0, a: 255, minLod: 0, lodFrac: 0 } });
    const path = state({ geometryMode: ZBUFFER, otherModeL: (decal ? DECAL : 0) | 0x10, combine: combine([15, 15, 31, 3], [7, 7, 7, 6]), primColor: { r: 0, g: 200, b: 0, a: 255, minLod: 0, lodFrac: 0 } });
    // The second surface lies on the first but is a hair behind it at the sample point.
    soft.drawTask(task(screen(ground, 0.5), screen(path, 0.5 + 1e-7)));
    return pixel(soft.image(IMAGE)!, 160, 120);
  };

  it('lets a decal lie on the surface under it', () => {
    expect(draw(true)).toEqual([0, 200, 0]);
  });

  it('hides a surface that is behind another one when it is not a decal', () => {
    expect(draw(false)).toEqual([200, 0, 0]);
  });
});
