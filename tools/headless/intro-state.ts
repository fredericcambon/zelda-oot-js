// The scripted new game played from boot once, saved as states at a few frames and kept in the shared cache for the suites that start from there.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheDir } from '../port/cache.ts';
import { loadBase } from '../recomp/test-base.ts';
import { compressState, decompressState } from '../runtime/snapshot.ts';
import { bootGame, type Game } from './boot.ts';
import { padAt, parseInput } from './input.ts';

/** Link's house under control (docs/re/input.md); the state is taken ten frames earlier, while the house is already running. */
export const SAVE_FRAME = 18990;
/** Frames at which states are taken on the one pass through the intro: a forest cutscene before the house, and the house under control. */
export const CHECKPOINTS = [13290, SAVE_FRAME];

const SCRIPT_URL = new URL('./newgame.input', import.meta.url);
const STALE_LOCK_MS = 15 * 60_000;

export interface IntroState {
  state: Uint8Array;
  /** The save memory of the game at that frame, which a state does not hold. */
  sram: Uint8Array;
}

/** Plays the scripted new game on `game` from the frame after `from` through `to`. */
export async function playScript(game: Game, from: number, to: number): Promise<void> {
  const script = parseInput(readFileSync(SCRIPT_URL, 'utf8'), 'newgame.input');
  for (let frame = from + 1; frame <= to; frame++) {
    const pad = padAt(script, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await game.frame();
    if (r.fatal) throw new Error(`frame ${frame}: ${r.fatal}`);
  }
}

let known: Promise<Map<number, IntroState>> | undefined;

/** The state of a fresh game at `frame`, one of CHECKPOINTS, played from boot once for every checkpoint. */
export async function introState(frame = SAVE_FRAME): Promise<IntroState> {
  known ??= makeStates();
  const found = (await known).get(frame);
  if (!found) throw new Error(`no intro state at frame ${frame}`);
  return found;
}

/** The states of CHECKPOINTS, keyed by the shared build's wasm, the controller script and the frames, so that a new build or script never reads an old state. */
async function makeStates(): Promise<Map<number, IntroState>> {
  const base = loadBase();
  const wasm = readFileSync(new URL(base.moduleUrl.replace(/\.js$/, '.wasm')));
  const key = createHash('sha256').update(wasm).update(readFileSync(SCRIPT_URL)).update(CHECKPOINTS.join(',')).digest('hex').slice(0, 24);
  const dir = join(defaultCacheDir(), 'intro-state');
  const file = join(dir, `${key}.bin`);
  const lock = `${file}.lock`;
  mkdirSync(dir, { recursive: true });

  for (;;) {
    const cached = await read(file);
    if (cached) return cached;
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch {
      // Another test file is playing the intro: wait for its states, and take over when its lock is stale.
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      const game = await bootGame(base.moduleUrl, base.cartridge(), {});
      const made = new Map<number, IntroState>();
      let at = 0;
      for (const frame of CHECKPOINTS) {
        await playScript(game, at, frame);
        at = frame;
        made.set(frame, { state: game.saveState(), sram: game.readSave() });
      }
      const parts: Uint8Array[] = [];
      for (const [frame, { state, sram }] of made) {
        const packed = await compressState(state);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(frame, 0);
        head.writeUInt32LE(sram.length, 4);
        head.writeUInt32LE(packed.length, 8);
        parts.push(head, sram, packed);
      }
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, Buffer.concat(parts));
      for (const old of readdirSync(dir)) if (old.endsWith('.bin') && old !== `${key}.bin`) rmSync(join(dir, old), { force: true });
      renameSync(tmp, file);
      return made;
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

async function read(file: string): Promise<Map<number, IntroState> | undefined> {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  const states = new Map<number, IntroState>();
  for (let at = 0; at < bytes.length; ) {
    const frame = bytes.readUInt32LE(at);
    const sramLength = bytes.readUInt32LE(at + 4);
    const packedLength = bytes.readUInt32LE(at + 8);
    at += 12;
    const sram = new Uint8Array(bytes.subarray(at, at + sramLength));
    at += sramLength;
    states.set(frame, { sram, state: await decompressState(bytes.subarray(at, at + packedLength)) });
    at += packedLength;
  }
  return states;
}

/** Loads an intro state into a game that has just booted; the save memory is restored too. */
export async function loadIntro(game: Game, intro: IntroState): Promise<void> {
  await game.loadState(intro.state);
  game.writeSave(intro.sram);
}
