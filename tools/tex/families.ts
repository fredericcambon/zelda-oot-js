// Finds textures that differ only in their upper half: the game drew a tile taller than what was loaded into it, so the rows that were never
// loaded show whatever the texture memory held (another texture's bytes) and the decoded picture changes with it. Each variant has its own hash.
import { createHash } from 'node:crypto';
import type { RgbaImage } from '../gfx/types.ts';

/** Groups of textures of one size whose lower halves are identical, with at least `minSize` members, as lists of hashes. */
export function partialFamilies(textures: Iterable<{ hash: string; image: RgbaImage }>, minSize = 3): string[][] {
  const groups = new Map<string, string[]>();
  for (const { hash, image } of textures) {
    if (image.height < 2) continue;
    const half = image.height >> 1;
    const lower = image.rgba.subarray((image.height - half) * image.width * 4);
    const key = `${image.width}x${image.height}:${createHash('sha1').update(lower).digest('hex')}`;
    groups.set(key, [...(groups.get(key) ?? []), hash]);
  }
  return [...groups.values()].filter((g) => g.length >= minSize);
}
