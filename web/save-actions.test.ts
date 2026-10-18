import { describe, expect, it } from 'vitest';
import { SCENE_RECORD_SIZE, SCENE_TABLE } from '../tools/headless/state.ts';
import { AutoStart } from '../tools/headless/load-save.ts';
import { blankImage, putRecord } from '../tools/saves/image.ts';
import { newRecord } from '../tools/saves/record.ts';
import type { Game } from './game.ts';
import { backToFileSelect, loadSaveFile, loadSlotIntoPlay, type SaveTarget } from './save-actions.ts';
import { SaveSync, type SaveMemory, type SaveStore } from './saves.ts';

function target(sram: Uint8Array, ram = new Uint8Array(0x800000)) {
  const calls = { reset: 0, restarted: 0, stored: [] as Uint8Array[], backups: 0 };
  const memory: SaveMemory = { read: () => sram.slice(), write: (b) => sram.set(b), takeIfDirty: () => null };
  const store: SaveStore = {
    load: async () => null,
    store: async (b, options) => {
      calls.stored.push(b.slice());
      if (options?.backup) calls.backups++;
    },
  };
  const game = { saveMemory: memory, ram: () => ram, reset: () => calls.reset++ } as unknown as Game;
  const t: SaveTarget = { game, saves: new SaveSync(memory, store), restarted: () => calls.restarted++ };
  return { t, calls, sram };
}

/** Guest memory of a running scene, as the safe-state check reads it. */
function playingRam() {
  const ram = new Uint8Array(0x800000);
  const view = new DataView(ram.buffer);
  view.setUint32(0x112be0, 0x80300000);
  view.setUint32(0x300000 + 0xa4, 52 << 16);
  view.setUint32(0x300000 + 0x1242c, SCENE_TABLE + 52 * SCENE_RECORD_SIZE);
  view.setUint32(0x300000 + 0x98, 1);
  return ram;
}

const withFile = () => {
  const sram = blankImage();
  putRecord(sram, 1, newRecord('Link'));
  return sram;
};

describe('loadSaveFile', () => {
  it('backs up and replaces the stored save, puts it in the game and starts over', async () => {
    const { t, calls, sram } = target(blankImage());
    const image = withFile();
    expect(await loadSaveFile(t, image.subarray(0, 0x8000))).toMatch(/loaded/);
    expect(calls).toMatchObject({ reset: 1, restarted: 1, backups: 1 });
    expect(Buffer.from(sram).equals(Buffer.from(image))).toBe(true);
  });

  it('refuses a file that is not a PAL save memory image, touching nothing', async () => {
    const { t, calls } = target(blankImage());
    expect(await loadSaveFile(t, new Uint8Array(100))).toMatch(/Not loaded: unsupported/);
    expect(await loadSaveFile(t, new Uint8Array(0x8000))).toMatch(/Not loaded: unsupported/);
    expect(calls).toMatchObject({ reset: 0, restarted: 0, stored: [] });
  });
});

describe('loadSlotIntoPlay', () => {
  it('says so when the slot has no file', () => {
    expect(loadSlotIntoPlay(target(withFile(), playingRam()).t, 0)).toBe('Slot 1 has no file');
  });

  it('refuses outside a running scene and names why', () => {
    expect(loadSlotIntoPlay(target(withFile()).t, 1)).toMatch(/^Not now: .*not in a scene/);
  });

  it('loads the file of the slot in a running scene', () => {
    const ram = playingRam();
    expect(loadSlotIntoPlay(target(withFile(), ram).t, 1)).toBe('Slot 2 loaded into play (scene 52)');
    expect(new DataView(ram.buffer).getUint32(0x300000 + 0x98)).toBe(0);
  });

  it('rejects a slot that does not exist', () => {
    expect(() => loadSlotIntoPlay(target(withFile()).t, 3)).toThrow(/does not exist/);
  });
});

describe('backToFileSelect', () => {
  it('starts the game over and asks for Start presses', () => {
    const { t, calls } = target(blankImage());
    expect(backToFileSelect(t)).toMatch(/file select/);
    expect(calls).toMatchObject({ reset: 1, restarted: 1 });
  });
});

describe('AutoStart', () => {
  it('presses Start at intervals until the file select is reached, then stays off', () => {
    let reached = false;
    const start = new AutoStart(() => reached);
    const pressed = Array.from({ length: 160 }, () => start.buttons());
    expect(pressed.slice(0, 100).every((b) => b === 0)).toBe(true);
    expect(pressed.slice(100, 106).every((b) => b === 0x1000)).toBe(true);
    expect(pressed.slice(106, 150).every((b) => b === 0)).toBe(true);
    expect(pressed[150]).toBe(0x1000);
    reached = true;
    expect(start.buttons()).toBe(0);
    expect(start.active).toBe(false);
  });

  it('gives up after its frame limit', () => {
    const start = new AutoStart(() => false, 10);
    for (let i = 0; i < 11; i++) start.buttons();
    expect(start.active).toBe(false);
  });
});
