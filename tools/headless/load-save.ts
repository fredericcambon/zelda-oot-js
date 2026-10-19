// Puts a save record into the running game's save context and starts play at the record's entrance, and takes a game that
// started over to the file select. It writes guest memory only, between two frames, so the page and the headless runner share it.
import { ENTRANCE_INDEX, FILE_SELECT_INIT_LINKED, FILE_SELECT_RECORD, playState, requestEntrance, RECORD, setupVariantFor, type PlayState } from './state.ts';
import { entranceFor } from '../saves/record.ts';
import { CHECKED_SIZE, MAGIC, MAGIC_AT } from '../saves/sram.ts';

/** The save context's address: the first CHECKED_SIZE bytes are what the game loads from a record (docs/re/saves.md). */
export const SAVE_CONTEXT = ENTRANCE_INDEX;

/** Word of the main code's bss: 1 while the title's demo scene runs, 2 in the file select, 0 in play (observed). */
const GAME_MODE = 0x8011972c;
/** Offsets in the play context of the flag that is cleared to end the state (0x8009BB98) and of the two transition bytes the play state's update tests (0x8009BA94, 0x8009BC2C: `lb 0x11E15`, `sb 0x1241B`). */
const RUNNING = 0x98;
const TRANSITION_TRIGGER = 0x11e15;
const TRANSITION_PHASE = 0x1241b;
/** Offsets in the save context. */
const SLOT = 0x1354;
const HEALTH = 0x30;
const LEVEL = 0x32;
const MIN_HEALTH = 0x30;
const SCENE = 0x66;
const CUTSCENE = 0x08;
const PENDING_CUTSCENE = 0x1410;
const NO_PENDING_CUTSCENE = 0xffef;

/** Guest memory as big-endian bytes indexed by physical address (RDRAM, 8 MB). */
export interface GuestRam {
  rd32(addr: number): number;
  write32(addr: number, value: number): void;
  rd8(addr: number): number;
  write8(addr: number, value: number): void;
}

export function guestRam(ram: Uint8Array): GuestRam {
  const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  const at = (addr: number) => addr & 0x7fffff;
  return {
    rd32: (addr) => view.getUint32(at(addr)),
    write32: (addr, value) => view.setUint32(at(addr), value >>> 0),
    rd8: (addr) => view.getUint8(at(addr)),
    write8: (addr, value) => view.setUint8(at(addr), value),
  };
}

/** Why the game cannot take a record now, or undefined when it can. */
export function unsafeReason(mem: GuestRam, fromTitle = false): string | undefined {
  const play = playState((a) => mem.rd32(a));
  if (!play) return 'the game is not in a scene yet (starting up, or in the file select)';
  if (!fromTitle && mem.rd32(GAME_MODE) !== 0) return 'the game is at the title screen';
  if (mem.rd32(play.context + RUNNING) === 0) return 'the game is leaving this scene';
  if (mem.rd8(play.context + TRANSITION_TRIGGER) !== 0 || mem.rd8(play.context + TRANSITION_PHASE) !== 0) return 'a scene transition is in progress';
  return undefined;
}

export class UnsafeStateError extends Error {}

export interface Warp {
  scene: number;
  /** The entrance index written; the play state's init adds its setup variant. */
  entrance: number;
}

/** A record is a file of the game when it carries the marker the file select looks for. */
export function isRecord(record: Uint8Array): boolean {
  return record.length >= CHECKED_SIZE && MAGIC.every((b, i) => record[MAGIC_AT + i] === b);
}

/**
 * Copies the record into the save context as the game does when it loads a file (with the context's slot set to `slot`),
 * then ends the running play state into a new one at the record's entrance. Throws UnsafeStateError with the reason when
 * the game is not in a state where that is safe, and leaves the memory untouched.
 */
export function loadRecordIntoPlay(mem: GuestRam, record: Uint8Array, slot: number, fromTitle = false): Warp {
  const reason = unsafeReason(mem, fromTitle);
  if (reason) throw new UnsafeStateError(reason);
  if (!isRecord(record)) throw new Error('that is not a save record');
  const play = playState((a) => mem.rd32(a)) as PlayState;

  for (let i = 0; i < CHECKED_SIZE; i++) mem.write8(SAVE_CONTEXT + i, record[i]!);
  mem.write32(SAVE_CONTEXT + SLOT, slot);
  mem.write8(SAVE_CONTEXT + LEVEL, 0);
  mem.write8(SAVE_CONTEXT + LEVEL + 1, 0);
  const health = (mem.rd8(SAVE_CONTEXT + HEALTH) << 8) | mem.rd8(SAVE_CONTEXT + HEALTH + 1);
  if (health < MIN_HEALTH) {
    mem.write8(SAVE_CONTEXT + HEALTH, MIN_HEALTH >> 8);
    mem.write8(SAVE_CONTEXT + HEALTH + 1, MIN_HEALTH & 0xff);
  }

  const scene = (mem.rd8(SAVE_CONTEXT + SCENE) << 8) | mem.rd8(SAVE_CONTEXT + SCENE + 1);
  const entrance = entranceFor(scene, mem.rd32(SAVE_CONTEXT + 0x04));
  mem.write32(SAVE_CONTEXT + CUTSCENE, 0);
  mem.write32(SAVE_CONTEXT + PENDING_CUTSCENE, ((mem.rd32(SAVE_CONTEXT + PENDING_CUTSCENE) & 0xffff0000) | NO_PENDING_CUTSCENE) >>> 0);
  if (fromTitle) mem.write32(GAME_MODE, 0);
  // requestEntrance takes the table entry the game will load, which is the index plus the variant the init derives.
  requestEntrance((a) => mem.rd32(a), (a, v) => mem.write32(a, v), play, entrance + setupVariantFor((a) => mem.rd32(a)));
  return { scene, entrance };
}

/** Controller bit of Start (OSContPad). */
const START = 0x1000;
/** The title accepts Start from about frame 450 of a boot (observed); a press earlier than that is harmless. */
const START_FROM = 100;
const START_EVERY = 50;
const START_HOLD = 6;

/** The record's init word is zero before the code is loaded and holds the link address until the overlay is loaded (docs/re/input.md). */
const FILE_SELECT_INIT = FILE_SELECT_RECORD + RECORD.init;

/** Whether the game has loaded the file select overlay since it started. */
export function fileSelectReached(mem: GuestRam): boolean {
  const init = mem.rd32(FILE_SELECT_INIT);
  return init !== 0 && init !== FILE_SELECT_INIT_LINKED;
}

/**
 * Presses Start at intervals, one call per frame, until the file select has been reached or `limit` frames passed: after a
 * reset it takes the game through the title to the file select. `buttons` is 0 once it is done.
 */
export class AutoStart {
  private frame = 0;
  active = true;

  constructor(private readonly reached: () => boolean, private readonly limit = 1500) {}

  buttons(): number {
    if (!this.active) return 0;
    if (this.frame >= this.limit || this.reached()) {
      this.active = false;
      return 0;
    }
    const at = this.frame++ - START_FROM;
    return at >= 0 && at % START_EVERY < START_HOLD ? START : 0;
  }
}
