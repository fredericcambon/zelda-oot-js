// Layout and checks of the save memory of the PAL 1.0 game; docs/re/saves.md has the evidence for every number.

/** Bytes of the cartridge save memory the game reads and writes (0x80091b14 callers pass 0x8000). */
export const SRAM_USED = 0x8000;
/** Bytes of the header at the start of the save memory. */
export const HEADER_SIZE = 0x10;
/** Bytes 3..11 of the header; the game rewrites the header when they differ (0x8009186c). */
export const SIGNATURE = Uint8Array.from([0x98, 0x09, 0x10, 0x21, 0x5a, 0x45, 0x4c, 0x44, 0x41]);
export const SIGNATURE_AT = 3;
/** Offsets of the primary and the backup copy of each of the three files (halfword table at 0x800F9E60). */
export const PRIMARY = [0x20, 0x1470, 0x28c0] as const;
export const BACKUP = [0x3d10, 0x5160, 0x65b0] as const;
export const SLOTS = 3;
/** Bytes the game writes per copy when it saves (0x80090c74), and bytes it reads, checks and loads (0x80090d98). */
export const RECORD_SIZE = 0x1450;
export const CHECKED_SIZE = 0x1354;
export const CHECKSUM_AT = 0x1352;
/** The six bytes at record +0x1C that mark a file as present (0x800912dc-0x800912f0 write them, 0x8080c6a0-0x8080c6f8 test them). */
export const MAGIC = Uint8Array.from([0x5a, 0x45, 0x4c, 0x44, 0x41, 0x5a]);
export const MAGIC_AT = 0x1c;

/** The record bytes the game's checksum covers, summed as big-endian halfwords with the checksum halfword read as zero. */
export function checksum(record: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < CHECKED_SIZE; i += 2) {
    if (i === CHECKSUM_AT) continue;
    sum = (sum + ((record[i]! << 8) | record[i + 1]!)) & 0xffff;
  }
  return sum;
}

/** The checksum halfword stored in the record. */
export function storedChecksum(record: Uint8Array): number {
  return (record[CHECKSUM_AT]! << 8) | record[CHECKSUM_AT + 1]!;
}

/** Writes the game's checksum into the record. */
export function sealRecord(record: Uint8Array): void {
  const sum = checksum(record);
  record[CHECKSUM_AT] = sum >>> 8;
  record[CHECKSUM_AT + 1] = sum & 0xff;
}

/** Whether the game's file select lists the file: it counts one matching byte of the magic (0x8080c6a0-0x8080c6f8). */
export function isUsed(record: Uint8Array): boolean {
  return MAGIC.some((b, i) => record[MAGIC_AT + i] === b);
}

export interface Header {
  /** Bytes 0..2: the sound setting, the targeting setting and the language (record fields +0x140A, +0x140C, +0x1409 once loaded). */
  sound: number;
  targeting: number;
  language: number;
  signatureOk: boolean;
}

export function parseHeader(sram: Uint8Array): Header {
  return {
    sound: sram[0]!,
    targeting: sram[1]!,
    language: sram[2]!,
    signatureOk: SIGNATURE.every((b, i) => sram[SIGNATURE_AT + i] === b),
  };
}

export type CopyState = 'ok' | 'bad-checksum';

export interface SlotState {
  slot: number;
  /** The file select lists the file (magic present in the copy the game loads). */
  used: boolean;
  primary: CopyState;
  backup: CopyState;
  /** Whether the two copies hold the same bytes over the checked area. */
  copiesEqual: boolean;
  /**
   * What the game does at boot (0x80090d0c): `kept` when the primary passes, `from-backup` when only the backup passes (the primary
   * is rewritten), `reset` when neither passes (the slot becomes an empty file).
   */
  outcome: 'kept' | 'from-backup' | 'reset';
}

export function recordAt(sram: Uint8Array, offset: number): Uint8Array {
  return sram.subarray(offset, offset + RECORD_SIZE);
}

function copyState(record: Uint8Array): CopyState {
  return storedChecksum(record) === checksum(record) ? 'ok' : 'bad-checksum';
}

export function slotState(sram: Uint8Array, slot: number): SlotState {
  const primary = recordAt(sram, PRIMARY[slot]!);
  const backup = recordAt(sram, BACKUP[slot]!);
  const p = copyState(primary);
  const b = copyState(backup);
  const outcome = p === 'ok' ? 'kept' : b === 'ok' ? 'from-backup' : 'reset';
  const loaded = outcome === 'from-backup' ? backup : primary;
  return {
    slot,
    used: outcome === 'reset' ? false : isUsed(loaded),
    primary: p,
    backup: b,
    copiesEqual: primary.subarray(0, CHECKED_SIZE).every((v, i) => v === backup[i]),
    outcome,
  };
}

export interface Verification {
  /** True when the game would change nothing at boot: the header signature and every slot's primary copy pass. */
  accepted: boolean;
  header: Header;
  slots: SlotState[];
  problems: string[];
}

export function verify(sram: Uint8Array): Verification {
  if (sram.length < SRAM_USED) throw new Error(`save memory of ${sram.length} bytes is shorter than the ${SRAM_USED} the game uses`);
  const header = parseHeader(sram);
  const slots = Array.from({ length: SLOTS }, (_, i) => slotState(sram, i));
  const problems: string[] = [];
  if (!header.signatureOk) problems.push('header signature differs: the game rewrites the header and resets the sound, targeting and language bytes');
  if (header.language > 2) problems.push(`language ${header.language} is out of range: the game resets it to 0`);
  for (const s of slots) {
    if (s.outcome === 'from-backup') problems.push(`slot ${s.slot}: primary copy fails the checksum, the game restores it from the backup`);
    if (s.outcome === 'reset') problems.push(`slot ${s.slot}: neither copy passes the checksum, the game resets the slot to an empty file`);
    if (s.outcome === 'kept' && s.used && !s.copiesEqual) problems.push(`slot ${s.slot}: the backup differs from the primary (the game never reads it while the primary passes)`);
  }
  const accepted = header.signatureOk && header.language <= 2 && slots.every((s) => s.outcome === 'kept');
  return { accepted, header, slots, problems };
}

/** A field of the record read at a fixed offset. */
export interface FieldSpec {
  name: string;
  offset: number;
  size: number;
  /** `u` for an unsigned big-endian integer, `bytes` for raw bytes. */
  type: 'u' | 'bytes';
}

/** Fields of the record with an established meaning or position; docs/re/saves.md gives the evidence of each. */
export const FIELDS: readonly FieldSpec[] = [
  { name: 'entranceIndex', offset: 0x00, size: 4, type: 'u' },
  { name: 'flag04', offset: 0x04, size: 4, type: 'u' },
  { name: 'cutsceneIndex', offset: 0x08, size: 4, type: 'u' },
  { name: 'timeOfDay', offset: 0x0c, size: 2, type: 'u' },
  { name: 'magic', offset: 0x1c, size: 6, type: 'bytes' },
  { name: 'counter22', offset: 0x22, size: 2, type: 'u' },
  { name: 'name', offset: 0x24, size: 8, type: 'bytes' },
  { name: 'field2C', offset: 0x2c, size: 2, type: 'u' },
  { name: 'healthCapacity', offset: 0x2e, size: 2, type: 'u' },
  { name: 'health', offset: 0x30, size: 2, type: 'u' },
  { name: 'sceneIndex', offset: 0x66, size: 2, type: 'u' },
  { name: 'bytes68', offset: 0x68, size: 10, type: 'bytes' },
  { name: 'itemSlots', offset: 0x74, size: 24, type: 'bytes' },
  { name: 'counts8C', offset: 0x8c, size: 16, type: 'bytes' },
  { name: 'bits9C', offset: 0x9c, size: 2, type: 'u' },
  { name: 'bitsA4', offset: 0xa4, size: 4, type: 'u' },
  { name: 'flagCF', offset: 0xcf, size: 1, type: 'u' },
  { name: 'checksum', offset: CHECKSUM_AT, size: 2, type: 'u' },
];

export type FieldValue = number | string;

export function readField(record: Uint8Array, f: FieldSpec): FieldValue {
  if (f.type === 'bytes') return Array.from(record.subarray(f.offset, f.offset + f.size), (b) => b.toString(16).padStart(2, '0')).join('');
  let v = 0;
  for (let i = 0; i < f.size; i++) v = v * 256 + record[f.offset + i]!;
  return v;
}
