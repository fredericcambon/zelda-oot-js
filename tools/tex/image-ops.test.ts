import { describe, expect, it } from 'vitest';
import { encodePng } from '../gfx/png.ts';
import type { RgbaImage } from '../gfx/types.ts';
import { bleedColour, resample, edgeIndex, modelInput, upscaleTexture } from './image-ops.ts';
import { decodePng } from './png-read.ts';

const image = (width: number, height: number, texel: (x: number, y: number) => [number, number, number, number]): RgbaImage => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(texel(x, y), (y * width + x) * 4);
  return { width, height, rgba };
};
const pixel = (img: RgbaImage, x: number, y: number): number[] => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

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

describe('resample', () => {
  it('keeps a flat picture flat at every scale and kernel', () => {
    for (const scale of [2, 4]) for (const kernel of ['linear', 'cubic'] as const) {
      const out = resample(image(3, 3, () => [90, 40, 7, 255]), scale, kernel);
      expect([out.width, out.height]).toEqual([3 * scale, 3 * scale]);
      expect(pixel(out, 2, 5)).toEqual([90, 40, 7, 255]);
    }
  });

  it('interpolates a ramp at quarter steps (bilinear x2) and stays in range (bicubic)', () => {
    const ramp = resample(image(2, 1, (x) => [x * 100, 0, 0, 255]), 2, 'linear');
    expect(Array.from({ length: 4 }, (_, x) => pixel(ramp, x, 0)[0])).toEqual([0, 25, 75, 100]);
    const step = resample(image(4, 1, (x) => [x < 2 ? 0 : 255, 0, 0, 255]), 4, 'cubic');
    for (let x = 0; x < 16; x++) expect(pixel(step, x, 0)[0]).toBeGreaterThanOrEqual(0);
    expect(pixel(step, 0, 0)[0]).toBe(0);
    expect(pixel(step, 15, 0)[0]).toBe(255);
  });
});

describe('upscaleTexture', () => {
  const options = { pad: 4, blend: 1, scale: 2 };
  const facts = { edgeS: 'wrap', edgeT: 'wrap', alpha: 'opaque', gray: false } as const;
  const nearest = (img: RgbaImage, k: number): RgbaImage => image(img.width * k, img.height * k, (x, y) => pixel(img, (x / k) | 0, (y / k) | 0) as [number, number, number, number]);

  it('multiplies the size, at scale 2 and 4', () => {
    const tile = image(4, 4, (x) => [x * 60, 30, 30, 255]);
    for (const scale of [2, 4]) {
      const big = upscaleTexture(tile, facts, { ...options, scale }, nearest(modelInput(tile, facts, options.pad), scale));
      expect([big.width, big.height]).toEqual([4 * scale, 4 * scale]);
      expect(pixel(big, 0, 0)).toEqual([0, 30, 30, 255]);
    }
  });

  it('pads a wrapping tile with its other side', () => {
    const tile = image(4, 4, (x) => [x * 60, 30, 30, 255]);
    const padded = nearest(modelInput(tile, facts, options.pad), 2);
    expect(pixel(padded, (options.pad + 4) * 2, 0)).toEqual(pixel(padded, options.pad * 2, 0));
  });

  it('never lets the model touch alpha, keeps the silhouette as a gradient and leaves no colour from transparent texels', () => {
    const leaf = image(4, 4, (x) => (x < 2 ? [20, 200, 20, 255] : [255, 0, 255, 0]));
    const cut = { edgeS: 'clamp', edgeT: 'clamp', alpha: 'binary', gray: false } as const;
    const model = nearest(modelInput(leaf, cut, options.pad), 2);
    for (let i = 3; i < model.rgba.length; i += 4) model.rgba[i] = 0;
    const big = upscaleTexture(leaf, cut, options, model);
    const row = Array.from({ length: 8 }, (_, x) => pixel(big, x, 3));
    const alpha = row.map((p) => p[3]!);
    expect(alpha.slice(0, 2)).toEqual([255, 255]);
    expect(alpha.slice(-2)).toEqual([0, 0]);
    expect(alpha.some((v) => v > 0 && v < 255)).toBe(true);
    expect(alpha).toEqual([...alpha].sort((x, y) => y - x));
    for (const p of row) expect(p.slice(0, 3)).toEqual([20, 200, 20]);
  });

  it('blends the model and plain bilinear, and keeps gray textures gray', () => {
    const grey = image(2, 2, (x) => [x * 100, x * 100, x * 100, 255]);
    const flat = { edgeS: 'clamp', edgeT: 'clamp', alpha: 'opaque', gray: true } as const;
    const model = (img: RgbaImage): RgbaImage => image(img.width * 2, img.height * 2, () => [200, 100, 0, 255]);
    const out = upscaleTexture(grey, flat, { pad: 2, blend: 0.5, scale: 2 }, model(modelInput(grey, flat, 2)));
    const [r, g, b] = pixel(out, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(50);
  });
});
