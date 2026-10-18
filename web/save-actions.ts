// What the debug panel does with saves: replace the save memory with a file and start over, put one slot's file into play,
// or start over to reach the file select. Each runs between two frames.
import { guestRam, loadRecordIntoPlay, UnsafeStateError } from '../tools/headless/load-save.ts';
import { getRecord, importRawImage } from '../tools/saves/image.ts';
import { SLOTS } from '../tools/saves/sram.ts';
import type { Game } from './game.ts';
import type { SaveSync } from './saves.ts';

export interface SaveTarget {
  game: Game;
  saves: SaveSync;
  /** Called after the game started over, so that the page can take it from the title to the file select. */
  restarted(): void;
}

/** Replaces the saved memory with the image (the stored one is backed up where the store can), starts the game over and returns what to tell the player. */
export async function loadSaveFile(target: SaveTarget, bytes: Uint8Array): Promise<string> {
  let image: Uint8Array;
  try {
    image = importRawImage(bytes);
  } catch (err) {
    return `Not loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
  await target.saves.replace(image);
  target.game.reset();
  target.restarted();
  return 'Save file loaded; going to the file select';
}

/** Puts the file of slot `slot` (0-2) of the game's save memory into play. */
export function loadSlotIntoPlay(target: SaveTarget, slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error(`slot ${slot} does not exist`);
  const record = getRecord(target.game.saveMemory.read(), slot);
  if (!record) return `Slot ${slot + 1} has no file`;
  try {
    const warp = loadRecordIntoPlay(guestRam(target.game.ram()), record, slot);
    return `Slot ${slot + 1} loaded into play (scene ${warp.scene})`;
  } catch (err) {
    if (err instanceof UnsafeStateError) return `Not now: ${err.message}`;
    throw err;
  }
}

export function backToFileSelect(target: SaveTarget): string {
  target.game.reset();
  target.restarted();
  return 'Going back to the file select';
}
