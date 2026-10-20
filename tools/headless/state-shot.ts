// `npx tsx tools/headless/state-shot.ts --state <state-N.bin> --out out/soft/name [--hz 60] [--frames 6] [--every 1]`: loads a saved state (the browser's, gzipped, from a saves
// folder) into the built game in Node, runs frames, and writes the software renderer's picture of each as a PNG. Only for comparing it with the browser renderer
// on the same moment. Needs `dist/` from `npm run port`. Pictures come from the ROM, so they stay under `out/`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { decompressState } from '../runtime/snapshot.ts';
import { bootGame } from './boot.ts';

const { values } = parseArgs({
  options: {
    state: { type: 'string' },
    out: { type: 'string' },
    hz: { type: 'string', default: '60' },
    frames: { type: 'string', default: '6' },
    every: { type: 'string', default: '1' },
    dist: { type: 'string', default: 'dist' },
  },
});
if (!values.state || !values.out) throw new Error('--state and --out are required');
const hz = Number(values.hz) === 50 ? 50 : 60;
const soft = new SoftRenderer();
mkdirSync(resolve(values.out), { recursive: true });
const game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, readCartridge(join(resolve(values.dist!), 'assets')), {
  hz,
  onGfxTask: (task) => soft.drawTask(task.displayList()),
});
await game.loadState(await decompressState(readFileSync(values.state)));
for (let f = 1; f <= Number(values.frames); f++) {
  const r = await game.frame();
  if (r.fatal) throw new Error(`frame ${f}: ${r.fatal}`);
  if (f % Number(values.every) === 0) {
    const img = soft.image(game.framebuffer());
    if (img) writeFileSync(join(resolve(values.out), `frame-${String(f).padStart(3, '0')}.png`), encodePng(WIDTH, HEIGHT, img));
  }
}
