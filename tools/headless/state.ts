// The game's record of the state overlay that holds the language and file selection screens (docs/re/input.md).

/** Address in the main code file's data of the 0x30-byte record for file 33 (virtual ROM 0xBA0A00-0xBB10E0). */
export const FILE_SELECT_RECORD = 0x800ef384;

/** Word offsets inside the record. */
export const RECORD = { romStart: 0x00, romEnd: 0x04, linkStart: 0x08, linkEnd: 0x0c, init: 0x14 } as const;

/** Link address of the overlay's init routine; the record holds it until the game loads the overlay and relocates it. */
export const FILE_SELECT_INIT_LINKED = 0x808127ac;

/** Whether the game has loaded the file select overlay: its record then holds the init routine's loaded address. */
export function fileSelectLoaded(rd32: (addr: number) => number): boolean {
  return rd32(FILE_SELECT_RECORD + RECORD.init) >>> 0 !== FILE_SELECT_INIT_LINKED;
}

/** Table of 20-byte scene records in the main code file's data (docs/re/assets.md); the scene loader at 0x8009D640 indexes it. */
export const SCENE_TABLE = 0x800f9440;
export const SCENE_RECORD_SIZE = 20;

/**
 * Table of 4-byte entrance records: byte 0 is the scene index and byte 1 the spawn. It ends where the scene table starts, so it
 * has (SCENE_TABLE - ENTRANCE_TABLE) / 4 entries. The play state's init (0x8009AEA0) indexes it with
 * `(entrance index + setup variant) * 4` and hands both bytes to the scene loader (`lb` at 0x8009B278 and 0x8009B27C).
 */
export const ENTRANCE_TABLE = 0x800f7bf0;
export const ENTRANCE_COUNT = (SCENE_TABLE - ENTRANCE_TABLE) / 4;

/** The word the play state's init reads its entrance index from (`lw` at 0x8009B17C; the transition stores it at 0x8009BBD4). */
export const ENTRANCE_INDEX = 0x801183d0;
/**
 * The setup variant the play state's init adds to the entrance index before it indexes the table (`lw v1,4960(s2)` at
 * 0x8009B194 with s2 = ENTRANCE_INDEX, then `sll`/`addu` with the index at 0x8009B268-0x8009B274): a word at ENTRANCE_INDEX + 0x1360.
 */
export const SETUP_VARIANT = ENTRANCE_INDEX + 0x1360;
/**
 * Words of the same record the init derives the variant from (0x8009B064-0x8009B17C): the cutscene index at +8, which is a
 * cutscene layer when it is 0xFFF0 or more; a halfword at +0x1412 that the init moves into it unless it is 0xFFEF; a flag at
 * +4; the time of day, a halfword at +0xC; and a word at +0x135C whose non-zero value also selects the cutscene layer.
 */
const CUTSCENE_INDEX = ENTRANCE_INDEX + 0x08;
const PENDING_CUTSCENE = ENTRANCE_INDEX + 0x1410;
const NO_PENDING_CUTSCENE = 0xffef;
const SETUP_FLAG = ENTRANCE_INDEX + 0x04;
const TIME_OF_DAY = ENTRANCE_INDEX + 0x0c;
const LAYER_OVERRIDE = ENTRANCE_INDEX + 0x135c;

/**
 * The variant the init will compute for the record as it stands: the cutscene layer plus 4 when the game is in a cutscene
 * setup, else by the flag at +4 and whether the time of day is night (the init sets night for a time below 0x4555 or
 * above 0xC000, 0x8009B0B0-0x8009B0CC).
 */
export function setupVariantFor(rd32: (addr: number) => number): number {
  const cutscene = rd32(CUTSCENE_INDEX) >>> 0;
  if (rd32(LAYER_OVERRIDE) !== 0 || cutscene >= 0xfff0) return (cutscene & 0xf) + 4;
  const time = rd32(TIME_OF_DAY) >>> 16;
  const night = time > 0xc000 || time < 0x4555 ? 1 : 0;
  return rd32(SETUP_FLAG) !== 0 ? night : night ? 3 : 2;
}

/** The play state's init routine and the size of its context, as the transition stores them into the state's next-state fields (0x8009BBC0, 0x8009BBC4). */
const PLAY_INIT = 0x8009aea0;
const PLAY_CONTEXT_SIZE = 0x12518;
/** Offsets in a game state of the next state's init routine and context size, and of the flag that is cleared to end the state (0x8009BB98). */
const STATE_NEXT_INIT = 0x0c;
const STATE_NEXT_SIZE = 0x10;
const STATE_RUNNING = 0x98;

/**
 * Ends the running play state and starts a new one at table entry `entry`, as the game's own scene transition does when it
 * completes. Any cutscene is cleared first, so that the init takes the plain setup variant, and the index is written so that
 * index plus variant is the entry (an entry below the variant is reached at the variant). Returns the index written.
 */
export function requestEntrance(rd32: (addr: number) => number, write32: (addr: number, value: number) => void, play: PlayState, entry: number): number {
  write32(CUTSCENE_INDEX, 0);
  write32(PENDING_CUTSCENE, ((rd32(PENDING_CUTSCENE) & 0xffff0000) | NO_PENDING_CUTSCENE) >>> 0);
  const entrance = Math.max(0, entry - setupVariantFor(rd32));
  write32(ENTRANCE_INDEX, entrance);
  write32(play.context + STATE_NEXT_INIT, PLAY_INIT);
  write32(play.context + STATE_NEXT_SIZE, PLAY_CONTEXT_SIZE);
  write32(play.context + STATE_RUNNING, 0);
  return entrance;
}

/**
 * Word in the main code's bss that holds the address of the play context while a scene is loaded: the scene loader's
 * first argument. Checked by `playContext`: the loader stores the scene index at +0xA4 and its record's address at
 * +0x1242C (stores at 0x8009D6AC and 0x8009D6B0).
 */
const PLAY_CONTEXT_POINTER = 0x80112be0;
const CTX_SCENE_INDEX = 0xa4;
const CTX_SCENE_RECORD = 0x1242c;
/** Entries of {count, head} per actor category, 8 bytes each, found by looking for the player record's address in the context. */
const CTX_ACTOR_LISTS = 0x1c30;
const ACTOR_CATEGORY_PLAYER = 2;
/** Offsets inside an actor record: the id halfword and category byte share the first word; the world position is three floats. */
const ACTOR_POSITION = 0x24;

export interface PlayState {
  context: number;
  scene: number;
}

/** The play context and its scene index, or undefined while no scene is loaded (the pointer is unset or does not describe a scene). */
export function playState(rd32: (addr: number) => number): PlayState | undefined {
  const context = rd32(PLAY_CONTEXT_POINTER) >>> 0;
  if (context < 0x80000000 || context >= 0x80800000) return undefined;
  const scene = rd32(context + CTX_SCENE_INDEX) >>> 16;
  return rd32(context + CTX_SCENE_RECORD) >>> 0 === SCENE_TABLE + scene * SCENE_RECORD_SIZE ? { context, scene } : undefined;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Link's world position: the record at the head of the player category's actor list (its id is 0), or undefined when
 * the list is empty. The three floats move with the control stick and with nothing else (docs/re/newgame.md).
 */
export function linkPosition(rd32: (addr: number) => number, play: PlayState): Vec3 | undefined {
  const list = play.context + CTX_ACTOR_LISTS + ACTOR_CATEGORY_PLAYER * 8;
  const head = rd32(list + 4) >>> 0;
  if (rd32(list) === 0 || head === 0) return undefined;
  const idAndCategory = rd32(head) >>> 0;
  if (idAndCategory >>> 16 !== 0 || ((idAndCategory >>> 8) & 0xff) !== ACTOR_CATEGORY_PLAYER) return undefined;
  const word = new DataView(new ArrayBuffer(4));
  const f = (off: number) => { word.setUint32(0, rd32(head + ACTOR_POSITION + off) >>> 0); return word.getFloat32(0); };
  return { x: f(0), y: f(4), z: f(8) };
}
