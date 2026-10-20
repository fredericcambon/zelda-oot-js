// `npx tsx tools/gfx/px-light-diff.ts [dir]`: compares the vertex and pixel pictures px-light-capture.ts wrote (mean and largest difference per channel, share of pixels
// that differ by more than 8/255) and writes a difference picture, amplified four times, beside them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffImage, diffStats, formatDiff } from './image-ops.ts';
import { encodePng } from './png.ts';
import { decodePng } from '../tex/png-read.ts';

const dir = process.argv[2] ?? 'out/px-light';
for (const scene of ['forest', 'house']) {
  const a = decodePng(readFileSync(join(dir, `${scene}-vertex.png`))), b = decodePng(readFileSync(join(dir, `${scene}-pixel.png`)));
  console.log(`${scene}: ${formatDiff(diffStats(a, b))}`);
  const d = diffImage(a, b);
  writeFileSync(join(dir, `${scene}-diff.png`), encodePng(d.width, d.height, d.rgba));
}
