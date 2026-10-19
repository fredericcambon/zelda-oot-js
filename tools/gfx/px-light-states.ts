// `OOT_ROM=<rom> npx tsx tools/gfx/px-light-states.ts [--out out/px-light/saves]`: plays the new game to Link's house, loads an entrance and keeps
// a save state of the scene, for the page to load (key 5 to 8 / slots 1 to 4) when comparing lighting modes. Writes into a saves directory
// that `OOT_SAVES_DIR` points the dev server at; the states come from the ROM, so they stay under out/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compressState, STATE_VERSION } from '../runtime/snapshot.ts';
import { buildGames, loadBase } from '../recomp/test-base.ts';
import { bootGame } from '../headless/boot.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { playState, requestEntrance } from '../headless/state.ts';
import { CONTROL_FRAME, SCRIPT } from '../headless/headless-support.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'out/px-light/saves' } } });
// Slot, entrance, frames after loading it: the forest (entrance 238) and Link's house (626, the entrance the forest's exit list names for scene 52).
const SCENES: [number, number, number][] = [[1, 238, 2448], [2, 626, 300]];
const TAP_A = parseInput('tap A 100 4000 40 3', 'tap');

const rom = process.env.OOT_ROM;
if (!rom) throw new Error('set OOT_ROM');
await buildGames(rom, console.log);
mkdirSync(values.out!, { recursive: true });
for (const [slot, entrance, frames] of SCENES) {
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
  requestEntrance(game.rd32, (addr, value) => dv.setUint32(addr & 0x7fffff, value >>> 0), playState(game.rd32)!, entrance);
  for (let k = 1; k <= frames; k++) {
    const pad = padAt(TAP_A, k);
    game.setPad(pad.buttons, pad.x, pad.y);
    await game.frame();
  }
  console.log(`slot ${slot}: entrance ${entrance}, scene ${playState(game.rd32)?.scene}`);
  writeFileSync(join(values.out!, `state-${slot}.bin`), await compressState(game.saveState()));
  writeFileSync(join(values.out!, `state-${slot}.bin.format`), `${STATE_VERSION}\n${Date.now()}\n50`);
}
