// Helpers of the headless suites: the shared game, the scripted new game, and the state and picture checks.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { link } from '../port/build.ts';
import { loadBase, variantDistDir } from '../recomp/test-base.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame, type Game } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { linkPosition, playState } from './state.ts';

export const rom = process.env.OOT_ROM;
export const FRAMES = 300;

export const CONFIRM_FRAME = 3470;
/** The controller script for the whole flow: file creation, the opening, then walking in Link's house. */
export const SCRIPT = parseInput(readFileSync(new URL('./newgame.input', import.meta.url), 'utf8'), 'newgame.input');
/** Frames drawn before a captured frame, so that its colour image is complete. */
export const DRAW_LEAD = 8;
export const TITLE_FRAME = 2449;
export const FILE_LIST_FRAME = 2880;
export const SAVED_BY_FRAME = 3560;
/** Frames of the opening and of Link's house: the narration, the castle, the forest, the house cutscene, the house under control. */
export const NARRATION_FRAME = 4400;
export const CASTLE_FRAME = 7000;
export const FOREST_FRAME = 13500;
export const HOUSE_CUTSCENE_FRAME = 16000;
export const CONTROL_FRAME = 19000;
export const WALKED_FORWARD_FRAME = 19040;
export const WALKED_RIGHT_FRAME = 19140;
/** Scene indices read from the play context: Link's house is the one in which the opening starts and ends. */
export const HOUSE_SCENE = 52;
/** The 320x240 RGBA5551 background the JPEG task decodes, in RDRAM; it ends where the task's work buffer (0x8014F680) starts. */
export const BACKGROUND_ADDRESS = 0x80129e80;
/** SHA-256 of that image once decoded; the decoded picture was inspected and shows the treehouse interior from above. */
export const BACKGROUND_SHA256 = 'e0ed6b2ad056f55b0d16efd879d5831a11d7b8a7fdf6e7771981cf8b98fe97d4';
/** Frames of the title screen rendered to a WAV file. */
export const TITLE_AUDIO_FRAMES = 250;
/** Frames at which the mixer is checked against the microcode: the intro every 140 frames, then the title and the file select. */
export const COMPARE_FRAMES = [...Array.from({ length: 16 }, (_, i) => 260 + i * 140), ...Array.from({ length: 29 }, (_, i) => 2440 + i * 40)];

let built: Promise<{ moduleUrl: string; cartridge: Uint8Array }> | undefined;

/** The shared -O2 game and its cartridge. */
export function buildGame(): Promise<{ moduleUrl: string; cartridge: Uint8Array }> {
  built ??= (async () => {
    const base = loadBase();
    expect(base.problems).toEqual([]);
    return { moduleUrl: base.moduleUrl, cartridge: base.cartridge() };
  })();
  return built;
}

/**
 * The shared game's objects linked at another optimisation level, which gives a different wasm file; the link comes from the
 * shared cache once it has been made.
 */
export async function buildVariant(optimize: string): Promise<{ moduleUrl: string; cartridge: Uint8Array }> {
  const base = await buildGame();
  const shared = loadBase();
  const opts = { ...shared.opts, distDir: variantDistDir(optimize), optimize };
  const out = await link(opts, await shared.objects());
  return { moduleUrl: pathToFileURL(out).href, cartridge: base.cartridge };
}

/** A game whose display lists are drawn into frame images only shortly before each frame in `capture`. */
export async function bootCapturing(capture: ReadonlySet<number>) {
  const { moduleUrl, cartridge } = await buildGame();
  const soft = new SoftRenderer();
  let frame = 0;
  const unknown: string[] = [];
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if (![...capture].some((c) => frame <= c && frame > c - DRAW_LEAD)) return;
      const result = task.displayList();
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

export function differingPixels(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}

/** Pixels that differ from the most frequent colour: a blank or flat frame has none. */
export function nonFlatPixels(img: Uint8Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < img.length; i += 4) {
    const key = (img[i]! << 16) | (img[i + 1]! << 8) | img[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return img.length / 4 - Math.max(...counts.values());
}

export function dump(name: string, img: Uint8Array): void {
  const dir = resolve('out', 'input-frames');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), encodePng(WIDTH, HEIGHT, img));
}

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The frame at which states are taken, the frames replayed after it, and the size a gzipped state must stay within. */
export const SAVE_FRAME = CONTROL_FRAME - 10;
export const REPLAY_FRAMES = 180;
export const STATE_SIZE_LIMIT = 4 * 1024 * 1024;

/** Plays the scripted new game up to the frame at which states are taken. */
export async function reachSaveFrame(game: Game): Promise<void> {
  for (let frame = 1; frame <= SAVE_FRAME; frame++) {
    const pad = padAt(SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
  }
}

/** The payload of each section of a portable state, by tag (runtime/state.c). */
export function sections(state: Uint8Array): Map<string, Uint8Array> {
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
export function withSection(state: Uint8Array, tag: string, payload: Uint8Array): Uint8Array {
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
export async function startReplayable(moduleUrl: string, cartridge: Uint8Array) {
  let soft = new SoftRenderer();
  let sound = createHash('sha256');
  let drawing = false;
  const game = await bootGame(moduleUrl, cartridge, {
    onGfxTask: (task) => {
      if (drawing) soft.drawTask(task.displayList());
    },
    onAiBuffer: (b) => {
      if (drawing) sound.update(b.ram.subarray(b.addr & 0x7fffff, (b.addr & 0x7fffff) + b.length));
    },
  });
  /** Plays the frames after `from`, hashing the shown picture, the sound queued and Link's position of each. */
  const play = async (from: number, to: number): Promise<string[]> => {
    soft = new SoftRenderer();
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
