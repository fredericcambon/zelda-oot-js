import { describe, expect, it } from 'vitest';
import type { DecodedTexture } from '../tools/gfx/types.ts';
import { isLowContrast, MAX_STEP, softened } from './low-contrast.ts';

let nextId = 1;

/** A 32x32 image of a horizontal ramp whose value rises by one `step` every texel, with `edgeRows` rows whose left half is raised by `jump`. */
function image(step: number, jump = 0, edgeRows = 0): DecodedTexture {
  const width = 32, height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = step * x + (y < edgeRows && x < 16 ? jump : 0);
      rgba.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { id: nextId++, tile: 0, width, height, rgba };
}

/** Alternating black and white texels. */
function checker(): DecodedTexture {
  const t = image(0);
  for (let i = 0; i < 32 * 32; i++) t.rgba.set([(i + (i >> 5)) % 2 ? 255 : 0], i * 4);
  return t;
}

describe('isLowContrast', () => {
  it('accepts a gradient whose steps stay within the limit', () => {
    expect(isLowContrast(image(0))).toBe(true);
    expect(isLowContrast(image(MAX_STEP / 4))).toBe(true);
  });

  it('accepts a gradient with a few sharper edges', () => {
    expect(isLowContrast(image(2, 100, 1))).toBe(true);
  });

  it('rejects a texture with many sharp edges', () => {
    expect(isLowContrast(image(MAX_STEP * 2))).toBe(false);
    expect(isLowContrast(checker())).toBe(false);
  });

  it('gives the same answer again for the same image', () => {
    const t = image(2);
    expect(isLowContrast(t)).toBe(isLowContrast(t));
  });
});

describe('softened', () => {
  it('turns single-texel noise into a flat value and leaves a flat image alone', () => {
    const t = checker();
    const out = softened(t);
    expect(Math.max(...Array.from({ length: 30 * 30 }, (_, i) => out[((i % 30 + 1) + (Math.floor(i / 30) + 1) * 32) * 4]!)) - Math.min(...Array.from({ length: 30 * 30 }, (_, i) => out[((i % 30 + 1) + (Math.floor(i / 30) + 1) * 32) * 4]!))).toBeLessThanOrEqual(1);
    const flat = image(0);
    expect(softened(flat)).toEqual(flat.rgba);
  });
});
