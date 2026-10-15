import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { bootGame } from './boot.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 300;

describe.skipIf(!rom || !existsSync(rom))('headless boot', () => {
  it('boots 300 video frames with the retrace and a graphics task going on and no trap', async () => {
    const work = resolve('out', 'headless-test-boot');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(opts, await compileAll(opts, runtimeSources()));

    const game = await bootGame(pathToFileURL(out).href, new Uint8Array(readFileSync(rom!)));
    const gfxAt: number[] = [];
    let gfx = 0;
    let threads = 0;
    for (let k = 1; k <= FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      expect(r.alive, `frame ${k}`).toBe(true);
      // The retrace of a frame is counted when it ends; the first one comes with the first full interval.
      expect(r.retraces, `frame ${k}`).toBeGreaterThanOrEqual(k - 1);
      if (r.gfxTasks > gfx) gfxAt.push(k);
      gfx = r.gfxTasks;
      threads += r.newThreads.length;
    }

    expect(gfxAt.length).toBeGreaterThan(150);
    expect(gfxAt[0]).toBeLessThan(60);
    // After the first one the game submits a graphics task every frame, then every third frame once it paces itself
    // at three retraces; the switch between the two modes takes one longer frame.
    for (let k = 1; k < gfxAt.length; k++) expect(gfxAt[k]! - gfxAt[k - 1]!, `gap before frame ${gfxAt[k]}`).toBeLessThanOrEqual(6);
    expect(gfxAt[gfxAt.length - 1]).toBeGreaterThan(FRAMES - 4);
    expect(threads).toBeGreaterThanOrEqual(8);
  }, 3_600_000);
});
