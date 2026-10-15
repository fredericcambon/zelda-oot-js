// `npm run headless -- --frames N [--trace]`: boots the built game (dist/oot.js) in Node with no display and
// reports what it did frame by frame.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { romPathFromEnv } from '../analyze/context.ts';
import { DisplayListInterpreter } from '../gfx/dl.ts';
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
    },
  });
  const frames = Number(values.frames);
  const rom = readFileSync(romPathFromEnv(values.rom));
  const interpreter = new DisplayListInterpreter();
  const totals = new DlTotals();
  let game: Game;
  try {
    game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, rom, {
      onGfxTask: values.dl ? (task) => totals.add(interpreter.run(task.ram, task.data)) : undefined,
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (let k = 0; k < frames; k++) {
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
