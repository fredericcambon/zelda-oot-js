import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { compileAll, link, runtimeSources } from '../port/build.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { classify } from '../assets/classify.ts';
import { AudioCapture } from '../audio/capture.ts';
import { RspReference } from '../audio/rsp-ref.ts';
import { Synth } from '../audio/synth.ts';
import { encodeWav } from '../audio/wav.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { DisplayListInterpreter, type Batch, type DisplayListResult } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame, type Game } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { compressState, STATE_VERSION } from '../runtime/snapshot.ts';
import { RDRAM_SIZE } from '../runtime/instance.ts';
import { encodeThreads, parseThreads } from '../runtime/threads.ts';
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
/** SHA-256 of that image once decoded; the decoded picture was inspected and shows the treehouse interior from above. */
const BACKGROUND_SHA256 = 'e0ed6b2ad056f55b0d16efd879d5831a11d7b8a7fdf6e7771981cf8b98fe97d4';
/** Frames of the title screen rendered to a WAV file. */
const TITLE_AUDIO_FRAMES = 250;
/** Frames at which the mixer is checked against the microcode: the intro every 140 frames, then the title and the file select. */
const COMPARE_FRAMES = [...Array.from({ length: 16 }, (_, i) => 260 + i * 140), ...Array.from({ length: 29 }, (_, i) => 2440 + i * 40)];

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

/**
 * The same sources linked at another optimisation level, which gives a different wasm file. The objects and the link are kept
 * under out/ and rebuilt only when a runtime source or the generated C is newer.
 */
async function buildVariant(optimize: string): Promise<{ moduleUrl: string; cartridge: Uint8Array }> {
  const base = await buildGame();
  const work = resolve('out', 'headless-test-boot');
  const variant = resolve('out', `headless-test${optimize}`);
  const opts = { cDir: join(work, 'c'), objDir: join(variant, 'obj'), distDir: join(variant, 'dist'), optimize, toolchain: ensureToolchain(), log: () => {} };
  const objects = await compileAll(opts, runtimeSources());
  const out = join(opts.distDir, 'oot.js');
  const newest = Math.max(...objects.map((o) => statSync(o).mtimeMs));
  if (!existsSync(out) || !existsSync(join(opts.distDir, 'oot.wasm')) || statSync(join(opts.distDir, 'oot.wasm')).mtimeMs < newest) await link(opts, objects);
  return { moduleUrl: pathToFileURL(out).href, cartridge: base.cartridge };
}

/** A game whose display lists are drawn into frame images only shortly before each frame in `capture`. */
async function bootCapturing(capture: ReadonlySet<number>) {
  const { moduleUrl, cartridge } = await buildGame();
  const interpreter = new DisplayListInterpreter();
  const soft = new SoftRenderer();
  let frame = 0;
  const unknown: string[] = [];
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if (![...capture].some((c) => frame <= c && frame > c - DRAW_LEAD)) return;
      const result = interpreter.run(task.ram, task.data);
      unknown.push(...result.unknown.map((u) => `frame ${frame} 0x${u.w0.toString(16)}`), ...result.problems);
      soft.drawTask(result);
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
  return { game, play, shots, unknown, jpegTasks: () => jpegTasks };
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

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The frame at which states are taken, the frames replayed after it, and the size a gzipped state must stay within. */
const SAVE_FRAME = CONTROL_FRAME - 10;
const REPLAY_FRAMES = 180;
const STATE_SIZE_LIMIT = 4 * 1024 * 1024;

/** Plays the scripted new game up to the frame at which states are taken. */
async function reachSaveFrame(game: Game): Promise<void> {
  for (let frame = 1; frame <= SAVE_FRAME; frame++) {
    const pad = padAt(SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
  }
}

/** The payload of each section of a portable state, by tag (runtime/state.c). */
function sections(state: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const out = new Map<string, Uint8Array>();
  let at = 12;
  for (let n = view.getUint32(8, true); n > 0; n--) {
    const length = view.getUint32(at + 4, true);
    out.set(new TextDecoder().decode(state.subarray(at, at + 4)), state.subarray(at + 8, at + 8 + length));
    at += 8 + length;
  }
  return out;
}

/** The state with the payload of one section replaced. */
function withSection(state: Uint8Array, tag: string, payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [state.slice(0, 12)];
  for (const [name, data] of sections(state)) {
    const body = name === tag ? payload : data;
    const head = new Uint8Array(8);
    head.set(new TextEncoder().encode(name));
    new DataView(head.buffer).setUint32(4, body.length, true);
    parts.push(head, body);
  }
  return Buffer.concat(parts);
}

/** A fresh game that draws the frames it plays into pictures and hashes: for each frame, the shown picture, the sound queued and Link's position. */
async function startReplayable(moduleUrl: string, cartridge: Uint8Array) {
  let soft = new SoftRenderer();
  let interpreter = new DisplayListInterpreter();
  let sound = createHash('sha256');
  let drawing = false;
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if (drawing) soft.drawTask(interpreter.run(task.ram, task.data));
    },
    onAiBuffer: (b) => {
      if (drawing) sound.update(b.ram.subarray(b.addr & 0x7fffff, (b.addr & 0x7fffff) + b.length));
    },
  });
  /** Plays the frames after `from`, hashing the shown picture, the sound queued and Link's position of each. */
  const play = async (from: number, to: number): Promise<string[]> => {
    soft = new SoftRenderer();
    interpreter = new DisplayListInterpreter();
    drawing = true;
    const frames: string[] = [];
    for (let frame = from + 1; frame <= to; frame++) {
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      sound = createHash('sha256');
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
      const img = soft.image(game.framebuffer());
      const rd = (addr: number) => game.rd32(addr);
      const state = playState(rd);
      const pos = state ? linkPosition(rd, state) : undefined;
      frames.push(`${frame} ${img ? sha(img) : 'no image'} ${sound.digest('hex')} ${pos ? `${pos.x},${pos.y},${pos.z}` : 'no link'}`);
    }
    drawing = false;
    return frames;
  };
  return { game, play };
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

    // 300 macroblocks of 16x16 pixels make the background: 320x240 halfwords, checked against the digest of the decoded treehouse picture.
    const at = BACKGROUND_ADDRESS & 0x7fffff;
    const digest = createHash('sha256').update(run.game.ram().subarray(at, at + 320 * 240 * 2)).digest('hex');
    expect(digest).toBe(BACKGROUND_SHA256);

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

    // The house is drawn with no unknown command and no interpreter problem, and the room's picture is on screen: most pixels
    // of the frame under control are the decoded picture's, the rest being Link, the objects and the HUD in front of it.
    expect(run.unknown).toEqual([]);
    const picture = run.game.ram().subarray(at, at + 320 * 240 * 2);
    const shot = run.shots.get(CONTROL_FRAME)!;
    let same = 0;
    for (let i = 0; i < 320 * 240; i++) {
      const px = (picture[i * 2]! << 8) | picture[i * 2 + 1]!;
      const [r, g, b] = [(px >>> 11) & 31, (px >>> 6) & 31, (px >>> 1) & 31].map((c) => (c << 3) | (c >> 2));
      if (shot[i * 4] === r && shot[i * 4 + 1] === g && shot[i * 4 + 2] === b) same++;
    }
    expect(same / (320 * 240)).toBeGreaterThan(0.85);
  }, 3_600_000);

  it('saves a portable state and loads it into a fresh game, which replays the same frames, pictures, sound, position and memory', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const start = () => startReplayable(moduleUrl, cartridge);

    const first = await start();
    await reachSaveFrame(first.game);
    expect(playState((a) => first.game.rd32(a))?.scene).toBe(HOUSE_SCENE);
    const state = first.game.saveState();
    const savedGames = first.game.readSave();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);
    // The walk moves Link and the pictures change, so the comparison below is not between constant frames.
    expect(new Set(expected.map((l) => l.split(' ')[1])).size).toBeGreaterThan(20);
    expect(new Set(expected.map((l) => l.split(' ')[3])).size).toBeGreaterThan(10);

    // The state holds RDRAM and a short list of variables, not the module's memory.
    expect(state.length).toBeLessThan(RDRAM_SIZE + 1_000_000);
    expect((await compressState(state)).length).toBeLessThanOrEqual(STATE_SIZE_LIMIT);

    // A game that has just booted (as a reloaded page has) takes the state.
    const second = await start();
    const blank = second.game.readSave();
    await second.game.loadState(state);
    // The save memory holds the player's saved games, which a state does not overwrite.
    expect(second.game.readSave()).toEqual(blank);
    second.game.writeSave(savedGames);
    expect(await second.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
    expect(sha(second.game.ram())).toBe(sha(first.game.ram()));
    // Everything the state holds is the same after the replay, so nothing the game depends on was left out of it.
    expect(sha(second.game.saveState())).toBe(sha(first.game.saveState()));

    // The same game goes back too.
    await first.game.loadState(state);
    const description = first.game.describeThreads();
    expect(await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);

    // The threads of the state, described in terms of the ROM's functions and call sites, are what the state holds.
    const parsed = parseThreads(description);
    expect(encodeThreads(parsed)).toEqual(description);
    const started = parsed.threads.filter((t) => t.started);
    expect(started.length).toBeGreaterThan(5);
    expect(started.every((t) => t.blockingSite !== 0 && t.frames.length > 0 && t.frames.at(-1)!.kind === 'site')).toBe(true);
    expect(parsed.running).toBe(0);
    expect(sections(state).get('THRD')).toEqual(description);
  }, 3_600_000);

  it('refuses a state it cannot read with a message, and the game keeps running', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const start = () => startReplayable(moduleUrl, cartridge);
    const first = await start();
    await reachSaveFrame(first.game);
    const state = first.game.saveState();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);

    const third = await start();
    third.game.writeSave(first.game.readSave());
    const other = state.slice();
    new DataView(other.buffer).setUint32(4, STATE_VERSION + 1, true);
    await expect(third.game.loadState(other)).rejects.toThrow(`this state uses format ${STATE_VERSION + 1}, this build reads ${STATE_VERSION}`);

    // A call site this build does not have.
    const description = parseThreads(sections(state).get('THRD')!);
    const frame = description.threads.find((t) => t.started)!.frames[0]!;
    if (frame.kind !== 'site') throw new Error('the outermost frame is a call site');
    frame.site += 2;
    await expect(third.game.loadState(withSection(state, 'THRD', encodeThreads(description)))).rejects.toThrow(/no call site/);

    const old = state.slice();
    old.set([0x4f, 0x4f, 0x54, 0x53]);
    await expect(third.game.loadState(old)).rejects.toThrow(/old format/);
    await expect(third.game.loadState(state.subarray(0, state.length - 1))).rejects.toThrow(/cut short/);
    await expect(third.game.loadState(new Uint8Array(100))).rejects.toThrow(/not a saved game state/);

    // The refusals left the game as it was: it takes the good state and replays the frames.
    await third.game.loadState(state);
    expect(await third.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
  }, 3_600_000);

  it('loads a state taken by one build into another build and replays the same frames, pictures, sound and memory', async () => {
    const a = await buildGame();
    const b = await buildVariant('-O1');
    const wasm = (url: string) => sha(readFileSync(fileURLToPath(url.replace(/\.js$/, '.wasm'))));
    expect(wasm(b.moduleUrl)).not.toBe(wasm(a.moduleUrl));

    const first = await startReplayable(a.moduleUrl, a.cartridge);
    await reachSaveFrame(first.game);
    const state = first.game.saveState();
    const savedGames = first.game.readSave();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);

    const second = await startReplayable(b.moduleUrl, b.cartridge);
    await second.game.loadState(state);
    second.game.writeSave(savedGames);
    expect(await second.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
    expect(sha(second.game.ram())).toBe(sha(first.game.ram()));
    expect(sha(second.game.saveState())).toBe(sha(first.game.saveState()));
  }, 3_600_000);

  it('refuses to save a state while the game boots', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    expect(() => game.describeThreads()).toThrow(/booting/);
    expect(() => game.saveState()).toThrow(/booting/);
    // The refusals leave the game running.
    expect((await game.frame()).fatal).toBeUndefined();
  }, 3_600_000);

  it('renders the title music to a WAV that is audible and not clipped', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const audio = new AudioCapture();
    const game = await bootGame(moduleUrl, cartridge, audio.hooks);
    let titleStart = 0;
    for (let k = 1; k <= TITLE_FRAME + TITLE_AUDIO_FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      if (k === TITLE_FRAME) titleStart = audio.samples().length;
    }
    expect(audio.error).toBeUndefined();
    expect(audio.hz).toBeGreaterThan(30000);
    expect(audio.hz).toBeLessThan(34000);
    const title = audio.samples().subarray(titleStart);
    const dir = resolve('out', 'audio');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'title.wav'), encodeWav(title, 2, audio.hz));

    // 50 frames of audio per second: the game queues one buffer per frame.
    expect(title.length / 2 / audio.hz).toBeGreaterThan(TITLE_AUDIO_FRAMES / 50 - 0.2);
    let peak = 0, sum = 0, clipped = 0;
    for (const x of title) {
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
      if (x >= 32767 || x <= -32768) clipped++;
    }
    const rms = Math.sqrt(sum / title.length);
    expect(rms, 'not silent').toBeGreaterThan(300);
    expect(peak, 'has a peak').toBeGreaterThan(3000);
    expect(clipped / title.length, 'not clipped').toBeLessThan(0.0005);
    // Sound all the way through, not one burst: every half second holds signal.
    const window = Math.floor(audio.hz / 2) * 2;
    for (let at = 0; at + window <= title.length; at += window) {
      let e = 0;
      for (let i = at; i < at + window; i++) e += title[i]! * title[i]!;
      expect(Math.sqrt(e / window), `half second at ${at / window}`).toBeGreaterThan(50);
    }
  }, 3_600_000);

  it('mixes the same samples as the audio microcode does on the commands of the intro, the title and the file select', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const synth = new Synth();
    let frame = 0;
    let compared = 0;
    const pending = [...COMPARE_FRAMES];
    const problems: string[] = [];
    const game = await bootGame(moduleUrl, cartridge, {
      onAudioTask: (t) => {
        const task = { list: t.data & 0x1fffffff, size: t.size, dataSegment: t.microcodeData & 0x1fffffff };
        if (pending.length === 0 || frame < pending[0]!) {
          synth.run(t.ram, task);
          return;
        }
        pending.shift();
        // The reference starts from the working memory the mixer holds, which is what the console's processor would still
        // hold from the previous task, and runs on a copy of the memory the mixer is about to change.
        const code = t.ram.subarray(t.microcode & 0x1fffffff, (t.microcode & 0x1fffffff) + 0x1000);
        const expected = t.ram.slice();
        const reference = new RspReference(code);
        reference.dmem.set(synth.dmem);
        synth.run(t.ram, task);
        reference.run(expected, { dataPtr: task.dataSegment, dataSize: 0x2df, listPtr: task.list, listSize: task.size });
        compared++;
        let differing = 0;
        for (let i = 0; i < expected.length; i++) if (expected[i] !== t.ram[i]) differing++;
        if (differing > 0) problems.push(`frame ${frame}: ${differing} bytes differ`);
      },
    });
    while (frame < COMPARE_FRAMES[COMPARE_FRAMES.length - 1]! + 5) {
      frame++;
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
    }
    expect(compared).toBe(COMPARE_FRAMES.length);
    expect(problems).toEqual([]);
  }, 3_600_000);

  describe('alpha, depth and blending of the drawn frames', () => {
    /** The graphics tasks of the last frames before `target`, and the colour image the video interface shows then. */
    const capture = async (target: number) => {
      const { moduleUrl, cartridge } = await buildGame();
      const interpreter = new DisplayListInterpreter();
      const results: DisplayListResult[] = [];
      let frame = 0;
      const game = await bootGame(moduleUrl, cartridge, {
        onGfxTask: (task) => {
          if (frame > target - DRAW_LEAD) results.push(interpreter.run(task.ram, task.data));
        },
      });
      while (frame < target) {
        frame++;
        const pad = padAt(SCRIPT, frame);
        game.setPad(pad.buttons, pad.x, pad.y);
        expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
      }
      const render = (keep: (b: Batch) => boolean) => {
        const soft = new SoftRenderer();
        for (const r of results) soft.drawTask({ ...r, batches: r.batches.filter(keep) });
        return soft.image(game.framebuffer())!;
      };
      return { results, render };
    };
    const CVG_TIMES_ALPHA = 1 << 12;
    const luminance = (img: Uint8Array, i: number) => img[i]! + img[i + 1]! + img[i + 2]!;

    it("leaves out the transparent texels of the forest's cutout textures", async () => {
      const { results } = await capture(FOREST_FRAME - 200);
      let tested = 0;
      for (const r of results) for (const b of r.batches) {
        const texture = b.state.textures[0];
        if (b.kind !== 'triangles' || !(b.state.otherModeL & CVG_TIMES_ALPHA) || !texture) continue;
        let clear = 0;
        for (let i = 3; i < texture.rgba.length; i += 4) if (texture.rgba[i]! < 32) clear++;
        if (clear === 0 || clear === texture.width * texture.height) continue;
        const cut = new SoftRenderer();
        cut.drawTask({ ...r, batches: [b] });
        const solid = new SoftRenderer();
        solid.drawTask({ ...r, batches: [{ ...b, state: { ...b.state, otherModeL: b.state.otherModeL & ~CVG_TIMES_ALPHA } }] });
        expect(cut.pixelsWritten).toBeLessThanOrEqual(solid.pixelsWritten);
        if (cut.pixelsWritten < solid.pixelsWritten) tested++;
      }
      expect(tested).toBeGreaterThan(20);
    }, 3_600_000);

    it('draws the three hearts of a new file and a shadow that only darkens the ground', async () => {
      const { render } = await capture(CONTROL_FRAME + 50);
      const frame = render(() => true);
      // The third heart is the beating one: a textured quad at z / w = -1.4, in front of the near plane.
      for (const [from, to] of [[24, 36], [36, 46], [46, 60]] as const) {
        let red = 0;
        for (let y = 14; y < 36; y++) {
          for (let x = from; x < to; x++) {
            const o = (y * WIDTH + x) * 4;
            if (frame[o]! > 180 && frame[o + 1]! < 110 && frame[o + 2]! < 110) red++;
          }
        }
        expect(red, `heart between x = ${from} and ${to}`).toBeGreaterThan(15);
      }

      // The decal draws (depth mode 3) are the shadow: without them no pixel is darker, with them none is lighter.
      const decal = (b: Batch) => b.kind === 'triangles' && ((b.state.otherModeL >>> 10) & 3) === 3;
      const bare = render((b) => !decal(b));
      let darker = 0;
      for (let i = 0; i < frame.length; i += 4) {
        const d = luminance(frame, i) - luminance(bare, i);
        expect(d, `pixel ${i / 4}`).toBeLessThanOrEqual(0);
        if (d < 0) darker++;
      }
      expect(darker).toBeGreaterThan(50);
    }, 3_600_000);
  });
});
