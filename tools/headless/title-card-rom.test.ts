import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { bootGame } from './boot.ts';
import { padAt } from './input.ts';
import { playState, requestEntrance } from './state.ts';
import { rom, SCRIPT, CONTROL_FRAME, buildGame } from './headless-support.ts';

/** Offset in the play context of the title card record the scene start fills (docs/re/title-cards.md). */
const CARD_RECORD = 0x1d4c;
/** Halfwords of the save context that scenes 1 and 50 test before drawing their card. */
const FLAG_SCENE_1 = { at: 0x801192ba, bit: 0x1 };
const FLAG_SCENE_50 = { at: 0x801192a8, bit: 0x20 };

describe.skipIf(!rom || !existsSync(rom))('which entrances start a title card', () => {
  async function arrive(entries: readonly { entry: number; setFlag?: { at: number; bit: number } }[]) {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    for (let frame = 1; frame <= CONTROL_FRAME; frame++) {
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
    }
    game.setPad(0, 0, 0);
    const results: { entry: number; scene: number; buffer: number; size: number }[] = [];
    for (const { entry, setFlag } of entries) {
      const ram = game.ram();
      const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
      if (setFlag) view.setUint16(setFlag.at & 0x7fffff, view.getUint16(setFlag.at & 0x7fffff) | setFlag.bit);
      requestEntrance(game.rd32, (a, x) => view.setUint32(a & 0x7fffff, x >>> 0), playState(game.rd32)!, entry);
      for (let k = 0; k < 100; k++) expect((await game.frame()).fatal).toBeUndefined();
      const play = playState(game.rd32)!;
      // The record starts with the pointer to the picture buffer; its next word holds the position, the one after the size and the countdowns.
      results.push({ entry, scene: play.scene, buffer: game.rd32(play.context + CARD_RECORD) >>> 0, size: game.rd32(play.context + CARD_RECORD + 8) >>> 16 });
    }
    return results;
  }

  it('fills the record for entrances with bit 0x4000 of scenes that have a card, and for no other', async () => {
    const [flagged, flaggedToo, unflagged, noCard, scene1, scene50, scene1Set, scene50Set] = await arrive([
      { entry: 238 }, // scene 85, bit set
      { entry: 40 }, // scene 2, bit set
      { entry: 614 }, // scene 85, bit clear
      { entry: 187 }, // scene 52, bit set, no card file
      { entry: 4 }, // scene 1, flag clear
      { entry: 912 }, // scene 50, flag clear
      { entry: 4, setFlag: FLAG_SCENE_1 },
      { entry: 912, setFlag: FLAG_SCENE_50 },
    ]);
    expect([flagged!.scene, flaggedToo!.scene, unflagged!.scene, noCard!.scene, scene1!.scene, scene50!.scene]).toEqual([85, 2, 85, 52, 1, 50]);
    for (const r of [flagged!, flaggedToo!, scene1Set!, scene50Set!]) {
      expect(r.buffer, `entrance ${r.entry}`).toBeGreaterThan(0x80000000);
      expect(r.size).toBe(0x9018);
    }
    for (const r of [unflagged!, noCard!, scene1!, scene50!]) expect(r.buffer, `entrance ${r.entry}`).toBe(0);
  });
});
