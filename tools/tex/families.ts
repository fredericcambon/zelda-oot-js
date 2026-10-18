// Finds textures that differ only in their upper half: the tile is taller than what the game loaded, so the rows that were never loaded show whatever
// the texture memory held (other textures' bytes) and the decoded picture, and so its hash, changes with it. The lower half is the same in each.
import type { RgbaImage } from '../gfx/types.ts';
import { hashLowerHalf } from './hash.ts';

/** Groups of textures of one size whose lower halves are identical, with at least `minSize` members: lower-half key to hashes. */
export function partialFamilies(textures: Iterable<{ hash: string; image: RgbaImage }>, minSize = 3): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { hash, image } of textures) {
    if (image.height < 2) continue;
    const key = hashLowerHalf(image.width, image.height, image.rgba);
    groups.set(key, [...(groups.get(key) ?? []), hash]);
  }
  return new Map([...groups].filter(([, g]) => g.length >= minSize));
}
