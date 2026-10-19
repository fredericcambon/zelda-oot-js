// The area-name pictures the game shows when a scene is entered, read from the cartridge image the page already loads
// (docs/re/title-cards.md). Nothing here is stored or shipped: the pictures exist only in memory while the page runs.
import { locateFileTable, type FileEntry } from '../../tools/rom/filetable.ts';
import { fileOf } from './icons.ts';

/** File table index of the main code file, whose data holds the scene table. */
const CODE_FILE = 28;
/** Offset of the scene table in that file (the table is at 0x800F9440 in RAM) and its record size. */
const SCENE_TABLE_AT = 949600;
const SCENE_RECORD_SIZE = 20;
/** Records of the table: the next 20 bytes are display-list data (docs/re/title-cards.md). */
export const SCENE_RECORDS = 101;

/** A card file holds one IA8 picture per language, of this size, one after the other. */
export const CARD_WIDTH = 144;
export const CARD_HEIGHT = 24;
export const CARD_LANGUAGES = 3;
const CARD_BYTES = CARD_WIDTH * CARD_HEIGHT;
const CARD_FILE_BYTES = CARD_BYTES * CARD_LANGUAGES;

/** Bit of an entrance record's low halfword that lets the scene's card be drawn when the scene is entered by that entrance. */
export const ENTRANCE_SHOWS_CARD = 0x4000;

/** Scenes whose card the game draws only while a save flag is set (docs/re/title-cards.md, "Conditions"). */
export const CONDITIONAL_CARD_SCENES: readonly number[] = [1, 50];

export interface TitleCards {
  /** The file table index of scene `scene`'s card file, or null when the scene's record names none. */
  file(scene: number): number | null;
  /** RGBA bytes of the card in `language` (the game's language byte, 0 to 2), or null when the scene has none. */
  card(scene: number, language: number): Uint8ClampedArray | null;
}

/** IA8: the high nibble is the intensity, the low nibble the alpha. */
export function decodeIA8(ia: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ia.length * 4);
  ia.forEach((b, i) => {
    out.fill((b >> 4) * 17, i * 4, i * 4 + 3);
    out[i * 4 + 3] = (b & 15) * 17;
  });
  return out;
}

/** Cuts the cards out of a cartridge image; throws when the image has no file table. */
export function readTitleCards(cartridge: Uint8Array): TitleCards {
  const table = locateFileTable(cartridge);
  const code = fileOf(cartridge, table.entries[CODE_FILE]!);
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const byStart = new Map<number, FileEntry>(table.entries.map((e) => [e.virtualStart, e]));
  const entries: (FileEntry | null)[] = [];
  const files = new Map<number, Uint8Array>();
  for (let scene = 0; scene < SCENE_RECORDS; scene++) {
    const at = SCENE_TABLE_AT + scene * SCENE_RECORD_SIZE;
    const entry = byStart.get(dv.getUint32(at + 8));
    const isCard = entry && entry.virtualEnd === dv.getUint32(at + 12) && entry.virtualEnd - entry.virtualStart === CARD_FILE_BYTES;
    entries.push(isCard ? entry : null);
    // Copied, so that the cartridge image can be freed.
    if (isCard && !files.has(entry.index)) files.set(entry.index, fileOf(cartridge, entry).slice());
  }
  return {
    file: (scene) => entries[scene]?.index ?? null,
    card(scene, language) {
      const entry = entries[scene];
      if (!entry) return null;
      const at = Math.min(Math.max(language, 0), CARD_LANGUAGES - 1) * CARD_BYTES;
      return decodeIA8(files.get(entry.index)!.subarray(at, at + CARD_BYTES));
    },
  };
}

/** The scenes whose card the game can draw: the record names a card and an entrance of the scene has `ENTRANCE_SHOWS_CARD`. */
export function scenesWithCard(cards: Pick<TitleCards, 'file'>, entrances: readonly { scene: number; flags: number }[]): Set<number> {
  const shown = new Set<number>();
  for (const e of entrances) if (e.flags & ENTRANCE_SHOWS_CARD && cards.file(e.scene) !== null) shown.add(e.scene);
  return shown;
}
