import { describe, expect, it } from 'vitest';
import { hashTexture } from './hash.ts';

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

  it('depends on the size and on every texel', () => {
    const base = hashTexture(4, 4, texels);
    expect(hashTexture(8, 2, texels)).not.toBe(base);
    for (const i of [0, 31, 63]) {
      const changed = texels.slice();
      changed[i] = changed[i]! ^ 1;
      expect(hashTexture(4, 4, changed)).not.toBe(base);
    }
  });
});
