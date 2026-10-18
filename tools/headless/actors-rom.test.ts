import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { Bridge } from '../../web/inspect/bridge.ts';
import { GO_TO_OFFSET, goToActor, isLink, readSnapshot } from '../../web/inspect/actors.ts';
import { ACTOR_FIELDS, CTX_ACTOR_TOTAL, readActors } from './actors.ts';
import { guestRam } from './load-save.ts';
import { bootGame } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { playState, requestEntrance } from './state.ts';
import { rom, SCRIPT, CONTROL_FRAME, buildGame } from './headless-support.ts';

/** Kokiri Forest, entered as in headless-forest.test.ts, with the actors that are alive 2,410 frames after the entrance is loaded. */
describe.skipIf(!rom || !existsSync(rom))('the live actors of Kokiri Forest', () => {
  const TAP_A = parseInput('tap A 100 4000 40 3', 'tap');
  const FOREST_ENTRANCE = 238;

  async function forest() {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge, {});
    for (let frame = 1; frame <= CONTROL_FRAME; frame++) {
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
    }
    game.setPad(0, 0, 0);
    const ram = game.ram();
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    requestEntrance(game.rd32, (addr, value) => view.setUint32(addr & 0x7fffff, value >>> 0), playState(game.rd32)!, FOREST_ENTRANCE);
    let k = 0;
    const run = async (frames: number) => {
      for (const end = k + frames; k < end; ) {
        k++;
        const pad = padAt(TAP_A, k);
        game.setPad(pad.buttons, pad.x, pad.y);
        expect((await game.frame()).fatal, `frame ${k}`).toBeUndefined();
      }
    };
    await run(2410);
    return { game, run };
  }

  it('walks the lists to the counts the context keeps, and the picture moves with the actors', async () => {
    const { game, run } = await forest();
    const play = playState(game.rd32)!;
    expect(play.scene).toBe(85);
    const lists = readActors(game.rd32, play);
    const total = lists.reduce((n, l) => n + l.actors.length, 0);
    expect(total).toBeGreaterThan(50);
    for (const list of lists) {
      expect(list.actors.length, `category ${list.category}`).toBe(list.declared);
      for (const [i, actor] of list.actors.entries()) {
        expect(actor.category).toBe(list.category);
        expect(game.rd32(actor.addr + ACTOR_FIELDS.prev) >>> 0).toBe(i === 0 ? 0 : list.actors[i - 1]!.addr);
      }
    }
    expect(game.rd32(play.context + CTX_ACTOR_TOTAL) >>> 24).toBe(total);

    const snapshot = readSnapshot(guestRam(game.ram()), undefined);
    expect(snapshot.count).toBe(total);

    const before = new Map(lists.flatMap((l) => l.actors).map((a) => [a.addr, a.position]));
    await run(30);
    const moved = readActors(game.rd32, playState(game.rd32)!).flatMap((l) => l.actors).filter((a) => {
      const was = before.get(a.addr);
      return was && (was.x !== a.position.x || was.y !== a.position.y || was.z !== a.position.z);
    });
    expect(moved.length).toBeGreaterThan(0);
  });

  it('puts Link next to the chosen actor, on ground the game accepts', async () => {
    const { game, run } = await forest();
    const bridge = new Bridge(() => game.ram());
    const everyone = () => readActors(game.rd32, playState(game.rd32)!).flatMap((l) => l.actors);
    const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
    const targets = everyone().filter((a) => !isLink(a)).filter((_, i) => i % 4 === 0);
    let near = 0;
    let far = 0;
    for (const t of targets) {
      const from = everyone().find(isLink)!.position;
      goToActor(bridge, t.addr);
      await run(8);
      const link = everyone().find(isLink)!.position;
      const held = flat(link, t.position) < GO_TO_OFFSET + 30;
      near += held ? 1 : 0;
      far += held && flat(from, t.position) > 300 ? 1 : 0;
    }
    expect(near).toBeGreaterThan(2);
    expect(far).toBeGreaterThan(0);
  });
});
