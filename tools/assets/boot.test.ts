import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { flatness, SoftRenderer } from '../gfx/raster.ts';
import { bootGame } from '../headless/boot.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { classify } from './classify.ts';
import { buildManifest, readCartridge, writeAssets } from './write.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 600;
/** The title scene is on screen from here (see tools/gfx/frames.test.ts). */
const TITLE_FROM = 300;

describe.skipIf(!rom || !existsSync(rom))('boot from the assets', () => {
  it('reaches the title screen with only dist/assets and the built game, no ROM file', async () => {
    const work = resolve('out', 'assets-test-boot');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const ctx = loadContext(rom!);
    const cDir = join(work, 'c');
    const gen = generate(ctx, inventory, cDir);
    expect(gen.problems).toEqual([]);
    const build = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(build, await compileAll(build, runtimeSources()));

    // From here on the run sees a directory with the game and the assets and nothing else: the ROM is not read again.
    const run = join(work, 'run');
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });
    writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), join(run, 'assets'));
    for (const name of ['oot.js', 'oot.wasm']) copyFileSync(join(build.distDir, name), join(run, name));
    const cartridge = readCartridge(join(run, 'assets'));
    expect(cartridge.length).toBe(ctx.rom.length);

    const soft = new SoftRenderer();
    const game = await bootGame(pathToFileURL(join(run, 'oot.js')).href, cartridge, {
      onGfxTask: (task) => soft.drawTask(task.displayList()),
    });
    const flat: string[] = [];
    for (let k = 1; k <= FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      if (k < TITLE_FROM) continue;
      const shown = soft.image(game.framebuffer());
      const f = shown ? flatness(shown) : null;
      if (!f || f.dominant > 0.6 || f.flatRows >= 60) flat.push(`frame ${k}: ${f ? `${(f.dominant * 100).toFixed(0)}% one colour, ${f.flatRows} flat rows` : 'nothing shown'}`);
    }
    expect(flat).toEqual([]);
    expect(existsSync(out)).toBe(true);
  }, 3_600_000);
});
