import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootGame } from '../headless/boot.ts';
import { loadBase } from '../recomp/test-base.ts';
import { flatness, SoftRenderer } from './raster.ts';
import { DlTotals } from './totals.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 600;
/** The title scene is on screen from here; the black gap between it and the logo ends before. */
const TITLE_FROM = 300;
/** The logo has faded out by here. */
const FADE_FROM = 255;

describe.skipIf(!rom || !existsSync(rom))('display lists of the booted game', () => {
  it('boots from the built assets and parses every graphics task of 600 frames with documented commands only', async () => {
    const base = loadBase();
    expect(base.problems).toEqual([]);

    const soft = new SoftRenderer();
    const flat: string[] = [];
    const totals = new DlTotals();
    let textured = 0;
    // The cartridge comes from the assets the build wrote, so the boot shows that they and the built game are enough: no ROM file is read.
    const cartridge = base.cartridge();
    expect(cartridge.length).toBe(statSync(rom!).size);
    const game = await bootGame(base.moduleUrl, cartridge, {
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
