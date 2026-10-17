// Builds the game from the ROM and plays the scripted new game up to the frame where the save memory holds the new file.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze } from '../analyze/run.ts';
import { loadContext } from '../analyze/context.ts';
import { classify } from '../assets/classify.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { bootGame, type Game } from '../headless/boot.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { MAGIC, MAGIC_AT } from './sram.ts';

const SCRIPT = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');

/** The scripted file creation confirms the name at this frame and the game has written the save memory by the second. */
export const CONFIRM_FRAME = 3470;
export const SAVED_BY_FRAME = 3560;

type Built = { moduleUrl: string; cartridge: Uint8Array };
let built: Promise<Built> | undefined;

/** Analyses, recompiles and links the game from the ROM once per process; objects and analysis are cached across runs. */
export function buildGame(romPath: string): Promise<Built> {
  built ??= build(romPath, resolve('out', 'saves-boot'));
  return built;
}

async function build(romPath: string, outDir: string): Promise<Built> {
  const inventory = await analyze({ romPath, outDir, workDir: join(outDir, 'work'), useGhidra: false });
  const ctx = loadContext(romPath);
  const cDir = join(outDir, 'c');
  const gen = generate(ctx, inventory, cDir);
  if (gen.problems.length > 0) throw new Error(`recompiler problems: ${gen.problems.join('; ')}`);
  const opts = { cDir, objDir: join(outDir, 'obj'), distDir: join(outDir, 'dist'), toolchain: ensureToolchain(), log: () => {} };
  const out = await link(opts, await compileAll(opts, runtimeSources()));
  writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), join(outDir, 'dist', 'assets'));
  return { moduleUrl: pathToFileURL(out).href, cartridge: readCartridge(join(outDir, 'dist', 'assets')) };
}

/** Plays the scripted new game up to `last`, one video frame at a time. */
export async function playTo(game: Game, from: number, last: number): Promise<void> {
  for (let frame = from + 1; frame <= last; frame++) {
    const pad = padAt(SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await game.frame();
    if (r.fatal) throw new Error(`frame ${frame}: ${r.fatal}`);
  }
}

/** The save memory the game writes when the scripted new game creates its first file, with the save context RAM of that moment. */
export async function newFileSave(romPath: string): Promise<{ sram: Uint8Array; ram: Uint8Array; game: Game }> {
  const { moduleUrl, cartridge } = await buildGame(romPath);
  const game = await bootGame(moduleUrl, cartridge, {});
  await playTo(game, 0, CONFIRM_FRAME - 1);
  game.takeSaveDirty();
  await playTo(game, CONFIRM_FRAME - 1, SAVED_BY_FRAME);
  if (!game.takeSaveDirty()) throw new Error('the game wrote no save memory');
  return { sram: game.readSave(), ram: game.ram().slice(), game };
}

/** The frame at which the file select lists the files of the save memory. */
export const FILE_LIST_FRAME = 2880;

/** Boots a fresh game on `sram`, plays to the file list and returns whether the game wrote the save memory and what it holds then. */
export async function bootWithSave(romPath: string, sram: Uint8Array): Promise<{ rewritten: boolean; sram: Uint8Array }> {
  const { moduleUrl, cartridge } = await buildGame(romPath);
  const game = await bootGame(moduleUrl, cartridge, {});
  game.writeSave(sram);
  game.takeSaveDirty();
  await playTo(game, 0, FILE_LIST_FRAME);
  return { rewritten: game.takeSaveDirty(), sram: game.readSave() };
}

/**
 * Title, then A opens the first file's prompt (frame 2700) and A on "Yes" loads it (frame 2900). Observed: with a save memory that
 * has the header signature the language screen does not come first, so the A at frame 2700 reaches the file.
 */
const LOAD_SCRIPT = parseInput('2450 START\n2460 NONE\n2700 A\n2710 NONE\n2900 A\n2910 NONE\n', 'load-script');
export const OPEN_PROMPT_FRAME = 2880;
const LOAD_LIMIT_FRAME = 3600;

/** The save context's address and the part of it the game loads from a record. */
export const SAVE_CONTEXT = 0x801183d0;
const CONTEXT_PHYS = SAVE_CONTEXT & 0x1fffffff;

export interface LoadedFile {
  /** The guest memory at the "Open this file?" prompt. */
  prompt: Uint8Array;
  /** The save context's loaded bytes once the game has loaded the file; undefined if it did not within the frame limit. */
  context?: Uint8Array;
  /** The frame at which the context held the file. */
  loadedAt?: number;
}

/** Boots on `sram`, opens the first file's prompt, answers "Yes" and waits until the save context holds the file. */
export async function loadFirstFile(romPath: string, sram: Uint8Array, contextBytes = 0x1354): Promise<LoadedFile> {
  const { moduleUrl, cartridge } = await buildGame(romPath);
  const game = await bootGame(moduleUrl, cartridge, {});
  game.writeSave(sram);
  const step = async (frame: number) => {
    const pad = padAt(LOAD_SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await game.frame();
    if (r.fatal) throw new Error(`frame ${frame}: ${r.fatal}`);
  };
  for (let frame = 1; frame <= OPEN_PROMPT_FRAME; frame++) await step(frame);
  const prompt = game.ram().slice();
  for (let frame = OPEN_PROMPT_FRAME + 1; frame <= LOAD_LIMIT_FRAME; frame++) {
    await step(frame);
    const ram = game.ram();
    if (frame > 2905 && MAGIC.every((b, i) => ram[CONTEXT_PHYS + MAGIC_AT + i] === b)) {
      return { prompt, context: ram.slice(CONTEXT_PHYS, CONTEXT_PHYS + contextBytes), loadedAt: frame };
    }
  }
  return { prompt };
}
