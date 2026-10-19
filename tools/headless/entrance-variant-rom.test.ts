import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { bootGame } from './boot.ts';
import { padAt } from './input.ts';
import { ENTRANCE_INDEX, playState, requestEntrance, SETUP_VARIANT } from './state.ts';
import { rom, SCRIPT, CONTROL_FRAME, buildGame } from './headless-support.ts';

const SAVE_CONTEXT = ENTRANCE_INDEX;
const TIME_OF_DAY = SAVE_CONTEXT + 0xc;

describe.skipIf(!rom || !existsSync(rom))('the variant added to an entrance index (docs/re/entrances.md)', () => {
  it('is 0 by day and 1 at night while the save word at +4 is set, with the cut-offs of the code at 0x8009B0B0-0x8009B0C0', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    for (let frame = 1; frame <= CONTROL_FRAME; frame++) {
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
    }
    game.setPad(0, 0, 0);
    expect(game.rd32(SAVE_CONTEXT + 4)).toBe(1);
    const seen: { time: number; variant: number }[] = [];
    for (const time of [0x0000, 0x4554, 0x4555, 0x6aab, 0xc000, 0xc001, 0xffff]) {
      const ram = game.ram();
      const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
      view.setUint16(TIME_OF_DAY & 0x7fffff, time);
      requestEntrance(game.rd32, (a, v) => view.setUint32(a & 0x7fffff, v >>> 0), playState(game.rd32)!, 238);
      for (let k = 0; k < 40; k++) expect((await game.frame()).fatal).toBeUndefined();
      seen.push({ time, variant: game.rd32(SETUP_VARIANT) });
    }
    expect(seen).toEqual([
      { time: 0x0000, variant: 1 },
      { time: 0x4554, variant: 1 },
      { time: 0x4555, variant: 0 },
      { time: 0x6aab, variant: 0 },
      { time: 0xc000, variant: 0 },
      { time: 0xc001, variant: 1 },
      { time: 0xffff, variant: 1 },
    ]);
  });
});
