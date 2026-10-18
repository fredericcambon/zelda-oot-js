// The pause menu's pictures, read from the cartridge image the page already loads (docs/re/saves.md, "Where the pause menu's pictures are").
// Nothing here is stored or shipped: the pictures exist only in memory while the page runs.
import { locateFileTable, type FileEntry } from '../../tools/rom/filetable.ts';
import { isYaz0, yaz0Decode } from '../../tools/rom/yaz0.ts';

/** Item pictures: file 7 holds 32x32 RGBA32 pictures, 0x1000 bytes each, one per item id (with the exceptions of `ITEM_ICON_OF_ID`). */
const ITEM_FILE = 7;
export const ITEM_SIZE = 32;
const ITEM_BYTES = ITEM_SIZE * ITEM_SIZE * 4;

/** Quest pictures: file 8 holds 24x24 RGBA32 pictures, 0x900 bytes each. */
const QUEST_FILE = 8;
export const QUEST_SIZE = 24;
const QUEST_BYTES = QUEST_SIZE * QUEST_SIZE * 4;

/** Ids whose picture is not the one at their own number: the pause menu drew the picture 45 for id 33, 46 for 34, and 33 and 34 (dimmed) for 45 and 46. */
const ITEM_ICON_OF_ID: Readonly<Record<number, number>> = { 33: 45, 34: 46, 45: 33, 46: 34 };

/** Highest item id whose picture was seen in the pause menu. */
export const LAST_ITEM_ICON = 80;

export const itemIconIndex = (id: number): number | null => (id < 0 || id > LAST_ITEM_ICON ? null : (ITEM_ICON_OF_ID[id] ?? id));

/** Quest picture of each bit of the quest word (bit 0-5 medallions, 18-20 stones, 21 and 22 the two top-left boxes, 23 the spider token); other bits have none. */
export const questIconIndex = (bit: number): number | null => (bit >= 0 && bit <= 5 ? bit : bit >= 18 && bit <= 23 ? bit - 12 : null);

export interface Pictures {
  /** RGBA bytes of picture `index`, or null when the file does not hold it. */
  item(index: number): Uint8ClampedArray | null;
  quest(index: number): Uint8ClampedArray | null;
}

function slice(file: Uint8Array, bytes: number, index: number): Uint8ClampedArray | null {
  const at = index * bytes;
  return index >= 0 && at + bytes <= file.length ? new Uint8ClampedArray(file.slice(at, at + bytes)) : null;
}

function fileOf(cartridge: Uint8Array, e: FileEntry): Uint8Array {
  if (!e.compressed) return cartridge.subarray(e.romStart, e.romStart + (e.virtualEnd - e.virtualStart));
  if (!isYaz0(cartridge, e.romStart)) throw new Error(`file ${e.index} is marked compressed but is not`);
  return yaz0Decode(cartridge.subarray(e.romStart, e.romEnd));
}

/** Cuts the two picture files out of a cartridge image; throws when the image has no file table. */
export function readPictures(cartridge: Uint8Array): Pictures {
  const table = locateFileTable(cartridge);
  const items = fileOf(cartridge, table.entries[ITEM_FILE]!);
  const quest = fileOf(cartridge, table.entries[QUEST_FILE]!);
  return { item: (i) => slice(items, ITEM_BYTES, i), quest: (i) => slice(quest, QUEST_BYTES, i) };
}
