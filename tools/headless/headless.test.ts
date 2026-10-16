import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { DisplayListInterpreter } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame } from './boot.ts';
import { FILE_SELECT_INIT_LINKED, FILE_SELECT_RECORD, RECORD, fileSelectLoaded } from './state.ts';

const rom = process.env.OOT_ROM;
const FRAMES = 300;

// OSContPad button bits the game acts on (docs/re/input.md).
const START = 0x1000;
const A = 0x8000;
const CONFIRM_FRAME = 3470;
/** [first frame, buttons, frames held]: Start at the title, A on the language, Start on File 1, a letter, END, confirm. */
const SCRIPT: ReadonlyArray<readonly [number, number, number]> = [
  [2450, START, 10], [2700, A, 10], [2900, START, 10], [3320, A, 10], [3400, START, 10], [CONFIRM_FRAME, A, 10],
];
/** Frames drawn before a captured frame, so that its colour image is complete. */
const DRAW_LEAD = 8;
const TITLE_FRAME = 2449;
const FILE_LIST_FRAME = 2880;
const SAVED_BY_FRAME = 3560;
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
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if ([...capture].some((c) => frame <= c && frame > c - DRAW_LEAD)) soft.drawTask(interpreter.run(task.ram, task.data));
    },
  });
  const shots = new Map<number, Uint8Array>();
  /** Plays the script up to and including frame `last`. */
  const play = async (last: number) => {
    while (frame < last) {
      frame++;
      let buttons = 0;
      for (const [from, b, hold] of SCRIPT) if (frame >= from && frame < from + hold) buttons |= b;
      game.setPad(buttons);
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
      if (capture.has(frame)) {
        const img = soft.image(game.framebuffer());
        expect(img, `frame ${frame} shows an image`).not.toBeNull();
        shots.set(frame, img!);
      }
    }
  };
  return { game, play, shots };
}

function differingPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
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
      let buttons = 0;
      for (const [from, b, hold] of SCRIPT) if (frame >= from && frame < from + hold) buttons |= b;
      game.setPad(buttons);
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
    }
    expect(compared).toBe(COMPARE_FRAMES.length);
    expect(problems).toEqual([]);
  }, 3_600_000);
});
