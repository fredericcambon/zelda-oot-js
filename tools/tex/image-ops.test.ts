import { describe, expect, it } from 'vitest';
import { encodePng } from '../gfx/png.ts';
import type { RgbaImage } from '../gfx/types.ts';
import { bilinear2x, bleedColour, edgeIndex, modelInput, upscaleTexture } from './image-ops.ts';
import { decodePng } from './png-read.ts';

const image = (width: number, height: number, texel: (x: number, y: number) => [number, number, number, number]): RgbaImage => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(texel(x, y), (y * width + x) * 4);
  return { width, height, rgba };
};
const pixel = (img: RgbaImage, x: number, y: number): number[] => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
/** What a model that only repeats every texel into a 2x2 block gives. */
const nearest2x = (img: RgbaImage): RgbaImage => image(img.width * 2, img.height * 2, (x, y) => pixel(img, x >> 1, y >> 1) as [number, number, number, number]);

describe('edgeIndex', () => {
  it('continues a tile as the sampler reads it', () => {
    expect([-2, -1, 0, 3, 4, 5].map((i) => edgeIndex(i, 4, 'wrap'))).toEqual([2, 3, 0, 3, 0, 1]);
    expect([-2, -1, 0, 3, 4, 5].map((i) => edgeIndex(i, 4, 'mirror'))).toEqual([1, 0, 0, 3, 3, 2]);
    expect([-2, -1, 0, 3, 4, 5].map((i) => edgeIndex(i, 4, 'clamp'))).toEqual([0, 0, 0, 3, 3, 3]);
  });
});

describe('png reader', () => {
  it('reads what encodePng writes', () => {
    const img = image(3, 2, (x, y) => [x * 40, y * 90, 7, x * 50 + y]);
    expect(decodePng(encodePng(3, 2, img.rgba))).toEqual(img);
  });
});

describe('bleedColour', () => {
  it('fills transparent texels from the nearest visible one and leaves alpha alone', () => {
    const img = image(4, 1, (x) => (x === 0 ? [10, 20, 30, 255] : x === 3 ? [200, 0, 0, 255] : [0, 0, 0, 0]));
    const out = bleedColour(img);
    expect(pixel(out, 1, 0)).toEqual([10, 20, 30, 0]);
    expect(pixel(out, 2, 0)).toEqual([200, 0, 0, 0]);
    expect(pixel(out, 0, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe('bilinear2x', () => {
  it('keeps a flat picture flat and interpolates a ramp at quarter steps', () => {
    expect(pixel(bilinear2x(image(2, 2, () => [90, 90, 90, 255])), 3, 3)).toEqual([90, 90, 90, 255]);
    const ramp = bilinear2x(image(2, 1, (x) => [x * 100, 0, 0, 255]));
    expect(Array.from({ length: 4 }, (_, x) => pixel(ramp, x, 0)[0])).toEqual([0, 25, 75, 100]);
  });
});

describe('upscaleTexture', () => {
  const options = { pad: 4, blend: 1 };
  const facts = { edgeS: 'wrap', edgeT: 'wrap', alpha: 'opaque', gray: false } as const;

  it('doubles the size and, for a tile that wraps, matches across the seam', () => {
    const tile = image(4, 4, (x) => [x * 60, 30, 30, 255]);
    const big = upscaleTexture(tile, facts, options, nearest2x(modelInput(tile, facts, options.pad)));
    expect([big.width, big.height]).toEqual([8, 8]);
    // Beyond the right edge the tile repeats: the texel there is the first column, as nearest padding gave the model.
    const padded = nearest2x(modelInput(tile, facts, options.pad));
    expect(pixel(padded, (options.pad + 4) * 2, 0)).toEqual(pixel(padded, options.pad * 2, 0));
    expect(pixel(big, 0, 0)).toEqual([0, 30, 30, 255]);
  });

  it('keeps a cut-out crisp, with no colour from the transparent texels on its edge', () => {
    const leaf = image(4, 4, (x) => (x < 2 ? [20, 200, 20, 255] : [255, 0, 255, 0]));
    const cut = { edgeS: 'clamp', edgeT: 'clamp', alpha: 'binary', gray: false } as const;
    const big = upscaleTexture(leaf, cut, options, nearest2x(modelInput(leaf, cut, options.pad)));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const [r, g, b, a] = pixel(big, x, y) as [number, number, number, number];
        expect(a === 0 || a === 255).toBe(true);
        expect([r, g, b]).toEqual([20, 200, 20]);
      }
    }
    expect(Array.from({ length: 8 }, (_, x) => pixel(big, x, 3)[3])).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
  });

  it('blends the model and plain bilinear, and keeps gray textures gray', () => {
    const grey = image(2, 2, (x) => [x * 100, x * 100, x * 100, 255]);
    const flat = { edgeS: 'clamp', edgeT: 'clamp', alpha: 'opaque', gray: true } as const;
    const model = (img: RgbaImage): RgbaImage => image(img.width * 2, img.height * 2, () => [200, 100, 0, 255]);
    const out = upscaleTexture(grey, flat, { pad: 2, blend: 0.5 }, model(modelInput(grey, flat, 2)));
    const [r, g, b] = pixel(out, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(50);
  });
});
