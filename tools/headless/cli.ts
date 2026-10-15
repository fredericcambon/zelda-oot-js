// `npm run headless -- --frames N [--trace]`: boots the built game (dist/oot.js) in Node with no display and
// reports what it did frame by frame.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { romPathFromEnv } from '../analyze/context.ts';
import { DisplayListInterpreter } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { DlTotals } from '../gfx/totals.ts';
import { bootGame, type Game } from './boot.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rom: { type: 'string' },
      dist: { type: 'string', default: 'dist' },
      frames: { type: 'string', default: '300' },
      trace: { type: 'boolean', default: false },
      dl: { type: 'boolean', default: false },
      dump: { type: 'string' },
      'dump-every': { type: 'string', default: '1' },
      'dump-from': { type: 'string', default: '0' },
    },
  });
  const frames = Number(values.frames);
  const rom = readFileSync(romPathFromEnv(values.rom));
  const interpreter = new DisplayListInterpreter();
  const totals = new DlTotals();
  const soft = values.dump ? new SoftRenderer() : undefined;
  const dumpDir = values.dump ? resolve(values.dump) : undefined;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });
  const dumpEvery = Math.max(1, Number(values['dump-every']));
  // Frames before this one are not drawn: each frame is redrawn whole, so only the speed changes.
  const dumpFrom = Number(values['dump-from']);
  let frameNo = 0;
  let game: Game;
  try {
    game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, rom, {
      onGfxTask: values.dl || soft
        ? (task) => {
            const result = interpreter.run(task.ram, task.data);
            if (values.dl) totals.add(result);
            if (frameNo >= dumpFrom - 2) soft?.drawTask(result);
          }
        : undefined,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (let k = 0; k < frames; k++) {
    frameNo++;
    const r = await game.frame();
    if (values.trace || r.newThreads.length > 0) {
      console.log(
        `frame ${r.frame}: retraces=${r.retraces} gfx=${r.gfxTasks} audio=${r.audioTasks}` +
          r.newThreads.map((t) => `\n  new thread ${t}`).join('') +
          (values.trace ? r.threadStates.map((t) => `\n  ${t}`).join('') : ''),
      );
    }
    if (r.fatal || !r.alive) {
      const calls = game.lastCalls(40);
      if (calls.length > 0) console.error(`last calls, newest first: ${calls.join(' ')}`);
    }
    if (soft && dumpDir && r.frame % dumpEvery === 0 && r.frame >= dumpFrom) {
      const img = soft.image(game.framebuffer());
      if (img) writeFileSync(join(dumpDir, `frame-${String(r.frame).padStart(5, '0')}.png`), encodePng(WIDTH, HEIGHT, img));
    }
    if (r.fatal) {
      console.error(`trap at frame ${r.frame}: ${r.fatal}`);
      return 2;
    }
    if (!r.alive) {
      console.error(`nothing can run any more at frame ${r.frame}`);
      return 3;
    }
  }
  console.log(`booted ${frames} frames: ${game.stats()}`);
  if (!values.dl) return 0;
  console.log(totals.summary());
  return totals.unknown.length > 0 ? 4 : 0;
}

process.exitCode = await main();
