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
import { flatness, SoftRenderer } from './raster.ts';
import { DlTotals } from './totals.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 600;
/** The title scene is on screen from here; the black gap between it and the logo ends before. */
const TITLE_FROM = 300;
/** The logo has faded out by here. */
const FADE_FROM = 255;

describe.skipIf(!rom || !existsSync(rom))('display lists of the booted game', () => {
  it('parses every graphics task of 600 frames with documented commands only', async () => {
    const work = resolve('out', 'headless-test-gfx');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(opts, await compileAll(opts, runtimeSources()));

    const soft = new SoftRenderer();
    const flat: string[] = [];
    const totals = new DlTotals();
    let textured = 0;
    const game = await bootGame(pathToFileURL(out).href, new Uint8Array(readFileSync(rom!)), {
      onGfxTask: (task) => {
        const r = task.displayList();
        for (const b of r.batches) if (b.state.textures[0]) textured++;
        totals.add(r);
        soft.drawTask(r);
      },
    });
    for (let k = 1; k <= FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      // What the video interface scans out must be a finished picture: not nothing, not a cleared buffer, not half a
      // frame (a quarter of the rows of one colour or most of the picture one colour).
      const shown = soft.image(game.framebuffer());
      if (k >= FADE_FROM && k < TITLE_FROM) {
        // The title scene fades in from black: a flat frame in this stretch is black, never a bright cleared buffer.
        const f = shown ? flatness(shown) : null;
        const brightest = f ? Math.max(f.colour >> 16, (f.colour >> 8) & 255, f.colour & 255) : 0;
        if (!f || (f.dominant > 0.6 && brightest > 24)) flat.push(`frame ${k}: ${f ? `${(f.dominant * 100).toFixed(0)}% flat colour 0x${f.colour.toString(16)}` : 'nothing shown'}`);
      }
      if (k >= TITLE_FROM) {
        const f = shown ? flatness(shown) : null;
        if (!f || f.dominant > 0.6 || f.flatRows >= 60) flat.push(`frame ${k}: ${f ? `${(f.dominant * 100).toFixed(0)}% one colour, ${f.flatRows} flat rows` : 'nothing shown'}`);
      }
    }
    expect(flat).toEqual([]);

    expect(totals.unknown, totals.summary()).toEqual([]);
    expect(totals.problems, totals.summary()).toEqual([]);
    expect(totals.tasks).toBeGreaterThan(300);
    // Triangles whose vertices all lie outside one side of the view are dropped, as the microcode drops them.
    expect(totals.triangles).toBeGreaterThan(50_000);
    expect(textured).toBeGreaterThan(10_000);
  }, 3_600_000);
});
