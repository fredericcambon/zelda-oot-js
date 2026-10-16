import { createHash } from 'node:crypto';
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
import { AudioCapture } from '../audio/capture.ts';
import { RspReference } from '../audio/rsp-ref.ts';
import { Synth } from '../audio/synth.ts';
import { encodeWav } from '../audio/wav.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { DisplayListInterpreter, type Batch, type DisplayListResult } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame } from './boot.ts';
import { padAt, parseInput } from './input.ts';
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

  it('restores a saved state into a fresh game and replays the same frames, pictures, sound, position and memory', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const SAVE_FRAME = CONTROL_FRAME - 10;
    const REPLAY_FRAMES = 180;

    const start = () => startReplayable(moduleUrl, cartridge);

    const first = await start();
    for (let frame = 1; frame <= SAVE_FRAME; frame++) {
      const pad = padAt(SCRIPT, frame);
      first.game.setPad(pad.buttons, pad.x, pad.y);
      expect((await first.game.frame()).fatal, `frame ${frame}`).toBeUndefined();
    }
    expect(playState((a) => first.game.rd32(a))?.scene).toBe(HOUSE_SCENE);
    const state = first.game.snapshot();
    const savedGames = first.game.readSave();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);
    const finalMemory = first.game.snapshot();
    // The walk moves Link and the pictures change, so the comparison below is not between constant frames.
    expect(new Set(expected.map((l) => l.split(' ')[1])).size).toBeGreaterThan(20);
    expect(new Set(expected.map((l) => l.split(' ')[3])).size).toBeGreaterThan(10);

    // A game that has just booted (as a reloaded page has) takes the state.
    const second = await start();
    const blank = second.game.readSave();
    second.game.restore(state);
    // The save memory holds the player's saved games, which a state does not overwrite.
    expect(second.game.readSave()).toEqual(blank);
    second.game.writeSave(savedGames);
    const replayed = await second.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);
    expect(replayed).toEqual(expected);
    const replayedMemory = second.game.snapshot();
    // Every byte of the module's memory but the cartridge image is the same, so nothing the game depends on was left out.
    const common = Math.min(replayedMemory.tail.length, finalMemory.tail.length);
    expect(sha(replayedMemory.head)).toBe(sha(finalMemory.head));
    expect(sha(replayedMemory.tail.subarray(0, common))).toBe(sha(finalMemory.tail.subarray(0, common)));

    // The same game goes back too.
    first.game.restore(state);
    // Described here, not before the comparison of memory above: the buffer it uses is heap memory too.
    const description = first.game.describeThreads();
    expect(await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);

    // The threads of the state, described in terms of the ROM's functions and call sites, are rebuilt in a fresh game.
    const parsed = parseThreads(description);
    expect(encodeThreads(parsed)).toEqual(description);
    const started = parsed.threads.filter((t) => t.started);
    expect(started.length).toBeGreaterThan(5);
    expect(started.every((t) => t.blockingSite !== 0 && t.frames.length > 0 && t.frames.at(-1)!.kind === 'site')).toBe(true);
    expect(parsed.running).toBe(0);

    const third = await start();
    third.game.restore(state);
    third.game.writeSave(savedGames);
    // A description that names a call site this build lacks is refused, and the game is as it was.
    const unknown = structuredClone(parsed);
    const frame = unknown.threads.find((t) => t.started)!.frames[0]!;
    if (frame.kind !== 'site') throw new Error('the outermost frame is a call site');
    frame.site += 2;
    await expect(third.game.rebuildThreads(encodeThreads(unknown))).rejects.toThrow(/no call site/);
    const wrongBuild = description.slice();
    wrongBuild[0] = wrongBuild[0]! ^ 1;
    await expect(third.game.rebuildThreads(wrongBuild)).rejects.toThrow(/not one this build reads/);
    await third.game.rebuildThreads(description);
    expect(third.game.describeThreads()).toEqual(description);
    expect(await third.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
    // The rebuilt fibers have stacks of their own, so the memory below the cartridge image is not byte for byte the old one,
    // but the guest's RDRAM is.
    expect(sha(third.game.ram())).toBe(sha(first.game.ram()));
  }, 3_600_000);

  it('describes no threads while the game boots', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    expect(() => game.describeThreads()).toThrow(/booting/);
    // The refusal leaves the game running.
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
