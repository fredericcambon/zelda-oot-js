// Whole save memory images: a fresh image, a record placed in a slot, and reading a raw image as an import source.
import { BACKUP, PRIMARY, RECORD_SIZE, SIGNATURE, SIGNATURE_AT, SLOTS, SRAM_USED, recordAt, slotState, verify } from './sram.ts';

/** The cartridge save memory the runtime keeps (RT_SRAM_SIZE). */
export const SRAM_IMAGE_SIZE = 0x20000;

/** An image with the header the game writes (sound 0, targeting 0, language 0, signature) and three empty files. */
export function blankImage(): Uint8Array {
  const sram = new Uint8Array(SRAM_IMAGE_SIZE);
  sram.set(SIGNATURE, SIGNATURE_AT);
  return sram;
}

/** Writes a sealed record to both copies of a slot. */
export function putRecord(sram: Uint8Array, slot: number, record: Uint8Array): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error(`slot ${slot} is outside 0..${SLOTS - 1}`);
  sram.set(record.subarray(0, RECORD_SIZE), PRIMARY[slot]);
  sram.set(record.subarray(0, RECORD_SIZE), BACKUP[slot]);
}

/** The record the game would load for a slot, as a copy; undefined when the slot is not a file. */
export function getRecord(sram: Uint8Array, slot: number): Uint8Array | undefined {
  const s = slotState(sram, slot);
  if (!s.used) return undefined;
  return recordAt(sram, s.outcome === 'from-backup' ? BACKUP[slot]! : PRIMARY[slot]!).slice();
}

/** Pads or trims a raw save memory image to the runtime's size after checking it is a PAL image the game accepts as it is. */
export function importRawImage(bytes: Uint8Array): Uint8Array {
  if (bytes.length < SRAM_USED || bytes.length > SRAM_IMAGE_SIZE) {
    throw new Error(`unsupported: ${bytes.length} bytes is not a save memory image (expected ${SRAM_USED}..${SRAM_IMAGE_SIZE})`);
  }
  const v = verify(bytes);
  if (!v.accepted) throw new Error(`unsupported: the image does not match the PAL layout: ${v.problems.join('; ') || 'a check failed'}`);
  const out = new Uint8Array(SRAM_IMAGE_SIZE);
  out.set(bytes);
  return out;
}

