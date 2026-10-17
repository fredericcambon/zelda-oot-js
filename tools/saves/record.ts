// Builds and edits save records of the PAL 1.0 game; docs/re/saves.md has the evidence for every offset and table.
import { MAGIC, MAGIC_AT, RECORD_SIZE, sealRecord } from './sram.ts';

const hex = (s: string) => Uint8Array.from(s.split(' ').map((b) => parseInt(b, 16)));

/** Bytes `save_defaults_new_file` (0x80090590) copies to record +0x1C (76 bytes from 0x800F9E78), +0x68 (10 from 0x800F9EC4) and +0x74 (96 from 0x800F9ED0). */
const DEFAULTS_1C = hex(
  '00 00 00 00 00 00 00 00 3e 3e 3e 3e 3e 3e 3e 3e 00 00 00 30 00 30 00 30 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 ff ff ff ff ff ff ff 00 00 00 ff ff ' +
  'ff ff ff ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  '00 00 00 34',
);
const DEFAULTS_68 = hex('ff ff ff ff ff ff ff 00 11 00');
const DEFAULTS_74 = hex(
  'ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 11 00 00 00 00 00 00 00 ' +
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 ' +
  'ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff ff 00 00 00 00 00',
);

export const NAME_AT = 0x24;
export const NAME_LENGTH = 8;
export const BLANK_CHAR = 0x3e;
export const ITEM_SLOTS = 24;
export const ITEMS_AT = 0x74;
export const COUNTS_AT = 0x8c;
export const WORD_9C_AT = 0x9c;
export const WORD_A0_AT = 0xa0;
export const WORD_A4_AT = 0xa4;
export const BYTES68_AT = 0x68;
export const WORD_70_AT = 0x70;
export const EMPTY_ITEM = 0xff;

const u16 = (r: Uint8Array, at: number) => (r[at]! << 8) | r[at + 1]!;
const put16 = (r: Uint8Array, at: number, v: number) => {
  r[at] = (v >>> 8) & 0xff;
  r[at + 1] = v & 0xff;
};
const put32 = (r: Uint8Array, at: number, v: number) => {
  put16(r, at, v >>> 16);
  put16(r, at + 2, v & 0xffff);
};
const u32 = (r: Uint8Array, at: number) => ((u16(r, at) << 16) | u16(r, at + 2)) >>> 0;
const i16 = (r: Uint8Array, at: number) => (u16(r, at) << 16) >> 16;

/** The record `sram_create_file` (0x80091238) writes for a new file, checksum included. */
export function newRecord(name: string): Uint8Array {
  const r = new Uint8Array(RECORD_SIZE);
  r.set(DEFAULTS_1C, 0x1c);
  r.set(DEFAULTS_68, BYTES68_AT);
  r.set(DEFAULTS_74, ITEMS_AT);
  r.set(MAGIC, MAGIC_AT);
  put32(r, 0x00, 0xbb);
  put32(r, 0x04, 1);
  put32(r, 0x08, 0xfff1);
  put16(r, 0x0c, 0x6aab);
  put16(r, 0x1348, 0x0051);
  put16(r, 0x134a, 0xf8d0);
  put16(r, 0x134c, 0x0048);
  put16(r, 0x134e, 0x1579);
  put16(r, 0x1350, 0x9527);
  put16(r, 0xf32, 1);
  put32(r, 0x164, 0x40000000);
  r.set(encodeName(name), NAME_AT);
  sealRecord(r);
  return r;
}

/** Character codes of the name: digits 0-9 are 0x00-0x09, capitals 0x0A-0x23, lower case 0x24-0x3D, blank 0x3E, '-' 0x3F, '.' 0x40. */
export function encodeName(name: string): Uint8Array {
  if (name.length > NAME_LENGTH) throw new Error(`name "${name}" is longer than ${NAME_LENGTH} characters`);
  const out = new Uint8Array(NAME_LENGTH).fill(BLANK_CHAR);
  [...name].forEach((c, i) => {
    const code = c.charCodeAt(0);
    if (c >= '0' && c <= '9') out[i] = code - 0x30;
    else if (c >= 'A' && c <= 'Z') out[i] = 0x0a + code - 0x41;
    else if (c >= 'a' && c <= 'z') out[i] = 0x24 + code - 0x61;
    else if (c === ' ') out[i] = BLANK_CHAR;
    else if (c === '-') out[i] = 0x3f;
    else if (c === '.') out[i] = 0x40;
    else throw new Error(`character "${c}" is not in the name table (digits, letters, space, '-' and '.')`);
  });
  return out;
}

export function decodeName(codes: Uint8Array): string {
  return Array.from(codes, (c) => {
    if (c <= 9) return String.fromCharCode(0x30 + c);
    if (c <= 0x23) return String.fromCharCode(0x41 + c - 0x0a);
    if (c <= 0x3d) return String.fromCharCode(0x61 + c - 0x24);
    if (c === 0x3f) return '-';
    if (c === 0x40) return '.';
    return c === BLANK_CHAR ? ' ' : '?';
  }).join('');
}

/** Item ids and the inventory slot the item-give routine (0x80070000) stores them in: the byte table at 0x800F6E94, one entry per id. */
export const ITEM_SLOT_OF_ID: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  ...Array<number>(13).fill(0x12), ...Array<number>(12).fill(0x17), ...Array<number>(11).fill(0x16),
];

/** Capacities of count34 by the two-bit field at bits 12-13 of the word at +0xA0 (table at 0x800F6C4C). */
export const LIMIT34_CAPACITY = [99, 200, 500, 500] as const;
const LIMIT34_SHIFT = 12;
const LIMIT34_MASK = 0x3000;

/** Item ids 59-70 in threes, one nibble each of the words at +0x9C and +0x70. */
export const NIBBLE_GROUPS = ['equip0', 'equip1', 'equip2', 'equip3'] as const;
export const NIBBLE_GROUPS_FIRST_ID = 59;
export const WORD_A4_BITS = 24;

/** Entrances of scenes 0-13 (halfword table at 0x800F9FF0) and of the scenes with their own case in the jump table at 0x80106A30. */
const SCENE_TABLE_ENTRANCES = [0x0000, 0x0004, 0x0028, 0x0169, 0x0165, 0x0010, 0x0082, 0x0037, 0x0098, 0x0088, 0x041b, 0x0008, 0x0486, 0x0467];
const SCENE_ENTRANCES = new Map<number, number>([
  [14, 0x41b], [15, 0x41b], [25, 0x41b], [26, 0x41b], [79, 0x41b], [17, 0], [18, 4], [19, 0x28], [20, 0x169], [21, 0x165], [22, 0x10], [23, 0x82],
  [24, 0x37], [52, 0xbb],
]);

/** Where the game resumes: `sram_load_slot` (0x8009087C) rewrites the entrance from the scene and, for other scenes, from the flag at +0x04. */
export function entranceFor(scene: number, flag04: number): number {
  return SCENE_TABLE_ENTRANCES[scene] ?? SCENE_ENTRANCES.get(scene) ?? (flag04 !== 0 ? 0xbb : 0x5f4);
}

function int(text: string, min: number, max: number, what: string): number {
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error(`${what}: "${text}" is not a number`);
  const v = Number(text);
  if (v < min || v > max) throw new Error(`${what}: ${v} is outside ${min}..${max}`);
  return v;
}

function itemId(text: string, what: string): number {
  return text === 'none' ? EMPTY_ITEM : int(text, 0, 0xfe, what);
}

function bitsOf(value: number, mask: number, shift: number): number {
  return (value & mask) >>> shift;
}

function withBits(word: number, mask: number, shift: number, v: number): number {
  return ((word & ~mask) | ((v << shift) & mask)) >>> 0;
}

/** Sets bit `level - 1` of nibble `g` of the word at +0x9C and the nibble of the word at +0x70 to `level`; level 0 clears the latter. Group 0 also stores its id at +0x68, as the item-give routine does (0x800705E4). */
function setNibbleGroup(r: Uint8Array, g: number, level: number): void {
  if (level === 0) {
    put16(r, WORD_70_AT, u16(r, WORD_70_AT) & ~(0xf << (4 * g)));
    if (g === 0) r[BYTES68_AT] = EMPTY_ITEM;
    return;
  }
  put16(r, WORD_9C_AT, u16(r, WORD_9C_AT) | (1 << (level - 1 + 4 * g)));
  put16(r, WORD_70_AT, (u16(r, WORD_70_AT) & ~(0xf << (4 * g))) | (level << (4 * g)));
  if (g === 0) r[BYTES68_AT] = NIBBLE_GROUPS_FIRST_ID + level - 1;
}

type Setter = (r: Uint8Array, value: string) => void;

const COUNTS_SLOTS = 16;
const BYTES68_COUNT = 4;

const simple: Record<string, Setter> = {
  name: (r, v) => r.set(encodeName(v), NAME_AT),
  hearts: (r, v) => {
    const units = int(v, 1, 20, 'hearts') * 16;
    put16(r, 0x2e, units);
    put16(r, 0x30, units);
  },
  health: (r, v) => {
    const hearts = Number(v);
    if (!Number.isFinite(hearts) || hearts < 0 || hearts * 16 > u16(r, 0x2e)) throw new Error(`health: ${v} is not between 0 and the heart capacity`);
    put16(r, 0x30, Math.round(hearts * 16));
  },
  flag3A: (r, v) => (r[0x3a] = int(v, 0, 1, 'flag3A')),
  flag3C: (r, v) => (r[0x3c] = int(v, 0, 1, 'flag3C')),
  count34: (r, v) => put16(r, 0x34, int(v, 0, 500, 'count34')),
  limit34: (r, v) => put32(r, WORD_A0_AT, withBits(u32(r, WORD_A0_AT), LIMIT34_MASK, LIMIT34_SHIFT, int(v, 0, 3, 'limit34'))),
  flag04: (r, v) => {
    const flag = int(v, 0, 1, 'flag04');
    put32(r, 0x04, flag);
    put32(r, 0x00, entranceFor(u16(r, 0x66), flag));
  },
  scene: (r, v) => {
    const scene = int(v, 0, 0x7f, 'scene');
    put16(r, 0x66, scene);
    put32(r, 0x00, entranceFor(scene, u32(r, 0x04)));
    // The new file's cutscene index 0xFFF1 selects the cutscene layer of the entrance, which only the house has.
    put32(r, 0x08, 0);
  },
  countD0: (r, v) => put16(r, 0xd0, int(v, 0, 0xffff, 'countD0')),
  item: (r, v) => {
    const id = int(v, 0, ITEM_SLOT_OF_ID.length - 1, 'item');
    r[ITEMS_AT + ITEM_SLOT_OF_ID[id]!] = id;
  },
};

/** Applies one `key=value` edit to a record (without sealing it). */
export function applyEdit(r: Uint8Array, key: string, value: string): void {
  const direct = simple[key];
  if (direct) return direct(r, value);
  let m: RegExpExecArray | null;
  if ((m = /^items\.(\d+)$/.exec(key))) {
    const slot = int(m[1]!, 0, ITEM_SLOTS - 1, 'item slot');
    r[ITEMS_AT + slot] = itemId(value, key);
    return;
  }
  if ((m = /^counts8C\.(\d+)$/.exec(key))) {
    r[COUNTS_AT + int(m[1]!, 0, COUNTS_SLOTS - 1, 'counts8C index')] = int(value, 0, 255, key);
    return;
  }
  if ((m = /^bitsA4\.(\d+)$/.exec(key))) {
    const bit = int(m[1]!, 0, WORD_A4_BITS - 1, 'bitsA4 bit');
    const on = int(value, 0, 1, key);
    put32(r, WORD_A4_AT, on ? (u32(r, WORD_A4_AT) | (1 << bit)) >>> 0 : (u32(r, WORD_A4_AT) & ~(1 << bit)) >>> 0);
    return;
  }
  if ((m = /^byte68\.([0-3])$/.exec(key))) {
    r[BYTES68_AT + int(m[1]!, 0, BYTES68_COUNT - 1, 'byte68 index')] = itemId(value, key);
    return;
  }
  const g = (NIBBLE_GROUPS as readonly string[]).indexOf(key);
  if (g >= 0) return setNibbleGroup(r, g, int(value, 0, 3, key));
  throw new Error(`unknown field "${key}"; known: ${FIELD_HELP.join(', ')}`);
}

export const FIELD_HELP = [
  'name=<text>', 'hearts=<1..20>', 'health=<hearts>', 'flag3A=<0|1>', 'flag3C=<0|1>',
  'count34=<0..500>', 'limit34=<0..3>', 'flag04=<0|1>', 'scene=<index>', 'countD0=<n>', 'item=<id>', 'items.<slot>=<id|none>',
  'counts8C.<0..15>=<n>', 'bitsA4.<bit 0..23>=<0|1>', 'byte68.<0..3>=<id|none>', 'equip0..equip3=<0..3>',
];

/** Edits a record and reseals it; throws before touching `r` when an edit is invalid or count34 exceeds the limit34. */
export function editRecord(r: Uint8Array, edits: readonly (readonly [string, string])[]): void {
  const work = r.slice();
  for (const [k, v] of edits) applyEdit(work, k, v);
  const cap = LIMIT34_CAPACITY[bitsOf(u32(work, WORD_A0_AT), LIMIT34_MASK, LIMIT34_SHIFT)]!;
  if (i16(work, 0x34) > cap) throw new Error(`count34: ${i16(work, 0x34)} exceeds the limit34 capacity ${cap}; raise limit34 first`);
  sealRecord(work);
  r.set(work);
}

/** A readable view of the fields `editRecord` can set. */
export function describeRecord(r: Uint8Array): Record<string, unknown> {
  const word9C = u16(r, WORD_9C_AT);
  const word70 = u16(r, WORD_70_AT);
  const bitsA4 = u32(r, WORD_A4_AT);
  const flag04 = u32(r, 0x04);
  const scene = u16(r, 0x66);
  return {
    name: decodeName(r.subarray(NAME_AT, NAME_AT + NAME_LENGTH)),
    hearts: u16(r, 0x2e) / 16,
    health: u16(r, 0x30) / 16,
    level32: r[0x32],
    byte33: r[0x33],
    flag3A: r[0x3a],
    flag3C: r[0x3c],
    count34: i16(r, 0x34),
    limit34: bitsOf(u32(r, WORD_A0_AT), LIMIT34_MASK, LIMIT34_SHIFT),
    flag04,
    scene,
    resumeEntrance: entranceFor(scene, flag04),
    countD0: u16(r, 0xd0),
    items: Array.from(r.subarray(ITEMS_AT, ITEMS_AT + ITEM_SLOTS)),
    counts8C: Array.from(r.subarray(COUNTS_AT, COUNTS_AT + COUNTS_SLOTS)),
    bytes68: Array.from(r.subarray(BYTES68_AT, BYTES68_AT + 4)),
    nibbleGroups: Object.fromEntries(
      NIBBLE_GROUPS.map((n, g) => [n, { word9C: (word9C >>> (4 * g)) & 7, word70: (word70 >>> (4 * g)) & 0xf }]),
    ),
    bitsA4: Array.from({ length: WORD_A4_BITS }, (_, b) => b).filter((b) => bitsA4 & (1 << b)),
  };
}
