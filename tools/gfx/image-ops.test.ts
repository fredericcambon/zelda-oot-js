import { describe, expect, it } from 'vitest';
import { contactSheet, crop, diffImage, diffStats, downscale, formatDiff, parseRegion } from './image-ops.ts';
import { encodePng } from './png.ts';
import { decodePng } from '../tex/png-read.ts';
import type { RgbaImage } from './types.ts';

function make(width: number, height: number, f: (x: number, y: number) => [number, number, number]): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([...f(x, y), 255], (y * width + x) * 4);
  return { width, height, rgba };
}
const px = (img: RgbaImage, x: number, y: number) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

describe('image-ops', () => {
  it('parses a region and rejects bad ones', () => {
    expect(parseRegion('1,2,3,4')).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(() => parseRegion('1,2,3')).toThrow();
    expect(() => parseRegion('1,2,0,4')).toThrow();
  });

  it('crops, clamping to the picture', () => {
    const img = make(8, 6, (x, y) => [x * 10, y * 10, 0]);
    const c = crop(img, { x: 2, y: 1, w: 3, h: 2 });
    expect([c.width, c.height]).toEqual([3, 2]);
    expect(px(c, 0, 0)).toEqual([20, 10, 0]);
    expect(px(c, 2, 1)).toEqual([40, 20, 0]);
    const edge = crop(img, { x: 6, y: 4, w: 10, h: 10 });
    expect([edge.width, edge.height]).toEqual([2, 2]);
    expect(() => crop(img, { x: 20, y: 0, w: 2, h: 2 })).toThrow();
  });

  it('downscales by box average to the longer side, and leaves small pictures alone', () => {
    const img = make(8, 4, (x) => [x < 4 ? 0 : 200, 100, 50]);
    const d = downscale(img, 4);
    expect([d.width, d.height]).toEqual([4, 2]);
    expect(px(d, 0, 0)).toEqual([0, 100, 50]);
    expect(px(d, 3, 1)).toEqual([200, 100, 50]);
    const mixed = downscale(make(4, 2, (x) => [x % 2 ? 100 : 0, 0, 0]), 2);
    expect(px(mixed, 0, 0)).toEqual([50, 0, 0]);
    expect(downscale(img, 8)).toBe(img);
  });

  it('computes difference statistics and the bounding box', () => {
    const a = make(10, 10, () => [100, 100, 100]);
    const b = make(10, 10, (x, y) => (x >= 3 && x <= 5 && y >= 6 && y <= 7 ? [100, 160, 100] : [100, 104, 100]));
    const s = diffStats(a, b);
    expect(s.max).toBe(60);
    expect(s.share).toBeCloseTo(0.06);
    expect(s.box).toEqual({ x: 3, y: 6, w: 3, h: 2 });
    expect(s.mean).toBeCloseTo((94 * 4 + 6 * 60) / 300);
    expect(formatDiff(s)).toBe('diff mean 2.45 max 60 over8 6.0% box 3,6,3,2');
    expect(diffStats(a, a)).toEqual({ mean: 0, max: 0, share: 0, box: null });
    expect(() => diffStats(a, make(9, 10, () => [0, 0, 0]))).toThrow();
  });

  it('amplifies the difference picture', () => {
    const d = diffImage(make(1, 1, () => [10, 50, 0]), make(1, 1, () => [0, 0, 0]));
    expect([...d.rgba]).toEqual([40, 200, 0, 255]);
  });

  it('lays a contact sheet out in a grid within the limit', () => {
    const imgs = [0, 1, 2].map((n) => make(4, 4, () => [n * 50, 0, 0]));
    const s = contactSheet(imgs, 2, 100);
    expect([s.width, s.height]).toEqual([8, 8]);
    expect(px(s, 5, 1)).toEqual([50, 0, 0]);
    expect(px(s, 1, 5)).toEqual([100, 0, 0]);
    const small = contactSheet(imgs, 2, 4);
    expect(Math.max(small.width, small.height)).toBe(4);
  });

  it('round-trips through the PNG codecs', () => {
    const img = make(5, 3, (x, y) => [x * 40, y * 80, 7]);
    const back = decodePng(encodePng(img.width, img.height, img.rgba));
    expect(diffStats(img, back).max).toBe(0);
  });
});
