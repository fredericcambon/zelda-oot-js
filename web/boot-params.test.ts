import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootGame } from '../tools/headless/boot.ts';
import { guestRam, loadRecordIntoPlay, SAVE_CONTEXT, unsafeReason } from '../tools/headless/load-save.ts';
import { linkPosition, playState } from '../tools/headless/state.ts';
import { buildGame } from '../tools/saves/game.ts';
import { blankImage, getRecord, putRecord } from '../tools/saves/image.ts';
import { editRecord, newRecord } from '../tools/saves/record.ts';
import { parseBootParams } from './boot-params.ts';

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

describe.skipIf(!rom || !existsSync(rom))('entering a file from the title demo scene', () => {
  it('puts each file of the save memory in play, and Link answers the stick', async () => {
    const { moduleUrl, cartridge } = await buildGame(rom!, resolve('out', 'boot-params-boot'));
    const sram = blankImage();
    for (let i = 0; i < 3; i++) {
      const record = newRecord(`File${i + 1}`);
      editRecord(record, [['hearts', String(5 + i)]]);
      putRecord(sram, i, record);
    }
    for (const slot of [2, 0]) {
      const game = await bootGame(moduleUrl, cartridge, {});
      game.writeSave(sram);
      const mem = () => guestRam(game.ram());
      const run = async (frames: number, y: number) => {
        game.setPad(0, 0, y);
        for (let i = 0; i < frames; i++) {
          const r = await game.frame();
          if (r.fatal) throw new Error(r.fatal);
        }
      };
      for (let i = 0; i < 1500 && !playState(game.rd32); i++) await run(1, 0);
      expect(unsafeReason(mem())).toBeDefined();
      loadRecordIntoPlay(mem(), getRecord(sram, slot)!, slot, true);
      await run(500, 0);
      expect(unsafeReason(mem()), `file ${slot + 1}`).toBeUndefined();
      expect(mem().rd32(SAVE_CONTEXT + 0x1354), `file ${slot + 1}`).toBe(slot);
      const before = linkPosition(game.rd32, playState(game.rd32)!)!;
      await run(100, 70);
      const after = linkPosition(game.rd32, playState(game.rd32)!)!;
      expect(Math.hypot(after.x - before.x, after.z - before.z), `file ${slot + 1}`).toBeGreaterThan(1);
    }
  }, 3_600_000);
});
