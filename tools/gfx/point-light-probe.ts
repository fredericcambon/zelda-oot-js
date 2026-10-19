// `OOT_ROM=<rom> npx tsx tools/gfx/point-light-probe.ts <scene>[:<frames>] ... [--out out/point-lights/probe]`: plays the scripted new game to Link's house, then for each scene
// number loads the first entrance of the table that names it, runs the frames (default 300) and writes the actor ids found (with counts, and the positions of the ones
// that are not categories 2 or 6 in the first lines), and a picture of the frame with every actor's id written at its projected position, using the projection
// the interpreter reports for the vertices (runtime/gfx/gfx.h, camera output). One game at a time. Pictures come from the ROM, so they stay under out/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildGames, loadBase } from '../recomp/test-base.ts';
import { bootGame } from '../headless/boot.ts';
import { readActors } from '../headless/actors.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { ACTOR_POSITION, ENTRANCE_COUNT, ENTRANCE_TABLE, TIME_OF_DAY, playState, requestEntrance } from '../headless/state.ts';
import { CONTROL_FRAME, SCRIPT } from '../headless/headless-support.ts';
import { encodePng } from './png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from './raster.ts';
import type { CameraProjection } from './types.ts';
import { sharedGfxModule, sharedInterpreter } from './c-dl-node.ts';

const { values, positionals } = parseArgs({ options: { out: { type: 'string', default: 'out/point-lights/probe' } }, allowPositionals: true });
const TAP_A = parseInput('tap A 100 4000 40 3', 'tap');
const rom = process.env.OOT_ROM;
if (!rom) throw new Error('set OOT_ROM');
await buildGames(rom, console.log);
const gfx = await sharedGfxModule();
const interpreter = await sharedInterpreter();
gfx._gfx_set_camera_output!(1);
mkdirSync(values.out!, { recursive: true });

// A 3x5 digit font for the labels; the picture is drawn at SCALE times 320x240.
const SCALE = 3;
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111', '010101111101101', '110101110101110', '011100100100011', '110101101101110', '111100110100111', '111100110100100'];
function upscale(img: Uint8Array): Uint8Array {
  const out = new Uint8Array(WIDTH * HEIGHT * SCALE * SCALE * 4);
  for (let y = 0; y < HEIGHT * SCALE; y++) for (let x = 0; x < WIDTH * SCALE; x++) {
    const from = (Math.floor(y / SCALE) * WIDTH + Math.floor(x / SCALE)) * 4;
    out.set(img.subarray(from, from + 4), (y * WIDTH * SCALE + x) * 4);
  }
  return out;
}
function label(img: Uint8Array, x: number, y: number, text: string, rgb: [number, number, number]): void {
  const put = (px: number, py: number) => {
    if (px >= 0 && px < WIDTH * SCALE && py >= 0 && py < HEIGHT * SCALE) img.set([...rgb, 255], (py * WIDTH * SCALE + px) * 4);
  };
  for (const [i, ch] of [...text].entries()) {
    const glyph = DIGITS[parseInt(ch, 16)]!;
    for (let k = 0; k < 15; k++) {
      if (glyph[k] !== '1') continue;
      const px = x + (i * 4 + (k % 3)) * 2, py = y + Math.floor(k / 3) * 2;
      put(px, py);
      put(px + 1, py + 1);
    }
  }
}

function project(m: Float64Array, p: { x: number; y: number; z: number }): [number, number, number] | null {
  const c = [0, 1, 2, 3].map((j) => p.x * m[j]! + p.y * m[4 + j]! + p.z * m[8 + j]! + m[12 + j]!);
  const w = c[3]!;
  if (!(w > 0)) return null;
  return [(c[0]! / w * 0.5 + 0.5) * WIDTH, (0.5 - c[1]! / w * 0.5) * HEIGHT, w];
}

let soft = new SoftRenderer();
const seen: { camera?: CameraProjection } = {};
let drawing = false;
// Fire-like draws of the frame: batches whose primitive colour is orange or yellow over a red environment colour, counted at their screen centre.
const fire: { x: number; y: number }[] = [];
const isFire = (b: { state: { primColor: { r: number; g: number; b: number }; envColor: { r: number; g: number; b: number } } }): boolean => {
  const p = b.state.primColor, e = b.state.envColor;
  return p.r > 180 && p.g > 60 && p.b < 140 && e.r > 120 && e.b < 100;
};

async function fresh() {
  const base = loadBase();
  const game = await bootGame(base.moduleUrl, base.cartridge(), {
    onGfxTask: (task) => {
      if (!drawing) return;
      const result = interpreter.run(task.ram, task.data);
      soft.drawTask(result);
      const best = [...(result.cameras ?? [])].sort((a, b) => b.vertices - a.vertices)[0];
      if (best) seen.camera = best;
      for (const b of result.batches) {
        if (b.kind !== 'triangles' || !isFire(b) || !best) continue;
        let x = 0, y = 0, n = 0;
        for (let i = 0; i < b.positions.length; i += 4) {
          const w = b.positions[i + 3]!;
          if (!(w > 0)) continue;
          x += (b.positions[i]! / w * 0.5 + 0.5) * WIDTH;
          y += (0.5 - b.positions[i + 1]! / w * 0.5) * HEIGHT;
          n++;
        }
        if (n > 0) fire.push({ x: x / n, y: y / n });
      }
    },
  });
  for (let frame = 1; frame <= CONTROL_FRAME; frame++) {
    const pad = padAt(SCRIPT, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    await game.frame();
  }
  game.setPad(0, 0, 0);
  return game;
}

let game = await fresh();
if (process.env.ENTRANCES) {
  const bySceneNumber = new Map<number, number[]>();
  for (let e = 0; e < ENTRANCE_COUNT; e++) {
    const scene = game.rd32(ENTRANCE_TABLE + e * 4) >>> 24;
    bySceneNumber.set(scene, [...(bySceneNumber.get(scene) ?? []), e]);
  }
  for (const [scene, entries] of bySceneNumber) console.log(`entrances of scene ${scene}: ${entries.join(' ')}`);
  process.exit(0);
}
for (const arg of positionals) {
  // <scene>[@<entrance>][:<frames>][n]: the entrance table entry to load (default the first naming the scene); a trailing n sets the time of day to night first.
  const [sceneText, framesText] = arg.split(':');
  const night = /n$/.test(arg);
  const [sceneOnly, entranceText] = sceneText!.split('@');
  const scene = Number(sceneOnly), frames = Number((framesText ?? '300').replace(/n$/, ''));
  soft = new SoftRenderer();
  seen.camera = undefined;
  fire.length = 0;
  if (!playState(game.rd32)) game = await fresh();
  let entry = entranceText === undefined ? -1 : Number(entranceText);
  for (let e = 0; e < ENTRANCE_COUNT && entry < 0; e++) if (game.rd32(ENTRANCE_TABLE + e * 4) >>> 24 === scene) entry = e;
  if (entry < 0) throw new Error(`no entrance names scene ${scene}`);
  const ram = game.ram();
  const dv = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  if (night) dv.setUint32(TIME_OF_DAY & 0x7fffff, (dv.getUint32(TIME_OF_DAY & 0x7fffff) & 0xffff) >>> 0);
  requestEntrance(game.rd32, (addr, value) => dv.setUint32(addr & 0x7fffff, value >>> 0), playState(game.rd32)!, entry);
  for (let k = 1; k <= frames; k++) {
    drawing = k > frames - 12;
    const pad = padAt(TAP_A, k);
    game.setPad(pad.buttons, pad.x, pad.y);
    await game.frame();
  }
  // GOTO=<id>:<n>: then put Link at the n-th actor of that id (hex), as the Actors tab's "Go to" does, and run GOFRAMES more frames.
  if (process.env.GOTO) {
    const [idText, nText] = process.env.GOTO.split(':');
    const now = playState(game.rd32)!;
    const target = readActors(game.rd32, now).flatMap((l) => l.actors).filter((x) => x.id === parseInt(idText!, 16))[Number(nText ?? 0)];
    if (target) {
      const word = (n: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, n); return v.getUint32(0); };
      const link = readActors(game.rd32, now).flatMap((l) => l.actors).find((x) => x.id === 0 && x.category === 2)!;
      for (const base of [ACTOR_POSITION, 0x38]) {
        dv.setUint32((link.addr + base) & 0x7fffff, word(target.position.x + 50));
        dv.setUint32((link.addr + base + 4) & 0x7fffff, word(target.position.y));
        dv.setUint32((link.addr + base + 8) & 0x7fffff, word(target.position.z));
      }
    } else console.log('  GOTO: no such actor');
    seen.camera = undefined;
    fire.length = 0;
    const more = Number(process.env.GOFRAMES ?? 200);
    for (let k = 1; k <= more; k++) {
      drawing = k > more - 12;
      game.setPad(0, 0, 0);
      await game.frame();
    }
  }
  const play = playState(game.rd32);
  console.log(`scene ${scene} entrance ${entry}: play scene ${play?.scene}`);
  if (!play) continue;
  const lists = readActors(game.rd32, play);
  const counts = new Map<number, number>();
  for (const l of lists) for (const a of l.actors) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
  console.log(`  ids: ${[...counts].map(([id, n]) => `${id.toString(16)}x${n}`).join(' ')}`);
  if (process.env.LIST) for (const l of lists) for (const a of l.actors) console.log(`  cat ${l.category} id ${a.id.toString(16)} addr ${a.addr.toString(16)} room ${a.room} pos ${a.position.x.toFixed(0)},${a.position.y.toFixed(0)},${a.position.z.toFixed(0)} rot ${a.rotation.join(',')}`);
  const img = soft.image(game.framebuffer());
  if (!img) { console.log('  no picture'); continue; }
  const out = upscale(img);
  const cam = seen.camera as CameraProjection | undefined;
  if (cam && fire.length > 0) {
    const near = new Map<number, number>();
    for (const f of fire) {
      let best: { id: number; d: number } | undefined;
      for (const l of lists) for (const a of l.actors) {
        const s = project(cam.matrix, a.position);
        if (!s) continue;
        const d = Math.hypot(s[0] - f.x, s[1] - f.y);
        if (!best || d < best.d) best = { id: a.id, d };
      }
      if (best && best.d < 40) near.set(best.id, (near.get(best.id) ?? 0) + 1);
    }
    console.log(`  fire-coloured batches: ${fire.length}; nearest actor ids (within 40 px): ${[...near].map(([id, n]) => `${id.toString(16)}x${n}`).join(' ')}`);
  }
  // FINDPTR=<addr>[,<addr>...]: every word of guest memory equal to the address, with the three words that follow it, to follow pointers back to their owners.
  if (process.env.FINDPTR) {
    const mem = game.ram();
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    for (const target of process.env.FINDPTR.split(',').map((t) => parseInt(t, 16) >>> 0)) {
      for (let at = 0; at + 16 <= 0x800000; at += 4) {
        if (view.getUint32(at) !== target) continue;
        console.log(`  ptr ${target.toString(16)} found at ${(0x80000000 + at).toString(16)}: ${[-2, -1, 0, 1, 2, 3].map((k) => (view.getUint32(at + 4 * k) >>> 0).toString(16).padStart(8, '0')).join(' ')}`);
      }
    }
  }
  // DUMPMEM=<addr>:<words>: words of guest memory, eight to a line.
  if (process.env.DUMPMEM) {
    const [at, n] = process.env.DUMPMEM.split(':');
    for (let i = 0; i < Number(n); i += 8) console.log(`  mem ${(parseInt(at!, 16) + i * 4).toString(16)}: ${Array.from({ length: 8 }, (_, k) => (game.rd32(parseInt(at!, 16) + (i + k) * 4) >>> 0).toString(16).padStart(8, '0')).join(' ')}`);
  }
  // LIGHTS=1: the used nodes of the pool at 0x80119B68 (32 nodes of {info, next, prev}) and the first twelve bytes of each info.
  if (process.env.LIGHTS) {
    for (let i = 0; i < 32; i++) {
      const node = 0x80119b68 + i * 12, info = game.rd32(node) >>> 0;
      if (info === 0) continue;
      const bytes = Array.from({ length: 3 }, (_, k) => (game.rd32(info + 4 * k) >>> 0).toString(16).padStart(8, '0')).join(' ');
      const owner = lists.flatMap((l) => l.actors).filter((x) => x.addr <= info && info < x.addr + 0x400).sort((x, y) => y.addr - x.addr)[0];
      console.log(`  light node ${node.toString(16)} info ${info.toString(16)}: ${bytes} owner ${owner ? `id ${owner.id.toString(16)} cat ${owner.category} at ${owner.addr.toString(16)}, info at +${(info - owner.addr).toString(16)}` : 'none'}`);
    }
  }
  if (process.env.DUMP && cam) {
    // DUMP=<id>: for each record with that id, the fire-coloured batches within 30 px of its projected position and the words of the record after the common fields.
    for (const l of lists) for (const a of l.actors) {
      if (a.id !== parseInt(process.env.DUMP, 16)) continue;
      const p = project(cam.matrix, a.position);
      const near = p ? fire.filter((f) => Math.hypot(f.x - p[0], f.y - p[1]) < 30).length : -1;
      const words = Array.from({ length: 56 }, (_, i) => (game.rd32(a.addr + 0x128 + i * 4) >>> 0).toString(16).padStart(8, '0'));
      console.log(`  dump ${a.addr.toString(16)} pos ${a.position.x.toFixed(0)},${a.position.y.toFixed(0)},${a.position.z.toFixed(0)} fire-near ${near} params ${(game.rd32(a.addr + 0x1c) >>> 0).toString(16)}: ${words.join(' ')}`);
    }
  }
  if (cam) {
    for (const l of lists) for (const a of l.actors) {
      const s = project(cam.matrix, a.position);
      if (!s) continue;
      const [x, y] = s;
      if (x < 4 || x >= WIDTH - 4 || y < 4 || y >= HEIGHT - 4) continue;
      label(out, Math.round(x * SCALE) + 4, Math.round(y * SCALE) - 4, a.id.toString(16), [0, 255, 255]);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) out.set([255, 0, 255, 255], ((Math.round(y * SCALE) + dy) * WIDTH * SCALE + Math.round(x * SCALE) + dx) * 4);
    }
  } else console.log('  no camera projection reported');
  writeFileSync(join(values.out!, `scene-${scene}${process.env.GOTO ? `-go${process.env.GOTO.replace(':', '-')}` : ''}.png`), encodePng(WIDTH * SCALE, HEIGHT * SCALE, out));
  writeFileSync(join(values.out!, `scene-${scene}${process.env.GOTO ? `-go${process.env.GOTO.replace(':', '-')}` : ''}-plain.png`), encodePng(WIDTH, HEIGHT, img));
}
