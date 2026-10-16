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
const SCENE_RECORD_SIZE = 20;

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
