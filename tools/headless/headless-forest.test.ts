import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DisplayListInterpreter, type Batch, type DisplayListResult } from '../gfx/dl.ts';
import { SoftRenderer } from '../gfx/raster.ts';
import { bootGame } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { playState, requestEntrance } from './state.ts';
import { compareWithMicrocode } from '../gfx/ucode-compare.ts';
import { rom, SCRIPT, DRAW_LEAD, CONTROL_FRAME, buildGame } from './headless-support.ts';

/**
 * Kokiri Forest and the houses around it, entered the way the scene sweep enters them: from Link's house under control (frame
 * ${CONTROL_FRAME}) the game is made to load the entrance, and an A tap every 40 frames gets through the cutscene that follows.
 * The forest is entrance 238 (spawn 0 of scene 85); the others are the entrances the forest scene's exit list names that lead to
 * scenes 52, 45, 38, 39, 40 and 41 (docs/re/display-lists.md section 9).
 */
describe.skipIf(!rom || !existsSync(rom))('Kokiri Forest and its interiors', () => {
  const TAP_A = parseInput('tap A 100 4000 40 3', 'tap');
  const FOREST_ENTRANCE = 238;
  const INTERIOR_ENTRANCES = [626, 193, 201, 156, 1075, 1079];
  /** A frame of the forest with Link on the platform in front of his house, the ladder on screen and the path decal under it. */
  const PLATFORM_FRAME = 2448;

  /** Plays the new game to Link's house, loads `entrance` and runs `frames` frames, calling `onTask` for the tasks after `from`. */
  async function visit(entrance: number, frames: number, from: number, onTask: (task: { ram: Uint8Array; data: number; task: number }, frame: number) => void) {
    const { moduleUrl, cartridge } = await buildGame();
    let frame = 0;
    let record = false;
    const game = await bootGame(moduleUrl, cartridge, { onGfxTask: (t) => { if (record) onTask(t, frame); } });
    while (frame < CONTROL_FRAME) {
      frame++;
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
    }
    game.setPad(0, 0, 0);
    const ram = game.ram();
    const write32 = (addr: number, value: number) => new DataView(ram.buffer, ram.byteOffset, ram.byteLength).setUint32(addr & 0x7fffff, value >>> 0);
    requestEntrance(game.rd32, write32, playState(game.rd32)!, entrance);
    for (let k = 1; k <= frames; k++) {
      frame = CONTROL_FRAME + k;
      record = k >= from;
      const pad = padAt(TAP_A, k);
      game.setPad(pad.buttons, pad.x, pad.y);
      expect((await game.frame()).fatal, `frame ${k}`).toBeUndefined();
    }
    return { game, scene: playState(game.rd32)?.scene };
  }

  it('draws the forest without an unknown command or an inconsistency, and its display lists agree with the microcode', async () => {
    const interpreter = new DisplayListInterpreter();
    const unknown: string[] = [];
    let compared = 0;
    const worst = { colour: 0, texture: 0, uncovered: 0 };
    const { scene } = await visit(FOREST_ENTRANCE, 2410, 1, (task, frame) => {
      const k = frame - CONTROL_FRAME;
      const result = interpreter.run(task.ram, task.data);
      unknown.push(...result.unknown.map((u) => `frame ${k} 0x${u.w0.toString(16)}`), ...result.problems.map((p) => `frame ${k} ${p}`));
      if (k >= 2400) {
        const c = compareWithMicrocode(task.ram, task.data, task.task);
        compared++;
        worst.colour = Math.max(worst.colour, c.colourError);
        worst.texture = Math.max(worst.texture, c.textureError);
        worst.uncovered = Math.max(worst.uncovered, c.coverageDifference);
      }
    });
    expect(scene).toBe(85);
    expect(unknown).toEqual([]);
    expect(compared).toBeGreaterThan(0);
    // Lit colours and fog factors agree with the microcode within its rounding (a few of 255), texture coordinates exactly
    // to one unit of 10.5 fixed point, and the triangles cover the same pixels but for 1 in 100.
    expect(worst.colour).toBeLessThanOrEqual(6);
    expect(worst.texture).toBeLessThanOrEqual(1);
    expect(worst.uncovered).toBeLessThan(0.01);
  }, 3_600_000);

  it('draws the interiors without an unknown command and as the microcode does', async () => {
    for (const entrance of INTERIOR_ENTRANCES) {
      const interpreter = new DisplayListInterpreter();
      const unknown: string[] = [];
      let compared = 0;
      const worst = { colour: 0, texture: 0, uncovered: 0 };
      await visit(entrance, 202, 1, (task, frame) => {
        const k = frame - CONTROL_FRAME;
        const result = interpreter.run(task.ram, task.data);
        unknown.push(...result.unknown.map((u) => `frame ${k} 0x${u.w0.toString(16)}`), ...result.problems);
        if (k >= 200) {
          const c = compareWithMicrocode(task.ram, task.data, task.task);
          compared++;
          worst.colour = Math.max(worst.colour, c.colourError);
          worst.texture = Math.max(worst.texture, c.textureError);
          worst.uncovered = Math.max(worst.uncovered, c.coverageDifference);
        }
      });
      expect(unknown, `entrance ${entrance}`).toEqual([]);
      expect(compared, `entrance ${entrance}`).toBeGreaterThan(0);
      expect(worst.colour, `entrance ${entrance}`).toBeLessThanOrEqual(6);
      expect(worst.texture, `entrance ${entrance}`).toBeLessThanOrEqual(1);
      expect(worst.uncovered, `entrance ${entrance}`).toBeLessThan(0.01);
    }
  }, 3_600_000);

  it('draws the decal surfaces (the path, the leaves, the shadow) over the ground they lie on', async () => {
    const results: DisplayListResult[] = [];
    const interpreter = new DisplayListInterpreter();
    await visit(FOREST_ENTRANCE, PLATFORM_FRAME, PLATFORM_FRAME - DRAW_LEAD + 1, (task) => results.push(interpreter.run(task.ram, task.data)));
    const isPath = (b: Batch) => b.kind === 'triangles' && ((b.state.otherModeL >>> 10) & 3) === 3;
    const paths = results.flatMap((r) => r.batches.filter(isPath));
    expect(paths.length).toBeGreaterThan(0);
    const render = (keep: (b: Batch) => boolean) => {
      const soft = new SoftRenderer();
      for (const r of results) soft.drawTask({ ...r, batches: r.batches.filter(keep) });
      return soft;
    };
    const alone = new SoftRenderer();
    for (const r of results) alone.drawTask({ ...r, batches: r.batches.filter(isPath) });
    const full = render(() => true);
    const bare = render((b) => !isPath(b));
    // Pixels where the path changes the picture: most of what it covers on its own, the rest being hidden by nearer things.
    let changed = 0;
    for (const [address, a] of full.images) {
      const b = bare.image(address)!;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
    }
    // Decals blend with what is under them and some are hidden by nearer things: 57% of the area changes at this frame.
    expect(alone.pixelsWritten).toBeGreaterThan(1000);
    expect(changed).toBeGreaterThan(alone.pixelsWritten * 0.4);
  }, 3_600_000);
});
