import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGame } from '../headless/headless-support.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { playState, requestEntrance } from '../headless/state.ts';
import { introState, SAVE_FRAME } from '../headless/intro-state.ts';
import { loadState, type StateCore } from '../runtime/snapshot.ts';
import { startModule, type OotCore } from '../runtime/instance.ts';
import { runDisplayList } from './c-dl.ts';
import { isCamera, MatrixFlag, matchFrames, planMotion, readMatrices, type MotionMatrix } from './motion.ts';
import { SoftRenderer } from './raster.ts';
import { finalColorImage, SmoothFrames, type SmoothCore } from './smooth.ts';

const rom = process.env.OOT_ROM;

/** Link's house under control in the scripted new game (docs/re/input.md); the forest is loaded from here. */
const CONTROL_FRAME = 19000;
const FOREST_ENTRANCE = 238;
const SCRIPT = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');
/** The cutscene that follows the entrance is skipped with A taps; then Link walks forward, right, back and left. */
const CUTSCENE_TAPS = parseInput('tap A 100 4000 40 3', 'tap');
const WALKING_FROM = 2450;
const WALKING_UNTIL = 2570;
const WALK = parseInput('2450 NONE 0 70\n2500 NONE 70 0\n2550 NONE 0 -70\n2600 NONE -70 0\n2650 NONE 0 70\n2700 NONE', 'walk');

interface GameCore extends OotCore, SmoothCore {
  _oot_rd32(addr: number): number;
}

const differs = (a: Uint8Array, b: Uint8Array): boolean => Buffer.compare(a, b) !== 0;

/** Whether any camera matrix of `cur` is not the one of `prev`. */
function cameraMoved(prev: MotionMatrix[], cur: MotionMatrix[]): boolean {
  const found = matchFrames(prev, cur);
  return cur.some((m, i) => isCamera(m) && found[i] !== null && m.m.some((v, k) => Math.abs(v - found[i]!.m[k]!) > 1e-3));
}

describe.skipIf(!rom || !existsSync(rom))('pictures between game frames in Kokiri Forest', () => {
  it('matches the matrices of consecutive frames, differs from both neighbours while the camera moves, and is the current frame on a cut', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    let frame = 0;
    let recording = false;
    const smooth: { frames?: SmoothFrames } = {};
    const live = new SoftRenderer(), kept = new SoftRenderer();
    let threeD = 0, matched = 0, moving = 0, rewritten = 0, comparisons = 0;
    let previous: { matrices: MotionMatrix[]; image: Uint8Array } | null = null;
    const mod = await startModule<GameCore>(moduleUrl, cartridge, {
      onGfxTask: (data: number) => {
        if (!recording) return;
        const frames = smooth.frames!;
        frames.push(data);
        const matrices = readMatrices(mod);

        // Smoothing off draws the live list; the kept frame with nothing replaced must give the same pictures.
        const plain = runDisplayList(mod, data);
        live.drawTask(plain);
        const address = finalColorImage(plain)!;
        const reference = live.image(address)!.slice();
        const full = frames.at(1);
        kept.drawTask(full);
        const current = kept.image(address)!.slice();
        expect(differs(current, reference), `frame ${frame}: the kept frame at t = 1 is the live frame`).toBe(false);

        if (previous && frames.plan) {
          const stats = frames.plan.stats;
          threeD += stats.threeD;
          matched += stats.matched;
          rewritten += frames.rewritten;
          comparisons++;
          const half = frames.at(0.5);
          kept.drawTask(half);
          const middle = kept.image(address)!.slice();
          if (cameraMoved(previous.matrices, matrices) && !stats.cut) {
            moving++;
            expect(differs(middle, current), `frame ${frame}: halfway differs from the current frame`).toBe(true);
            expect(differs(middle, previous.image), `frame ${frame}: halfway differs from the previous frame`).toBe(true);
          }

          // A camera cut: the previous frame's camera is a long way off.
          const shifted = previous.matrices.map((m) => (isCamera(m) && !(m.flags & MatrixFlag.LOAD) ? { ...m, m: Float64Array.from(m.m, (v, k) => (k === 12 ? v + 1000 : v)) } : m));
          const cut = planMotion(shifted, matrices);
          expect(cut.stats.cut, `frame ${frame}: the shifted camera is a cut`).toBe(true);
          kept.drawTask(frames.at(0.5, cut));
          expect(differs(kept.image(address)!, current), `frame ${frame}: on a cut halfway is the current frame`).toBe(false);
          // The picture drawn last is the frame itself again, for the comparison with the next frame.
          kept.drawTask(frames.at(1));
        }
        previous = { matrices, image: current };
      },
    });
    smooth.frames = new SmoothFrames(mod);
    const rd32 = (a: number) => mod._oot_rd32(a) >>> 0;
    await loadState(mod as unknown as StateCore, (await introState()).state);
    for (let k = SAVE_FRAME + 1; k <= CONTROL_FRAME; k++) {
      frame = k;
      const pad = padAt(SCRIPT, k);
      mod._oot_pad_set(0, pad.buttons, pad.x, pad.y);
      await mod._oot_frame();
    }
    mod._oot_pad_set(0, 0, 0, 0);
    const ram = new DataView(mod.HEAPU8.buffer, mod._oot_rdram(), 0x800000);
    requestEntrance(rd32, (addr, value) => ram.setUint32(addr & 0x7fffff, value >>> 0), playState(rd32)!, FOREST_ENTRANCE);
    for (let k = 1; k <= WALKING_UNTIL; k++) {
      frame = k;
      recording = k >= WALKING_FROM;
      const pad = k >= WALKING_FROM ? padAt(WALK, k) : padAt(CUTSCENE_TAPS, k);
      mod._oot_pad_set(0, pad.buttons, pad.x, pad.y);
      await mod._oot_frame();
    }
    expect(playState(rd32)?.scene).toBe(85);
    expect(comparisons).toBeGreaterThan(50);
    expect(moving, 'game frames in which the camera moves').toBeGreaterThan(10);
    const share = matched / threeD;
    console.log(`Kokiri Forest, ${comparisons} game frames: ${matched} of ${threeD} 3D matrices matched (${(share * 100).toFixed(2)}%); camera moved in ${moving}; vertices written by the game ${((rewritten / comparisons) * 100).toFixed(2)}%`);
    expect(share).toBeGreaterThanOrEqual(0.9);
  }, 3_600_000);
});
