import { describe, expect, it } from 'vitest';
import { SCENE_RECORD_SIZE, SCENE_TABLE } from './state.ts';
import { newRecord } from '../saves/record.ts';
import { guestRam, isRecord, loadRecordIntoPlay, SAVE_CONTEXT, UnsafeStateError, unsafeReason, type GuestRam } from './load-save.ts';

const CONTEXT = 0x80300000;
const POINTER = 0x80112be0;
const GAME_MODE = 0x8011972c;

/** Guest memory with a loaded play state in scene 52, running, with no transition. */
function playing(): GuestRam {
  const mem = guestRam(new Uint8Array(0x800000));
  mem.write32(POINTER, CONTEXT);
  mem.write32(CONTEXT + 0xa4, 52 << 16);
  mem.write32(CONTEXT + 0x1242c, SCENE_TABLE + 52 * SCENE_RECORD_SIZE);
  mem.write32(CONTEXT + 0x98, 1);
  return mem;
}

describe('unsafeReason', () => {
  it('accepts a running scene with no transition', () => {
    expect(unsafeReason(playing())).toBeUndefined();
  });

  it('refuses before any scene is loaded', () => {
    expect(unsafeReason(guestRam(new Uint8Array(0x800000)))).toMatch(/not in a scene/);
  });

  it('refuses when the pointer does not describe a scene', () => {
    const mem = playing();
    mem.write32(CONTEXT + 0x1242c, 0);
    expect(unsafeReason(mem)).toMatch(/not in a scene/);
  });

  it('refuses at the title screen', () => {
    const mem = playing();
    mem.write32(GAME_MODE, 1);
    expect(unsafeReason(mem)).toMatch(/title/);
  });

  it('refuses while the state is ending', () => {
    const mem = playing();
    mem.write32(CONTEXT + 0x98, 0);
    expect(unsafeReason(mem)).toMatch(/leaving/);
  });

  it('refuses during a scene transition', () => {
    const trigger = playing();
    trigger.write8(CONTEXT + 0x11e15, 0xec);
    expect(unsafeReason(trigger)).toMatch(/transition/);
    const phase = playing();
    phase.write8(CONTEXT + 0x1241b, 3);
    expect(unsafeReason(phase)).toMatch(/transition/);
  });
});

describe('loadRecordIntoPlay', () => {
  it('leaves the memory untouched when the state is unsafe', () => {
    const ram = new Uint8Array(0x800000);
    const mem = guestRam(ram);
    const before = ram.slice();
    expect(() => loadRecordIntoPlay(mem, newRecord('Link'), 0)).toThrow(UnsafeStateError);
    expect(ram).toEqual(before);
  });

  it('refuses bytes that are not a save record', () => {
    expect(() => loadRecordIntoPlay(playing(), new Uint8Array(0x1354), 0)).toThrow(/not a save record/);
    expect(isRecord(new Uint8Array(10))).toBe(false);
    expect(isRecord(newRecord('Link'))).toBe(true);
  });

  it('copies the record, sets the slot and ends the play state at the record entrance', () => {
    const mem = playing();
    const record = newRecord('Zelda');
    const warp = loadRecordIntoPlay(mem, record, 2);
    expect(warp).toEqual({ scene: 52, entrance: 0xbb });
    expect(mem.rd8(SAVE_CONTEXT + 0x24)).toBe(record[0x24]);
    expect(mem.rd32(SAVE_CONTEXT + 0x1354)).toBe(2);
    expect(mem.rd32(SAVE_CONTEXT)).toBe(0xbb);
    expect(mem.rd32(SAVE_CONTEXT + 0x08)).toBe(0);
    expect(mem.rd32(CONTEXT + 0x98)).toBe(0);
    expect(mem.rd32(CONTEXT + 0x0c)).toBe(0x8009aea0);
    expect(mem.rd32(CONTEXT + 0x10)).toBe(0x12518);
    expect(unsafeReason(mem)).toMatch(/leaving/);
  });

  it('raises a health below the file select minimum and clears the level bytes', () => {
    const mem = playing();
    const record = newRecord('Link');
    record[0x31] = 0x08;
    record[0x32] = 7;
    record[0x33] = 9;
    loadRecordIntoPlay(mem, record, 0);
    expect((mem.rd8(SAVE_CONTEXT + 0x30) << 8) | mem.rd8(SAVE_CONTEXT + 0x31)).toBe(0x30);
    expect(mem.rd8(SAVE_CONTEXT + 0x32)).toBe(0);
    expect(mem.rd8(SAVE_CONTEXT + 0x33)).toBe(0);
  });
});
