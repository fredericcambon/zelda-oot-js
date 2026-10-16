import { describe, expect, it } from 'vitest';
import { decodeCombine, type DecodedTexture, type DisplayListResult, type DrawState, type TileState, type TriangleBatch } from './dl.ts';
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
    fog: { multiplier: 0, offset: 0 }, colorImage: { fmt: 0, siz: 3, width: 320, addr: IMAGE }, depthImage: 0, ...over,
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

/** Two triangles over the whole screen at clip depth `z` (w = 1), texture coordinates spanning `uSpan` texels across. */
function screen(s: DrawState, z = 0, uSpan = 1): TriangleBatch {
  const corners = [[-1, 1, 0, 0], [-1, -1, 0, 1], [1, -1, uSpan, 1], [-1, 1, 0, 0], [1, -1, uSpan, 1], [1, 1, uSpan, 0]] as const;
  return {
    kind: 'triangles',
    state: s,
    positions: Float32Array.from(corners.flatMap(([x, y]) => [x, y, z, 1])),
    colors: new Float32Array(24).fill(1),
    uvs: Float32Array.from(corners.flatMap(([, , u, v]) => [u, v])),
    fog: new Float32Array(6),
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
    const shadow = screen(shadowState);
    soft.drawTask(task(screen(floor), shadow));
    return pixel(soft.image(IMAGE)!, 160, 120);
  };

  it('darkens the ground', () => {
    const [r, g, b] = shadowOver(160);
    expect(Math.max(r, g, b)).toBeLessThan(20);
  });
});
