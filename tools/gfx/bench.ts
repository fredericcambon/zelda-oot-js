// Headless speed of the display-list interpreter: plays the scripted new game and runs every graphics task through the chosen
// one. Usage: tsx tools/gfx/bench.ts [--dist dist] [--rom file] [--frames 6000] [--mode none|c|c-read]
//   none    the game alone
//   c       the interpreter in the module, its buffers left unread
//   c-read  the same, and the result read into a DisplayListResult
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { startModule, type OotCore } from '../runtime/instance.ts';
import { readResult, type GfxCore } from './c-dl.ts';

interface GameCore extends OotCore, GfxCore {
  _oot_gfx_tasks(): number;
  _gfx_run(start: number): number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { dist: { type: 'string', default: 'dist' }, rom: { type: 'string' }, frames: { type: 'string', default: '6000' }, mode: { type: 'string', default: 'c' } } });
  const frames = Number(values.frames);
  const mode = values.mode!;
  const script = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');
  let spent = 0;
  const mod = await startModule<GameCore>(pathToFileURL(resolve(values.dist!, 'oot.js')).href, values.rom ? new Uint8Array(readFileSync(values.rom)) : readCartridge(join(resolve(values.dist!), 'assets')), {
    onGfxTask: (data: number) => {
      const t0 = performance.now();
      if (mode === 'c' || mode === 'c-read') {
        mod._gfx_run(data >>> 0);
        if (mode === 'c-read') readResult(mod);
      }
      spent += performance.now() - t0;
    },
  });
  const start = performance.now();
  for (let k = 1; k <= frames; k++) {
    const pad = padAt(script, k);
    mod._oot_pad_set(0, pad.buttons, pad.x, pad.y);
    await mod._oot_frame();
  }
  const seconds = (performance.now() - start) / 1000;
  const tasks = mod._oot_gfx_tasks();
  console.log(
    `${mode}: ${frames} video frames and ${tasks} game frames in ${seconds.toFixed(2)} s: ${(frames / seconds).toFixed(0)} video frames/s, ` +
      `${(tasks / seconds).toFixed(0)} game frames/s; display lists ${((spent / tasks)).toFixed(3)} ms per game frame`,
  );
}

await main();
