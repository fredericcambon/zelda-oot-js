// The display-list interpreter in the wasm module against the TypeScript one, on the memory of the running game: the
// two are run on the same RDRAM for every graphics task and must give the same batches, bit for bit.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { ENTRANCE_TABLE, playState, requestEntrance, SCENE_RECORD_SIZE, SCENE_TABLE } from '../headless/state.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { RDRAM_SIZE, startModule } from '../runtime/instance.ts';
import { captureMemory, restoreMemory, type SnapshotCore } from '../runtime/snapshot.ts';
import { readResult, type GfxCore } from './c-dl.ts';
import { diffResults } from './compare.ts';
import { DisplayListInterpreter } from './dl.ts';

const rom = process.env.OOT_ROM;
const SCRIPT = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');
/** Link is under control in his house from here (tools/headless/newgame.input); the scripted game is played that far. */
const CONTROL_FRAME = 19040;
/** The entrances the sweep test loads, then a spread over the whole table: scenes with other lighting, fog, textures and backgrounds. */
const ENTRANCES = [0, 5, 100, 205, 465, ...Array.from({ length: 26 }, (_, i) => 60 + i * 61)];
const SCENE_FRAMES = 60;
/** Upper bound of the scene table's length: it ends at the first record that does not name a file range in the cartridge. */
const MAX_SCENE_RECORDS = 512;

interface GameCore extends SnapshotCore, GfxCore {
  _gfx_run(start: number): number;
  _oot_rd32(addr: number): number;
}

describe.skipIf(!rom || !existsSync(rom))('display lists in C against TypeScript', () => {
  it('give identical batches for every graphics task of the scripted new game and of the sweep scenes', async () => {
    const work = resolve('out', 'gfx-compare');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(opts, await compileAll(opts, runtimeSources()));

    const reference = new DisplayListInterpreter();
    let tasks = 0;
    let batches = 0;
    let texturesSeen = 0;
    const failures: string[] = [];
    let where = 'boot';
    const mem = () => mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
    const mod = await startModule<GameCore>(pathToFileURL(out).href, new Uint8Array(readFileSync(rom!)), {
      onGfxTask: (data: number) => {
        const expected = reference.run(mem(), data >>> 0);
        mod._gfx_run(data >>> 0);
        const actual = readResult(mod);
        tasks++;
        batches += expected.batches.length;
        for (const b of expected.batches) texturesSeen += b.state.textures.filter(Boolean).length;
        if (failures.length < 20) {
          const diff = diffResults(expected, actual);
          if (diff.length > 0) failures.push(`${where}, task ${tasks}: ${diff.join(' | ')}`);
        }
      },
    });
    const frame = async (): Promise<string | undefined> => {
      try {
        await mod._oot_frame();
      } catch (err) {
        return typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      }
      return undefined;
    };
    const rd32 = (addr: number) => mod._oot_rd32(addr) >>> 0;
    const write32 = (addr: number, value: number) => {
      const ram = mem();
      new DataView(ram.buffer, ram.byteOffset, ram.byteLength).setUint32(addr & 0x7fffff, value >>> 0);
    };
    const pad = (buttons: number, x: number, y: number) => mod._oot_pad_set(0, buttons, x, y);

    where = 'scripted new game';
    for (let k = 1; k <= CONTROL_FRAME; k++) {
      const p = padAt(SCRIPT, k);
      pad(p.buttons, p.x, p.y);
      const fatal = await frame();
      expect(fatal, `frame ${k}`).toBeUndefined();
      expect(failures, `frame ${k}`).toEqual([]);
      if (k % 2000 === 0) console.log(`frame ${k}: ${tasks} tasks identical`);
    }
    const gameTasks = tasks;
    expect(gameTasks).toBeGreaterThan(600);

    // Each entrance starts from the state at the end of the script and plays on with the pad released, as the sweep does.
    pad(0, 0, 0);
    const state = captureMemory(mod);
    let scenesPlayed = 0;
    // An entrance that names no scene would run the game off its tables.
    let sceneRecords = 0;
    while (sceneRecords < MAX_SCENE_RECORDS) {
      const start = rd32(SCENE_TABLE + sceneRecords * SCENE_RECORD_SIZE), end = rd32(SCENE_TABLE + sceneRecords * SCENE_RECORD_SIZE + 4);
      if (start >= end || end > 0x4000000) break;
      sceneRecords++;
    }
    const sceneOf = (entrance: number) => (rd32(ENTRANCE_TABLE + entrance * 4) << 0) >> 24;
    for (const entrance of ENTRANCES.filter((e) => sceneOf(e) >= 0 && sceneOf(e) < sceneRecords)) {
      restoreMemory(mod, state);
      const play = playState(rd32);
      expect(play, 'a scene is loaded at the end of the script').toBeDefined();
      requestEntrance(rd32, write32, play!, entrance);
      where = `entrance ${entrance}`;
      for (let k = 1; k <= SCENE_FRAMES; k++) {
        // An entrance with no scene can stop the game; what it drew before that still counts.
        if (await frame()) break;
        expect(failures, `${where}, frame ${k}`).toEqual([]);
      }
      scenesPlayed++;
    }
    console.log(`${gameTasks} tasks of the scripted new game and ${tasks - gameTasks} of ${scenesPlayed} scenes: ${batches} batches, ${texturesSeen} textures identical`);
    expect(failures).toEqual([]);
    expect(tasks).toBeGreaterThan(gameTasks);
  }, 3_600_000);
});
