import { describe, expect, it } from 'vitest';
import { partialFamilies } from './families.ts';

const image = (upper: number, lower: number) => ({ width: 2, height: 4, rgba: Uint8Array.from({ length: 32 }, (_, i) => (i < 16 ? upper : lower)) });

describe('partialFamilies', () => {
  it('groups textures with the same lower half and different upper halves', () => {
    const families = partialFamilies([
      { hash: 'a', image: image(1, 9) }, { hash: 'b', image: image(2, 9) }, { hash: 'c', image: image(3, 9) }, { hash: 'd', image: image(1, 8) },
    ]);
    expect(families).toEqual([['a', 'b', 'c']]);
  });
});
