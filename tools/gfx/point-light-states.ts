// `OOT_ROM=<rom> npx tsx tools/gfx/point-light-states.ts [--out out/point-lights/saves]`: plays the new game to Link's house, loads an entrance and keeps
// a save state of the scene, for the page to load (key 5 to 8 / slots 1 to 4) when comparing point lights on and off. Writes into a saves directory
// that `OOT_SAVES_DIR` points the dev server at; the states come from the ROM, so they stay under out/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compressState, STATE_VERSION } from '../runtime/snapshot.ts';
import { buildGames, loadBase } from '../recomp/test-base.ts';
import { bootGame } from '../headless/boot.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { gameLights } from '../../web/point-lights.ts';
import { readActors } from '../headless/actors.ts';
import { ACTOR_POSITION, linkPosition, playState, requestEntrance, TIME_OF_DAY } from '../headless/state.ts';
import { CONTROL_FRAME, SCRIPT } from '../headless/headless-support.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'out/point-lights/saves' } } });
interface Capture {
  slot: number;
  entrance: number;
  /** Frames after loading it; the last `walk` of them Link holds the stick up. */
  frames: number;
  walk: number;
  /** The time of day is set to night before the entrance is loaded. */
  night?: boolean;
  /** Link is put beside the first of the game's lights, 70 units away in x and z and 70 below it. */
  near?: boolean;
  /** Further controller lines after the walk. */
  then?: string;
}
// Slot 1: the Fire Temple's first room (entrance 357), walking to the torches. Slot 2: scene 63 (entrance 796), two torches in a corridor. Slot 3: the Treasure Box Shop
// (scene 16, entrance 99), lamps inside. Slot 4: scene 90 (entrance 976) at night, walking and turning to its one torch.
const CAPTURES: Capture[] = [
  { slot: 1, entrance: 357, frames: 760, walk: 460 },
  { slot: 2, entrance: 796, frames: 340, walk: 40 },
  { slot: 3, entrance: 99, frames: 300, walk: 0, near: true },
  { slot: 4, entrance: 976, frames: 560, walk: 0, night: true, then: '301 NONE 0 70\n471 NONE -70 30\n521 NONE' },
];
const word = (n: number) => {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, n);
  return v.getUint32(0);
};

const rom = process.env.OOT_ROM;
if (!rom) throw new Error('set OOT_ROM');
await buildGames(rom, console.log);
mkdirSync(values.out!, { recursive: true });
for (const { slot, entrance, frames, walk, night, near, then } of CAPTURES) {
  if (process.env.SLOTS && !process.env.SLOTS.split(',').includes(String(slot))) continue;
  const script = parseInput(`tap A 100 4000 40 3${walk > 0 ? `
${frames - walk + 1} NONE 0 70
${frames + 1} NONE` : ''}${then ? `
${then}` : ''}`, 'walk');
  const base = loadBase();
  const game = await bootGame(base.moduleUrl, base.cartridge());
  for (let frame = 1; frame <= CONTROL_FRAME; frame++) {
    const pad = padAt(SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    await game.frame();
  }
  game.setPad(0, 0, 0);
  const ram = game.ram();
  const dv = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  if (night) dv.setUint32(TIME_OF_DAY & 0x7fffff, dv.getUint32(TIME_OF_DAY & 0x7fffff) & 0xffff);
  requestEntrance(game.rd32, (addr, value) => dv.setUint32(addr & 0x7fffff, value >>> 0), playState(game.rd32)!, entrance);
  for (let k = 1; k <= frames; k++) {
    const pad = padAt(script, k);
    game.setPad(pad.buttons, pad.x, pad.y);
    await game.frame();
  }
  if (near) {
    const light = gameLights(game.rd32)[0];
    const link = readActors(game.rd32, playState(game.rd32)!).flatMap((l) => l.actors).find((a) => a.id === 0 && a.category === 2);
    if (!light || !link) throw new Error(`slot ${slot}: no light or no Link`);
    for (const at of [ACTOR_POSITION, 0x38]) {
      dv.setUint32((link.addr + at) & 0x7fffff, word(light.x + 70));
      dv.setUint32((link.addr + at + 4) & 0x7fffff, word(light.y - 70));
      dv.setUint32((link.addr + at + 8) & 0x7fffff, word(light.z + 70));
    }
    for (let k = 0; k < 60; k++) {
      game.setPad(0, 0, 0);
      await game.frame();
    }
  }
  console.log(`slot ${slot}: entrance ${entrance}, scene ${playState(game.rd32)?.scene}, Link at ${JSON.stringify(linkPosition(game.rd32, playState(game.rd32)!))}, lights ${JSON.stringify(gameLights(game.rd32))}`);
  writeFileSync(join(values.out!, `state-${slot}.bin`), await compressState(game.saveState()));
  writeFileSync(join(values.out!, `state-${slot}.bin.format`), `${STATE_VERSION}
${Date.now()}
50`);
}
