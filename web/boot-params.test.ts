import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootGame } from '../tools/headless/boot.ts';
import { guestRam, SAVE_CONTEXT } from '../tools/headless/load-save.ts';
import { buildGame } from '../tools/saves/game.ts';
import { blankImage, putRecord } from '../tools/saves/image.ts';
import { editRecord, newRecord } from '../tools/saves/record.ts';
import { FileEntry, parseBootParams } from './boot-params.ts';

describe('parseBootParams', () => {
  it('reads state, file and warp, the warp in decimal or hex', () => {
    expect(parseBootParams('?state=2&file=1&warp=0x0EE')).toEqual({ state: 2, file: 1, warp: 0xee, problems: [] });
    expect(parseBootParams('?warp=238')).toMatchObject({ warp: 238 });
    expect(parseBootParams('')).toEqual({ problems: [] });
  });

  it('reports each unusable parameter and leaves it out', () => {
    const p = parseBootParams('?state=5&file=0&warp=0x10000');
    expect(p).toMatchObject({ state: undefined, file: undefined, warp: undefined });
    expect(p.problems).toHaveLength(3);
    expect(p.problems[0]).toContain('state=5');
    expect(parseBootParams('?file=abc&warp=-1').problems).toHaveLength(2);
  });
});

const rom = process.env.OOT_ROM;

describe.skipIf(!rom || !existsSync(rom))('FileEntry', () => {
  it('enters the file asked for with the inputs of a player', async () => {
    const { moduleUrl, cartridge } = await buildGame(rom!, resolve('out', 'boot-params-boot'));
    const sram = blankImage();
    for (let i = 0; i < 3; i++) {
      const record = newRecord(`File${i + 1}`);
      editRecord(record, [['hearts', String(5 + i)]]);
      putRecord(sram, i, record);
    }
    for (const slot of [2, 1, 0]) {
      const game = await bootGame(moduleUrl, cartridge, {});
      game.writeSave(sram);
      const entry = new FileEntry(slot, () => guestRam(game.ram()), 1800);
      let frames = 0;
      while (entry.outcome === 'running' && frames++ < 6000) {
        const pad = entry.step();
        game.setPad(pad.buttons, pad.x, pad.y);
        const r = await game.frame();
        if (r.fatal) throw new Error(r.fatal);
      }
      expect(entry.outcome, `file ${slot + 1}`).toBe('entered');
      expect(guestRam(game.ram()).rd32(SAVE_CONTEXT + 0x1354), `file ${slot + 1}`).toBe(slot);
    }
  }, 3_600_000);
});
