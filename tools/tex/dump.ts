// `npm run tex -- dump [--dist dist] [--out out/texdump]`: plays the scripted new game headless to Link's house under control, loads Kokiri Forest
// (entrance 238) and walks it, then enters the six interiors the forest's exit list names, and writes every unique decoded texture the display
// lists used to `<out>/<hash>.png` with `index.json` (facts per texture) and `report.json` (what churns). Pictures come from the cartridge: `out/`
// is git-ignored.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCartridge } from '../assets/write.ts';
import { encodePng } from '../gfx/png.ts';
import { bootGame } from '../headless/boot.ts';
import { padAt, parseInput, type InputScript } from '../headless/input.ts';
import { playState, requestEntrance } from '../headless/state.ts';
import { TextureCollector } from './collect.ts';

/** Frame of the scripted new game at which Link is under control in his house. */
const CONTROL_FRAME = 19000;
const FOREST_ENTRANCE = 238;
/** The entrances of the forest's exit list that lead to its six interiors (docs/re/display-lists.md section 9). */
const INTERIOR_ENTRANCES = [626, 193, 201, 156, 1075, 1079];
const FOREST_FRAMES = 3000;
const INTERIOR_FRAMES = 700;
/** Stick walk after the entrance's cutscene: each direction held for this many frames, cycling. */
const WALK_FROM = 400;
const WALK_LEG = 90;
const WALK: Array<[number, number]> = [[0, 80], [80, 0], [0, -80], [-80, 0], [60, 60], [-60, -60]];

export interface DumpOptions {
  dist: string;
  out: string;
  log?: (line: string) => void;
}

export async function dump({ dist, out, log = console.log }: DumpOptions): Promise<void> {
  const cartridge = readCartridge(join(resolve(dist), 'assets'));
  const tapA: InputScript = parseInput('tap A 100 4000 40 3', 'tap');
  const script = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');
  const collector = new TextureCollector();
  let recording = false;
  let tasks = 0;
  const game = await bootGame(pathToFileURL(resolve(dist, 'oot.js')).href, cartridge, {
    onGfxTask: (task) => {
      if (!recording) return;
      const scene = playState(game.rd32)?.scene ?? -1;
      collector.nextFrame(scene);
      collector.add(task.displayList());
      tasks++;
    },
  });
  const step = async (pad: { buttons: number; x: number; y: number }, label: string, frame: number): Promise<void> => {
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await game.frame();
    if (r.fatal || !r.alive) throw new Error(`${label}: the game stopped at frame ${frame}: ${r.fatal ?? 'nothing can run'}`);
  };
  for (let f = 1; f <= CONTROL_FRAME; f++) await step(padAt(script, f), 'new game', f);
  recording = true;

  const visit = async (entrance: number, frames: number): Promise<void> => {
    game.setPad(0, 0, 0);
    const ram = game.ram();
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    const play = playState(game.rd32);
    if (!play) throw new Error(`no play state to load entrance ${entrance} into`);
    requestEntrance(game.rd32, (addr, value) => view.setUint32(addr & 0x7fffff, value >>> 0), play, entrance);
    const before = collector.finish().records.length;
    for (let k = 1; k <= frames; k++) {
      const a = padAt(tapA, k);
      const leg = k >= WALK_FROM ? WALK[Math.floor((k - WALK_FROM) / WALK_LEG) % WALK.length]! : [0, 0];
      await step({ buttons: a.buttons, x: leg[0]!, y: leg[1]! }, `entrance ${entrance}`, k);
    }
    log(`entrance ${entrance}: scene ${playState(game.rd32)?.scene}, ${collector.finish().records.length - before} new textures`);
  };
  await visit(FOREST_ENTRANCE, FOREST_FRAMES);
  for (const entrance of INTERIOR_ENTRANCES) await visit(entrance, INTERIOR_FRAMES);

  const { records, pixels, churningGroups } = collector.finish();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const r of records) writeFileSync(join(out, `${r.hash}.png`), encodePng(r.width, r.height, pixels.get(r.hash)!));
  writeFileSync(join(out, 'index.json'), JSON.stringify({ tasks, textures: Object.fromEntries(records.map((r) => [r.hash, r])) }, null, 1));
  const volatile = records.filter((r) => r.volatile);
  writeFileSync(join(out, 'report.json'), JSON.stringify({ tasks, unique: records.length, volatile: volatile.length, churningGroups }, null, 1));
  log(`${tasks} graphics tasks, ${records.length} unique textures, ${volatile.length} change from frame to frame (kept original); written to ${out}`);
}
