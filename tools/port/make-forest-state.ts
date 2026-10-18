// `npx tsx tools/port/make-forest-state.ts [--out out/state] [--dist dist] [--entrance-at 19000] [--frames 21400]`: runs the scripted new game
// headless at 60 Hz, loads Kokiri Forest's entrance (238) at --entrance-at, skips the cutscene that follows with A taps (as
// `npm run headless -- --entrance 238` does) and writes the game's state after --frames video frames as `state-1.bin` plus its
// `.format` file, in the layout of the page's saves folder. `measure-render.ts --state` loads it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { bootGame } from '../headless/boot.ts';
import { playState, requestEntrance } from '../headless/state.ts';
import { STATE_VERSION } from '../runtime/snapshot.ts';
import { compress } from '../../web/savestate.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out/state' },
    dist: { type: 'string', default: 'dist' },
    'entrance-at': { type: 'string', default: '19000' },
    frames: { type: 'string', default: '21400' },
  },
});
const FOREST_ENTRANCE = 238;
const entranceAt = Number(values['entrance-at']);
const frames = Number(values.frames);

const rom = readCartridge(join(resolve(values.dist!), 'assets'));
const script = parseInput(readFileSync('tools/headless/newgame.input', 'utf8'), 'newgame.input');
const afterEntrance = parseInput('tap A 100 4000 40 3', 'tap');
const game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, rom, { hz: 60 });
for (let frame = 1; frame <= frames; frame++) {
  if (frame === entranceAt + 1) {
    game.setPad(0, 0, 0);
    const ram = game.ram();
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    const play = playState(game.rd32);
    if (!play) throw new Error(`no play state at frame ${entranceAt} to load entrance ${FOREST_ENTRANCE} into`);
    requestEntrance(game.rd32, (addr, value) => view.setUint32(addr & 0x7fffff, value >>> 0), play, FOREST_ENTRANCE);
  }
  const pad = frame > entranceAt ? padAt(afterEntrance, frame - entranceAt) : padAt(script, frame);
  game.setPad(pad.buttons, pad.x, pad.y);
  const r = await game.frame();
  if (r.fatal || !r.alive) throw new Error(`the game stopped at frame ${frame}`);
}
const play = playState(game.rd32);
console.log(`play state: ${play ? `scene ${play.scene}` : 'none'}`);
const data = await compress(game.saveState());
mkdirSync(values.out!, { recursive: true });
writeFileSync(join(values.out!, 'state-1.bin'), data);
writeFileSync(join(values.out!, 'state-1.bin.format'), `${STATE_VERSION}\n${Date.now()}\n60`);
console.log(`wrote ${join(values.out!, 'state-1.bin')} (${data.length} bytes, state format ${STATE_VERSION}) at video frame ${frames}`);
