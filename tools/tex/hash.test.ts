import { describe, expect, it } from 'vitest';
import { hashImage, hashTexture } from './hash.ts';

describe('hashTexture', () => {
  const texels = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 255);

  it('is sixteen hex digits and stable', () => {
    expect(hashTexture(4, 4, texels)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashTexture(4, 4, texels.slice())).toBe(hashTexture(4, 4, texels));
  });

  it('reads a view at its own offset', () => {
    const padded = new Uint8Array(70);
    padded.set(texels, 3);
    expect(hashTexture(4, 4, padded.subarray(3, 67))).toBe(hashTexture(4, 4, texels));
  });

  it('depends on the size, the format and every texel', () => {
    const base = hashTexture(4, 4, texels);
    expect(hashTexture(8, 2, texels)).not.toBe(base);
    expect(hashTexture(4, 4, texels, null, 3, 1)).not.toBe(base);
    expect(hashTexture(4, 4, texels, null, 0, 2)).not.toBe(hashTexture(4, 4, texels, null, 0, 1));
    for (const i of [0, 31, 63]) {
      const changed = texels.slice();
      changed[i] = changed[i]! ^ 1;
      expect(hashTexture(4, 4, changed)).not.toBe(base);
    }
  });

  it('ignores texels that were not loaded and follows which ones those are', () => {
    const loaded = Uint8Array.from({ length: 16 }, (_, i) => (i < 8 ? 0 : 1));
    const stale = texels.slice();
    for (let i = 0; i < 32; i++) stale[i] = 255 - i;
    const image = { width: 4, height: 4, rgba: texels, loaded };
    expect(hashImage({ ...image, rgba: stale })).toBe(hashImage(image));
    expect(hashImage({ ...image, loaded: Uint8Array.from(loaded, (v, i) => (i >= 12 ? 0 : v)) })).not.toBe(hashImage(image));
    const changed = texels.slice();
    changed[40] = changed[40]! ^ 1;
    expect(hashImage({ ...image, rgba: changed })).not.toBe(hashImage(image));
    expect(hashImage({ width: 4, height: 4, rgba: texels, loaded: null })).toBe(hashTexture(4, 4, texels));
  });
});
