import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { bootGame } from '../headless/boot.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { DisplayListInterpreter } from './dl.ts';
import { DlTotals } from './totals.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 600;

describe.skipIf(!rom || !existsSync(rom))('display lists of the booted game', () => {
  it('parses every graphics task of 600 frames with documented commands only', async () => {
    const work = resolve('out', 'headless-test-gfx');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(opts, await compileAll(opts, runtimeSources()));

    const interpreter = new DisplayListInterpreter();
    const totals = new DlTotals();
    let textured = 0;
    const game = await bootGame(pathToFileURL(out).href, new Uint8Array(readFileSync(rom!)), {
      onGfxTask: (task) => {
        const r = interpreter.run(task.ram, task.data);
        for (const b of r.batches) if (b.state.textures[0]) textured++;
        totals.add(r);
      },
    });
    for (let k = 1; k <= FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
    }

    expect(totals.unknown, totals.summary()).toEqual([]);
    expect(totals.problems, totals.summary()).toEqual([]);
    expect(totals.tasks).toBeGreaterThan(300);
    expect(totals.triangles).toBeGreaterThan(100_000);
    expect(textured).toBeGreaterThan(10_000);
  }, 3_600_000);
});
