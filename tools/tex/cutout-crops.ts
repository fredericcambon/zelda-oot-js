// `npx tsx tools/tex/cutout-crops.ts [--dir out/tex-compare-cutout]`: cuts 1:1 crops (CROPS below) out of the pairs that
// cutout-compare.ts wrote, as `<crop>-hard.png` and `<crop>-smooth.png`, and writes the swipe-slider page `index.html`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { encodePng } from '../gfx/png.ts';
import { decodePng } from './png-read.ts';

const { values } = parseArgs({ options: { dir: { type: 'string', default: 'out/tex-compare-cutout' } } });
const dir = values.dir!;

interface Crop {
  name: string;
  view: string;
  x: number;
  y: number;
  w: number;
  h: number;
  caption: string;
}
const CROPS: Crop[] = JSON.parse(readFileSync(join(dir, 'crops.json'), 'utf8'));

for (const c of CROPS) {
  for (const mode of ['hard', 'smooth']) {
    const image = decodePng(readFileSync(join(dir, `${c.view}-${mode}.png`)));
    const out = new Uint8Array(c.w * c.h * 4);
    for (let y = 0; y < c.h; y++) out.set(image.rgba.subarray(((c.y + y) * image.width + c.x) * 4, ((c.y + y) * image.width + c.x + c.w) * 4), y * c.w * 4);
    writeFileSync(join(dir, `${c.name}-${mode}.png`), encodePng(c.w, c.h, out));
  }
}

const views = readdirSync(dir).filter((f) => f.endsWith('-smooth.png') && /^v\d/.test(f)).map((f) => f.replace('-smooth.png', '')).sort();
const section = (title: string, base: string, caption: string, zoom: number) => `
<h2>${title}</h2>
<p>${caption}</p>
<div class="swipe" data-zoom="${zoom}">
  <img class="under" src="${base}-hard.png" alt="hard">
  <div class="over"><img src="${base}-smooth.png" alt="smooth"></div>
  <div class="handle"><span></span></div>
  <b class="l">smooth</b><b class="r">hard</b>
</div>`;

const html = `<!doctype html>
<meta charset="utf-8">
<title>Cut-out edges: hard against smooth</title>
<style>
  body { background: #151515; color: #ddd; font: 14px system-ui, sans-serif; margin: 16px auto; max-width: 1940px; padding: 0 12px; }
  h2 { margin: 28px 0 4px; font-size: 16px; }
  p { margin: 0 0 8px; color: #999; }
  .swipe { position: relative; display: inline-block; line-height: 0; touch-action: none; user-select: none; cursor: ew-resize; max-width: 100%; }
  .swipe img { -webkit-user-drag: none; display: block; max-width: 100%; height: auto; }
  .swipe.pixel img { image-rendering: pixelated; }
  .swipe .over { position: absolute; inset: 0; overflow: hidden; clip-path: inset(0 50% 0 0); }
  .swipe .handle { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: #fff; box-shadow: 0 0 4px #000; pointer-events: none; }
  .swipe .handle span { position: absolute; top: 50%; left: -13px; width: 28px; height: 28px; margin-top: -14px; border-radius: 50%; background: #fff; opacity: .8; }
  .swipe b { position: absolute; top: 6px; padding: 2px 6px; background: #000a; color: #fff; font-size: 12px; line-height: 1.2; pointer-events: none; }
  .swipe b.l { left: 6px; } .swipe b.r { right: 6px; }
</style>
<h1>Cut-out edges: <code>cutout: smooth</code> (left) against <code>hard</code> (right)</h1>
<p>Drag the divider, with mouse or touch. 1920x1440, MSAA x4, mip levels on, n64 filter. Both sides are the same game frame.</p>
${CROPS.map((c) => section(`${c.name}: ${c.caption}`, c.name, `1:1 crop of ${c.view} at (${c.x}, ${c.y}), ${c.w}x${c.h}, shown at ${Math.floor(960 / c.w)}x.`, Math.floor(960 / c.w))).join('')}
${views.map((v) => section(v, v, 'Full frame.', 1)).join('')}
<script>
  for (const el of document.querySelectorAll('.swipe')) {
    const zoom = Number(el.dataset.zoom);
    const images = el.querySelectorAll('img');
    for (const img of images) img.draggable = false;
    const size = () => {
      // Both images are drawn at the same size, so the divider reveals the hard one under the smooth one.
      const w = images[0].naturalWidth * zoom;
      if (w === 0) return;
      el.style.width = w + 'px';
      for (const img of images) { img.style.width = w + 'px'; img.style.maxWidth = 'none'; }
    };
    if (zoom > 1) {
      el.classList.add('pixel');
      for (const img of images) img.complete ? size() : img.addEventListener('load', size);
    }
    const set = (clientX) => {
      const r = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      el.querySelector('.over').style.clipPath = 'inset(0 ' + (1 - f) * 100 + '% 0 0)';
      el.querySelector('.handle').style.left = f * 100 + '%';
    };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); set(e.clientX); });
    el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(e.clientX); });
  }
</script>
`;
writeFileSync(join(dir, 'index.html'), html);
console.log(`${CROPS.length} crops, ${views.length} views`);
