// The save context of the running game (0x801183d0): its fields as `describeRecord` names them, edits through the same
// rules as `editRecord`, and per-field holds that rewrite a value before every frame.
import { SAVE_CONTEXT, type GuestRam } from '../../tools/headless/load-save.ts';
import { COUNTS_AT, describeRecord, editRecord, ITEMS_AT, WORD_9C_AT, WORD_A0_AT, WORD_A4_AT } from '../../tools/saves/record.ts';
import { CHECKED_SIZE, CHECKSUM_AT } from '../../tools/saves/sram.ts';
import type { Bridge } from './bridge.ts';
import type { Freeze, FreezeSize } from './freeze.ts';
import { Refused } from './queue.ts';

export type Fields = Record<string, unknown>;

export interface InventorySnapshot {
  /** `describeRecord` of the live context; null while no game runs. */
  fields: Fields | null;
  /** Keys of the fields that are held. */
  frozen: string[];
  /** Why edits are refused now; undefined when they are allowed. */
  refusal: string | undefined;
}

export const EMPTY_INVENTORY: InventorySnapshot = { fields: null, frozen: [], refusal: 'no game is running' };

/** Bit positions of the four upgrade fields of the word at +0xA0, in the order of the equipment page's left column (docs/re/saves.md). */
export const UPGRADE_SHIFTS = [14, 3, 6, 9] as const;

const be = (r: Uint8Array, at: number, size: 2 | 4): number => {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + r[at + i]!;
  return v;
};
const putBe = (r: Uint8Array, at: number, size: 2 | 4, value: number): void => {
  for (let i = size - 1, v = value >>> 0; i >= 0; i--, v = Math.floor(v / 256)) r[at + i] = v & 255;
};

/** The record's fields as `describeRecord` names them, plus the ones `editRecord` does not know: the heart pieces (bits 28-31 of the word at +0xA4) and the four upgrade levels. */
export function describeContext(record: Uint8Array): Fields {
  const a0 = be(record, WORD_A0_AT, 4);
  return {
    ...describeRecord(record),
    heartPieces: be(record, WORD_A4_AT, 4) >>> 28,
    upgrades: UPGRADE_SHIFTS.map((shift) => (a0 >>> shift) & 7),
  };
}

const MAGIC_FULL = [0, 0x30, 0x60];

/** Applies the edits `editRecord` does not know and returns the others. Keys: `heartPieces` 0-3, `upgrade.<0-3>` 0-7, `magic` 0-96, `magicSize` 0-2, `own.<group>.<column>` 0-1. */
function applyExtras(r: Uint8Array, edits: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  const rest: (readonly [string, string])[] = [];
  const num = (key: string, text: string, max: number): number => {
    if (!/^\d+$/.test(text) || Number(text) > max) throw new Error(`${key}: "${text}" is not a number from 0 to ${max}`);
    return Number(text);
  };
  for (const edit of edits) {
    const [key, text] = edit;
    let m: RegExpExecArray | null;
    if (key === 'heartPieces') putBe(r, WORD_A4_AT, 4, (be(r, WORD_A4_AT, 4) & 0x0fffffff) | (num(key, text, 3) << 28));
    else if ((m = /^upgrade\.([0-3])$/.exec(key))) {
      const shift = UPGRADE_SHIFTS[Number(m[1])]!;
      putBe(r, WORD_A0_AT, 4, ((be(r, WORD_A0_AT, 4) & ~(7 << shift)) | (num(key, text, 7) << shift)) >>> 0);
    } else if (key === 'magic') r[0x33] = num(key, text, 0x60);
    else if (key === 'magicSize') {
      const size = num(key, text, 2);
      r[0x3a] = size > 0 ? 1 : 0;
      r[0x3c] = size > 1 ? 1 : 0;
      r[0x32] = size;
      r[0x33] = Math.min(r[0x33]!, MAGIC_FULL[size]!);
    } else if ((m = /^own\.([0-3])\.([0-2])$/.exec(key))) {
      const bit = 1 << (Number(m[2]) + 4 * Number(m[1]));
      putBe(r, WORD_9C_AT, 2, num(key, text, 1) ? be(r, WORD_9C_AT, 2) | bit : be(r, WORD_9C_AT, 2) & ~bit);
    } else rest.push(edit);
  }
  return rest;
}

export function readContext(mem: GuestRam): Uint8Array {
  const record = new Uint8Array(CHECKED_SIZE);
  for (let i = 0; i < CHECKED_SIZE; i++) record[i] = mem.rd8(SAVE_CONTEXT + i);
  return record;
}

interface Span {
  at: number;
  size: FreezeSize;
}

/** The bytes of a numeric field, or null when the field cannot be held. `hearts` holds the capacity and the health together, as editing it sets both. */
export function spansOf(key: string): Span[] | null {
  let m: RegExpExecArray | null;
  if (key === 'hearts') return [{ at: 0x2e, size: 2 }, { at: 0x30, size: 2 }];
  if (key === 'health') return [{ at: 0x30, size: 2 }];
  if (key === 'count34') return [{ at: 0x34, size: 2 }];
  if (key === 'countD0') return [{ at: 0xd0, size: 2 }];
  if ((m = /^items\.(\d+)$/.exec(key))) return [{ at: ITEMS_AT + Number(m[1]), size: 1 }];
  if ((m = /^counts8C\.(\d+)$/.exec(key))) return [{ at: COUNTS_AT + Number(m[1]), size: 1 }];
  return null;
}

const HELD_KEYS = ['hearts', 'health', 'count34', 'countD0'];

function heldKeys(fields: Fields): string[] {
  const keys = [...HELD_KEYS];
  (fields.items as number[]).forEach((_, i) => keys.push(`items.${i}`));
  (fields.counts8C as number[]).forEach((_, i) => keys.push(`counts8C.${i}`));
  return keys;
}

function freezeFor(freezes: readonly Freeze[], span: Span): Freeze | undefined {
  return freezes.find((f) => !f.owner && f.addr === SAVE_CONTEXT + span.at && f.size === span.size);
}

/** A field is held when every byte range it covers is. */
function isFrozen(bridge: Bridge, key: string): boolean {
  const spans = spansOf(key);
  return !!spans && spans.every((s) => freezeFor(bridge.freezes.list(), s));
}

export function inventorySnapshot(bridge: Bridge): InventorySnapshot {
  const mem = bridge.ram();
  if (!mem) return EMPTY_INVENTORY;
  const fields = describeContext(readContext(mem));
  return { fields, frozen: heldKeys(fields).filter((k) => isFrozen(bridge, k)), refusal: bridge.unsafeReason() };
}

export function sameInventory(a: InventorySnapshot, b: InventorySnapshot): boolean {
  return a.refusal === b.refusal && JSON.stringify(a.fields) === JSON.stringify(b.fields) && a.frozen.join() === b.frozen.join();
}

const rawValue = (mem: GuestRam, span: Span): number => {
  let v = 0;
  for (let i = 0; i < span.size; i++) v = v * 256 + mem.rd8(SAVE_CONTEXT + span.at + i);
  return v;
};

function hold(bridge: Bridge, mem: GuestRam, key: string): void {
  for (const span of spansOf(key) ?? []) bridge.freezes.add(SAVE_CONTEXT + span.at, span.size, rawValue(mem, span));
}

/** Applies `key=value` edits (the keys `editRecord` knows) to the live context, between frames; the checksum is left alone. Held fields keep the new value. */
export function editContext(bridge: Bridge, edits: readonly (readonly [string, string])[]): string {
  const mem = bridge.writable();
  const before = readContext(mem);
  const after = before.slice();
  try {
    editRecord(after, applyExtras(after, edits));
  } catch (err) {
    throw new Refused(err instanceof Error ? err.message : String(err));
  }
  for (let i = 0; i < CHECKED_SIZE; i++) {
    if (i === CHECKSUM_AT || i === CHECKSUM_AT + 1 || after[i] === before[i]) continue;
    mem.write8(SAVE_CONTEXT + i, after[i]!);
  }
  for (const [key] of edits) if (isFrozen(bridge, key)) hold(bridge, mem, key);
  return `Set ${edits.map(([k, v]) => `${k} = ${v}`).join(', ')}`;
}

/** Holds a numeric field at its current value, or releases it. */
export function toggleFreeze(bridge: Bridge, key: string): string | void {
  const spans = spansOf(key);
  if (!spans) throw new Refused(`${key} cannot be held`);
  if (isFrozen(bridge, key)) {
    for (const s of spans) {
      const f = freezeFor(bridge.freezes.list(), s);
      if (f) bridge.freezes.remove(f.id);
    }
    return `Released ${key}`;
  }
  const mem = bridge.ram();
  if (!mem) throw new Refused('Not now: no game is running');
  hold(bridge, mem, key);
  return `Holding ${key}`;
}
