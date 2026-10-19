// `npx tsx tools/gfx/px-light-diff.ts [dir]`: compares the vertex and pixel pictures px-light-capture.ts wrote (mean and largest difference per channel, share of pixels
// that differ by more than 8/255) and writes a difference picture, amplified four times, beside them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from './png.ts';
import { decodePng } from '../tex/png-read.ts';

const dir = process.argv[2] ?? 'out/px-light';
for (const scene of ['forest', 'house']) {
  const a = decodePng(readFileSync(join(dir, `${scene}-vertex.png`))), b = decodePng(readFileSync(join(dir, `${scene}-pixel.png`)));
  const diff = new Uint8Array(a.width * a.height * 4);
  let sum = 0, max = 0, over = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.rgba[i * 4 + k]! - b.rgba[i * 4 + k]!);
      sum += d;
      worst = Math.max(worst, d);
      diff[i * 4 + k] = Math.min(255, d * 4);
    }
    diff[i * 4 + 3] = 255;
    max = Math.max(max, worst);
    if (worst > 8) over++;
  }
  console.log(`${scene}: mean ${(sum / (a.width * a.height * 3)).toFixed(2)}/255, max ${max}, ${((100 * over) / (a.width * a.height)).toFixed(1)}% of pixels differ by more than 8`);
  writeFileSync(join(dir, `${scene}-diff.png`), encodePng(a.width, a.height, diff));
}
