import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bootGame, type Game } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { ENTRANCE_TABLE, linkPosition, playState } from './state.ts';
import { AutoStart, fileSelectReached, guestRam, loadRecordIntoPlay, SAVE_CONTEXT, unsafeReason } from './load-save.ts';
import { buildGame } from './headless-support.ts';
import { blankImage, putRecord } from '../saves/image.ts';
import { describeRecord, editRecord, newRecord } from '../saves/record.ts';

const rom = process.env.OOT_ROM;

/** Title, then A opens the first file's prompt and A on "Yes" loads it (tools/saves/game.ts). */
const LOAD_SCRIPT = parseInput(`2450 START
2460 NONE
2700 A
2710 NONE
2900 A
2910 NONE
`, 'load-script');

/** A game booted on a save memory with one file, played with the load script until a scene is running and settled. */
async function inPlay(sram: Uint8Array): Promise<{ game: Game; frame: number }> {
  const { moduleUrl, cartridge } = await buildGame();
  const game = await bootGame(moduleUrl, cartridge, {});
  game.writeSave(sram);
  const run = new Runner(game);
  while (run.frame < 5000 && !(run.frame > 2905 && playState(game.rd32) && unsafeReason(guestRam(game.ram())) === undefined)) await run.step();
  return { game, frame: run.frame };
}

class Runner {
  frame = 0;
  constructor(private readonly game: Game) {}
  async step(): Promise<void> {
    this.frame++;
    const pad = padAt(LOAD_SCRIPT, this.frame);
    this.game.setPad(pad.buttons, pad.x, pad.y);
    const r = await this.game.frame();
    if (r.fatal) throw new Error(`frame ${this.frame}: ${r.fatal}`);
  }
  async steps(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await this.step();
  }
}

const contextRecord = (game: Game) => game.ram().slice(SAVE_CONTEXT & 0x7fffff, (SAVE_CONTEXT & 0x7fffff) + 0x1354);
const house = (name: string) => {
  const record = newRecord(name);
  editRecord(record, [['hearts', '7']]);
  const sram = blankImage();
  putRecord(sram, 0, record);
  return sram;
};

describe.skipIf(!rom || !existsSync(rom))('loading a save into the running game', () => {
  it('refuses while the game starts up and at the title, and accepts a settled scene', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    const run = new Runner(game);
    expect(unsafeReason(guestRam(game.ram()))).toMatch(/not in a scene/);
    await run.steps(1500);
    expect(playState(game.rd32)?.scene).toBe(81);
    expect(unsafeReason(guestRam(game.ram()))).toMatch(/title/);
  }, 3_600_000);

  it('puts the record in play: its scene, hearts and items', async () => {
    const { game, frame } = await inPlay(house('Link'));
    const run = new Runner(game);
    run.frame = frame;
    expect(playState(game.rd32)?.scene).toBe(52);

    const record = newRecord('Epona');
    editRecord(record, [['hearts', '12'], ['flag04', '0'], ['scene', '85'], ['item', '3'], ['items.0', '0'], ['bitsA4.0', '1']]);
    const warp = loadRecordIntoPlay(guestRam(game.ram()), record, 1);
    expect(warp).toEqual({ scene: 85, entrance: 0x5f4 });
    expect(unsafeReason(guestRam(game.ram()))).toMatch(/leaving/);

    await run.steps(400);
    const reached = playState(game.rd32);
    expect(reached?.scene).toBe(game.rd32(ENTRANCE_TABLE + 4 * (0x5f4 + 2)) >>> 24);
    expect(reached?.scene).not.toBe(52);
    expect(linkPosition(game.rd32, reached!)).toBeDefined();

    const got = describeRecord(contextRecord(game));
    const want = describeRecord(record);
    for (const key of ['name', 'hearts', 'health', 'items', 'bitsA4'] as const) expect(got[key], key).toEqual(want[key]);
    expect(game.rd32(SAVE_CONTEXT + 0x1354)).toBe(1);
  }, 3_600_000);

  it('plays on in a scene the file select cannot reach with a new-file record', async () => {
    // The new-file record carries cutscene index 0xFFF1; the file select's load then enters the cutscene layer of entrance
    // 0x10 (table entry 0x15, scene 110), whose data lies beyond the cartridge. Applying a record clears the cutscene.
    const { game, frame } = await inPlay(house('Link'));
    const run = new Runner(game);
    run.frame = frame;
    const record = newRecord('Zelda');
    editRecord(record, [['scene', '5']]);
    expect(loadRecordIntoPlay(guestRam(game.ram()), record, 0)).toEqual({ scene: 5, entrance: 0x10 });
    await run.steps(300);
    expect(playState(game.rd32)?.scene).toBe(5);
  }, 3_600_000);

  it('replaces the save memory and starts over: the file select lists the new file and loads it', async () => {
    const { game } = await inPlay(house('Link'));
    const epona = newRecord('Epona');
    editRecord(epona, [['hearts', '9']]);
    const sram = blankImage();
    putRecord(sram, 0, epona);
    game.writeSave(sram);
    game.reset();

    const run = new Runner(game);
    let loaded = false;
    while (run.frame < 3600 && !loaded) {
      await run.step();
      loaded = run.frame > 2905 && game.ram()[(SAVE_CONTEXT & 0x7fffff) + 0x1c] === 0x5a;
    }
    expect(loaded).toBe(true);
    const got = describeRecord(contextRecord(game));
    expect(String(got.name).trim()).toBe('Epona');
    expect(got.hearts).toBe(9);
  }, 3_600_000);

  it('goes back to the file select after a reset by pressing Start at the title', async () => {
    const { game } = await inPlay(house('Link'));
    game.reset();
    expect(fileSelectReached(guestRam(game.ram()))).toBe(false);
    const start = new AutoStart(() => fileSelectReached(guestRam(game.ram())));
    let frames = 0;
    while (start.active) {
      game.setPad(start.buttons(), 0, 0);
      const r = await game.frame();
      expect(r.fatal).toBeUndefined();
      frames++;
    }
    expect(fileSelectReached(guestRam(game.ram()))).toBe(true);
    expect(frames).toBeLessThan(1000);
  }, 3_600_000);
});
