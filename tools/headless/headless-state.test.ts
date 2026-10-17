import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootGame } from './boot.ts';
import { compressState, STATE_VERSION } from '../runtime/snapshot.ts';
import { RDRAM_SIZE } from '../runtime/instance.ts';
import { encodeThreads, parseThreads } from '../runtime/threads.ts';
import { playState } from './state.ts';
import { rom, HOUSE_SCENE, buildGame, buildVariant, sha, SAVE_FRAME, REPLAY_FRAMES, STATE_SIZE_LIMIT, reachSaveFrame, sections, withSection, startReplayable } from './headless-support.ts';

describe.skipIf(!rom || !existsSync(rom))('headless boot', () => {
  it('saves a portable state and loads it into a fresh game, which replays the same frames, pictures, sound, position and memory', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const start = () => startReplayable(moduleUrl, cartridge);

    const first = await start();
    await reachSaveFrame(first.game);
    expect(playState((a) => first.game.rd32(a))?.scene).toBe(HOUSE_SCENE);
    const state = first.game.saveState();
    const savedGames = first.game.readSave();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);
    // The walk moves Link and the pictures change, so the comparison below is not between constant frames.
    expect(new Set(expected.map((l) => l.split(' ')[1])).size).toBeGreaterThan(20);
    expect(new Set(expected.map((l) => l.split(' ')[3])).size).toBeGreaterThan(10);

    // The state holds RDRAM and a short list of variables, not the module's memory.
    expect(state.length).toBeLessThan(RDRAM_SIZE + 1_000_000);
    expect((await compressState(state)).length).toBeLessThanOrEqual(STATE_SIZE_LIMIT);

    // A game that has just booted (as a reloaded page has) takes the state.
    const second = await start();
    const blank = second.game.readSave();
    await second.game.loadState(state);
    // The save memory holds the player's saved games, which a state does not overwrite.
    expect(second.game.readSave()).toEqual(blank);
    second.game.writeSave(savedGames);
    expect(await second.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
    expect(sha(second.game.ram())).toBe(sha(first.game.ram()));
    // Everything the state holds is the same after the replay, so nothing the game depends on was left out of it.
    expect(sha(second.game.saveState())).toBe(sha(first.game.saveState()));

    // The same game goes back too.
    await first.game.loadState(state);
    const description = first.game.describeThreads();
    expect(await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);

    // The threads of the state, described in terms of the ROM's functions and call sites, are what the state holds.
    const parsed = parseThreads(description);
    expect(encodeThreads(parsed)).toEqual(description);
    const started = parsed.threads.filter((t) => t.started);
    expect(started.length).toBeGreaterThan(5);
    expect(started.every((t) => t.blockingSite !== 0 && t.frames.length > 0 && t.frames.at(-1)!.kind === 'site')).toBe(true);
    expect(parsed.running).toBe(0);
    expect(sections(state).get('THRD')).toEqual(description);
  }, 3_600_000);

  it('refuses a state it cannot read with a message, and the game keeps running', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const start = () => startReplayable(moduleUrl, cartridge);
    const first = await start();
    await reachSaveFrame(first.game);
    const state = first.game.saveState();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);

    const third = await start();
    third.game.writeSave(first.game.readSave());
    const other = state.slice();
    new DataView(other.buffer).setUint32(4, STATE_VERSION + 1, true);
    await expect(third.game.loadState(other)).rejects.toThrow(`this state uses format ${STATE_VERSION + 1}, this build reads ${STATE_VERSION}`);

    // A call site this build does not have.
    const description = parseThreads(sections(state).get('THRD')!);
    const frame = description.threads.find((t) => t.started)!.frames[0]!;
    if (frame.kind !== 'site') throw new Error('the outermost frame is a call site');
    frame.site += 2;
    await expect(third.game.loadState(withSection(state, 'THRD', encodeThreads(description)))).rejects.toThrow(/no call site/);

    const old = state.slice();
    old.set([0x4f, 0x4f, 0x54, 0x53]);
    await expect(third.game.loadState(old)).rejects.toThrow(/old format/);
    await expect(third.game.loadState(state.subarray(0, state.length - 1))).rejects.toThrow(/cut short/);
    await expect(third.game.loadState(new Uint8Array(100))).rejects.toThrow(/not a saved game state/);

    // The refusals left the game as it was: it takes the good state and replays the frames.
    await third.game.loadState(state);
    expect(await third.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
  }, 3_600_000);

  it('loads a state taken by one build into another build and replays the same frames, pictures, sound and memory', async () => {
    const a = await buildGame();
    const b = await buildVariant('-O1');
    const wasm = (url: string) => sha(readFileSync(fileURLToPath(url.replace(/\.js$/, '.wasm'))));
    expect(wasm(b.moduleUrl)).not.toBe(wasm(a.moduleUrl));

    const first = await startReplayable(a.moduleUrl, a.cartridge);
    await reachSaveFrame(first.game);
    const state = first.game.saveState();
    const savedGames = first.game.readSave();
    const expected = await first.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES);

    const second = await startReplayable(b.moduleUrl, b.cartridge);
    await second.game.loadState(state);
    second.game.writeSave(savedGames);
    expect(await second.play(SAVE_FRAME, SAVE_FRAME + REPLAY_FRAMES)).toEqual(expected);
    expect(sha(second.game.ram())).toBe(sha(first.game.ram()));
    expect(sha(second.game.saveState())).toBe(sha(first.game.saveState()));
  }, 3_600_000);

  it('refuses to save a state while the game boots', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    expect(() => game.describeThreads()).toThrow(/booting/);
    expect(() => game.saveState()).toThrow(/booting/);
    // The refusals leave the game running.
    expect((await game.frame()).fatal).toBeUndefined();
  }, 3_600_000);
});
