import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { classify } from '../assets/classify.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { DisplayListInterpreter } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { FILE_SELECT_INIT_LINKED, FILE_SELECT_RECORD, RECORD, fileSelectLoaded, linkPosition, playState } from './state.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 300;

const CONFIRM_FRAME = 3470;
/** The controller script for the whole flow: file creation, the opening, then walking in Link's house. */
const SCRIPT = parseInput(readFileSync(new URL('./newgame.input', import.meta.url), 'utf8'), 'newgame.input');
/** Frames drawn before a captured frame, so that its colour image is complete. */
const DRAW_LEAD = 8;
const TITLE_FRAME = 2449;
const FILE_LIST_FRAME = 2880;
const SAVED_BY_FRAME = 3560;
/** Frames of the opening and of Link's house: the narration, the castle, the forest, the house cutscene, the house under control. */
const NARRATION_FRAME = 4400;
const CASTLE_FRAME = 7000;
const FOREST_FRAME = 13500;
const HOUSE_CUTSCENE_FRAME = 16000;
const CONTROL_FRAME = 19000;
const WALKED_FORWARD_FRAME = 19040;
const WALKED_RIGHT_FRAME = 19140;
/** Scene indices read from the play context: Link's house is the one in which the opening starts and ends. */
const HOUSE_SCENE = 52;
/** The 320x240 RGBA5551 background the JPEG task decodes, in RDRAM; it ends where the task's work buffer (0x8014F680) starts. */
const BACKGROUND_ADDRESS = 0x80129e80;

let built: Promise<{ moduleUrl: string; cartridge: Uint8Array }> | undefined;

/** Analyses, recompiles and links the game once for every test of this file. */
function buildGame(): Promise<{ moduleUrl: string; cartridge: Uint8Array }> {
  built ??= (async () => {
    const work = resolve('out', 'headless-test-boot');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const out = await link(opts, await compileAll(opts, runtimeSources()));

    const ctx = loadContext(rom!);
    writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), join(work, 'dist', 'assets'));
    return { moduleUrl: pathToFileURL(out).href, cartridge: readCartridge(join(work, 'dist', 'assets')) };
  })();
  return built;
}

/** A game whose display lists are drawn into frame images only shortly before each frame in `capture`. */
async function bootCapturing(capture: ReadonlySet<number>) {
  const { moduleUrl, cartridge } = await buildGame();
  const interpreter = new DisplayListInterpreter();
  const soft = new SoftRenderer();
  let frame = 0;
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if ([...capture].some((c) => frame <= c && frame > c - DRAW_LEAD)) soft.drawTask(interpreter.run(task.ram, task.data));
    },
  });
  const shots = new Map<number, Uint8Array>();
  let jpegTasks = 0;
  /** Plays the script up to and including frame `last`. */
  const play = async (last: number) => {
    while (frame < last) {
      frame++;
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      jpegTasks = r.jpegTasks;
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
      if (capture.has(frame)) {
        const img = soft.image(game.framebuffer());
        expect(img, `frame ${frame} shows an image`).not.toBeNull();
        shots.set(frame, img!.slice());
      }
    }
  };
  return { game, play, shots, jpegTasks: () => jpegTasks };
}

function differingPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}

/** Pixels that differ from the most frequent colour: a blank or flat frame has none. */
function nonFlatPixels(img: Uint8Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < img.length; i += 4) {
    const key = (img[i]! << 16) | (img[i + 1]! << 8) | img[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return img.length / 4 - Math.max(...counts.values());
}

function dump(name: string, img: Uint8Array): void {
  const dir = resolve('out', 'input-frames');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), encodePng(WIDTH, HEIGHT, img));
}

describe.skipIf(!rom || !existsSync(rom))('headless boot', () => {
  it('boots 300 video frames with the retrace and a graphics task going on and no trap', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge);
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

  it('reaches the file selection when Start is pressed at the title, and keeps a new file in the save memory', async () => {
    const ctx = loadContext(rom!);
    const file33 = ctx.files.find((f) => f.index === 33)!;
    const first = await bootCapturing(new Set([TITLE_FRAME, FILE_LIST_FRAME]));

    await first.play(TITLE_FRAME);
    const rd = (addr: number) => first.game.rd32(addr);
    // The game's own record of the file select overlay (its file is 33 of the file table) still holds the link address.
    expect(rd(FILE_SELECT_RECORD + RECORD.romStart) >>> 0).toBe(file33.virtualStart);
    expect(rd(FILE_SELECT_RECORD + RECORD.romEnd) >>> 0).toBe(file33.virtualEnd);
    expect(rd(FILE_SELECT_RECORD + RECORD.init) >>> 0).toBe(FILE_SELECT_INIT_LINKED);
    expect(fileSelectLoaded(rd)).toBe(false);

    await first.play(FILE_LIST_FRAME);
    // The loader rewrote the record: the init routine's link address became its address in the loaded overlay.
    const init = rd(FILE_SELECT_RECORD + RECORD.init) >>> 0;
    expect(fileSelectLoaded(rd)).toBe(true);
    const linkStart = rd(FILE_SELECT_RECORD + RECORD.linkStart) >>> 0;
    const loadedAt = (init - (FILE_SELECT_INIT_LINKED - linkStart)) >>> 0;
    expect(loadedAt).toBeGreaterThanOrEqual(0x80000000);
    expect(loadedAt + (rd(FILE_SELECT_RECORD + RECORD.linkEnd) - linkStart)).toBeLessThan(0x80800000);

    const title = first.shots.get(TITLE_FRAME)!;
    const emptyList = first.shots.get(FILE_LIST_FRAME)!;
    dump('title', title);
    dump('file-select', emptyList);
    expect(differingPixels(title, emptyList)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);

    // Writes before the file is confirmed (the game sets up the save memory while it boots) do not count.
    await first.play(CONFIRM_FRAME - 1);
    first.game.takeSaveDirty();
    await first.play(SAVED_BY_FRAME);
    expect(first.game.takeSaveDirty()).toBe(true);
    const saved = first.game.readSave();
    expect(saved.some((b) => b !== 0)).toBe(true);

    // A fresh boot with that save memory lists the file instead of an empty slot.
    const second = await bootCapturing(new Set([FILE_LIST_FRAME]));
    second.game.writeSave(saved);
    await second.play(FILE_LIST_FRAME);
    const restoredList = second.shots.get(FILE_LIST_FRAME)!;
    dump('file-select-restored', restoredList);
    expect(differingPixels(emptyList, restoredList)).toBeGreaterThan(200);
  }, 3_600_000);

  it('plays a new game from file creation to a Link who walks when the stick moves, with no trap', async () => {
    const shots = new Set([NARRATION_FRAME, CASTLE_FRAME, FOREST_FRAME, HOUSE_CUTSCENE_FRAME, CONTROL_FRAME]);
    const run = await bootCapturing(shots);
    const rd = (addr: number) => run.game.rd32(addr);
    const sceneAt = async (frame: number) => {
      await run.play(frame);
      return playState(rd);
    };

    // Starting the game submits the JPEG decode task (type 4 with the microcode at 0x800E4B10) for Link's house background.
    expect((await sceneAt(NARRATION_FRAME))?.scene).toBe(HOUSE_SCENE);
    expect(run.jpegTasks()).toBeGreaterThan(0);
    const castle = (await sceneAt(CASTLE_FRAME))?.scene;
    const forest = (await sceneAt(FOREST_FRAME))?.scene;
    expect(castle).toBeDefined();
    expect(forest).toBeDefined();
    expect(new Set([HOUSE_SCENE, castle, forest]).size).toBe(3);
    expect((await sceneAt(HOUSE_CUTSCENE_FRAME))?.scene).toBe(HOUSE_SCENE);

    // 300 macroblocks of 16x16 pixels make the background; the decoded picture has many colours and every pixel opaque.
    const ram = run.game.ram();
    const background = new Uint16Array(320 * 240);
    for (let i = 0; i < background.length; i++) background[i] = (ram[(BACKGROUND_ADDRESS & 0x7fffff) + 2 * i]! << 8) | ram[(BACKGROUND_ADDRESS & 0x7fffff) + 2 * i + 1]!;
    expect(background.every((p) => (p & 1) === 1)).toBe(true);
    expect(new Set(background).size).toBeGreaterThan(300);

    // Idle before the stick moves, then forward, then right: the position changes with the stick and in no other frame.
    await run.play(CONTROL_FRAME - 10);
    const play = playState(rd);
    expect(play?.scene).toBe(HOUSE_SCENE);
    const before = linkPosition(rd, play!);
    expect(before).toBeDefined();
    await run.play(CONTROL_FRAME);
    const idle = linkPosition(rd, play!)!;
    expect(idle).toEqual(before);
    await run.play(WALKED_FORWARD_FRAME);
    const forward = linkPosition(rd, play!)!;
    expect(Math.hypot(forward.x - idle.x, forward.z - idle.z)).toBeGreaterThan(10);
    expect(forward.y).toBeCloseTo(idle.y, 1);
    await run.play(WALKED_RIGHT_FRAME);
    const right = linkPosition(rd, play!)!;
    expect(Math.hypot(right.x - forward.x, right.z - forward.z)).toBeGreaterThan(10);
    // He slides to a stop after the stick is released.
    await run.play(WALKED_RIGHT_FRAME + 60);
    const stopped = linkPosition(rd, play!)!;
    await run.play(WALKED_RIGHT_FRAME + 120);
    expect(linkPosition(rd, play!)).toEqual(stopped);

    const images = [NARRATION_FRAME, CASTLE_FRAME, FOREST_FRAME, HOUSE_CUTSCENE_FRAME, CONTROL_FRAME].map((f) => {
      const img = run.shots.get(f)!;
      dump(`new-game-${f}`, img);
      expect(nonFlatPixels(img), `frame ${f} is not blank`).toBeGreaterThan(300);
      return img;
    });
    for (let a = 0; a < images.length; a++)
      for (let b = a + 1; b < images.length; b++) expect(differingPixels(images[a]!, images[b]!), `frames ${a} and ${b} differ`).toBeGreaterThan(300);
  }, 3_600_000);
});
