// Captures what each distinct actor id looks like, for naming it by observation (docs/re/actors.md, "Names").
//   tsx tools/actors/crops.ts [--dist dist] [--out out/actors] [--scenes 911,897,...]
// For each title-card file given, the game is started and a scene with that card is entered. For every distinct (id, category)
// pair, from one saved game state, the picture is taken with the actor drawn, with its draw pointer null and with it drawn
// again; what differs between the first two and not between the first and third is the actor. Numbered contact sheets (the
// picture, and beside it the actor's own pixels) and a manifest that maps the tile numbers to ids go to `<out>/scene-<n>/`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame } from '../headless/boot.ts';
import { readActors, type Actor } from '../headless/actors.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { ACTOR_POSITION, ENTRANCE_COUNT, ENTRANCE_TABLE, playState, requestEntrance } from '../headless/state.ts';
import { readTitleCards } from '../../web/inspect/title-cards.ts';

const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: 'dist' },
    out: { type: 'string', default: 'out/actors' },
    // Card files: Kokiri Forest, Market, Kakariko Village, Hyrule Field, Inside the Deku Tree, Lon Lon Ranch (web/inspect/card-names.ts).
    scenes: { type: 'string', default: '911,897,908,907,886,922' },
    input: { type: 'string', default: 'tools/headless/newgame.input' },
    'start-frame': { type: 'string', default: '19000' },
  },
});

const CROP_W = 200;
const CROP_H = 150;
const SETTLE = 2410;
/** The pointer the draw loop at 0x8002514C calls through (`lw t2, 308(s0)` at 0x800251B0 skips an actor whose pointer is null; the call is `jalr` at 0x80024AF8). */
const DRAW_POINTER = 0x134;
/** Pictures the game builds and hands over before a change to the actors shows in the one taken (the picture lags the game by a few of them). */
const LAG = 4;
const TAP_A = parseInput('tap A 100 4000 40 3', 'tap');
/** Where, relative to Link on the ground plane, an actor is put to be seen when it is not drawn where it is (the first spot is no move); the camera's direction is not known, so several are tried. */
const BESIDE: [number, number][] = [[0, 0], [100, 0], [-100, 0], [0, 100], [0, -100]];
/** Rows below this one hold the text box a nearby actor can open; the screen rows above it are the scene. */
const SCENE_ROWS = 165;
/** Rows above this one hold the hearts and buttons, which change from picture to picture. */
const STATUS_ROWS = 48;

const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function stamp(img: Uint8Array, w: number, text: string): void {
  let x0 = 3;
  for (const ch of text) {
    DIGITS[ch]!.forEach((row, y) => [...row].forEach((bit, x) => {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const at = ((3 + y * 2 + dy) * w + x0 + x * 2 + dx) * 4;
        const on = bit === '1';
        img[at] = on ? 255 : 0;
        img[at + 1] = on ? 255 : 0;
        img[at + 2] = 0;
        img[at + 3] = 255;
      }
    }));
    x0 += 8;
  }
}

interface Shot {
  image: Uint8Array;
}

interface Box { cx: number; cy: number; x0: number; y0: number; x1: number; y1: number; n: number; mask: Uint8Array }


const differs = (a: Uint8Array, b: Uint8Array, i: number): boolean => Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 24;

/**
 * Where `shown` and `hidden`, pictures of the same game state with and without the actor drawn, differ, less where `again` (a second
 * picture with the actor drawn) differs from `shown` and the rows the status bar covers: what the actor adds and nothing else.
 */
function differ(shown: Uint8Array, hidden: Uint8Array, again: Uint8Array): Box | null {
  const noisy = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (!differs(shown, again, (y * WIDTH + x) * 4)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < HEIGHT && xx >= 0 && xx < WIDTH) noisy[yy * WIDTH + xx] = 1;
    }
  }
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = STATUS_ROWS; y < SCENE_ROWS; y++) for (let x = 0; x < WIDTH; x++) {
    if (!noisy[y * WIDTH + x] && differs(shown, hidden, (y * WIDTH + x) * 4)) { xs.push(x); ys.push(y); mask[y * WIDTH + x] = 1; }
  }
  if (xs.length < 60) return null;
  const sx = [...xs].sort((p, q) => p - q);
  const sy = [...ys].sort((p, q) => p - q);
  const at = (v: number[], f: number) => v[Math.min(v.length - 1, Math.floor(v.length * f))]!;
  return { cx: at(sx, 0.5), cy: at(sy, 0.5), x0: at(sx, 0.03), y0: at(sy, 0.03), x1: at(sx, 0.97), y1: at(sy, 0.97), n: xs.length, mask };
}

/** The part of the picture around (cx, cy), CROP_W / ZOOM wide, enlarged ZOOM times. */
/** Small actors are enlarged so that they can be told apart. */
const zoomOf = (box: Box): number => (box.x1 - box.x0 < 40 && box.y1 - box.y0 < 30 ? 2 : 1);

function zoom(img: Uint8Array, cx: number, cy: number, ZOOM: number): Uint8Array {
  const w = CROP_W / ZOOM;
  const h = CROP_H / ZOOM;
  const left = Math.min(Math.max(cx - (w >> 1), 0), WIDTH - w);
  const top = Math.min(Math.max(cy - (h >> 1), 0), HEIGHT - h);
  const out = new Uint8Array(CROP_W * CROP_H * 4);
  for (let y = 0; y < CROP_H; y++) for (let x = 0; x < CROP_W; x++) {
    const src = ((top + Math.floor(y / ZOOM)) * WIDTH + left + Math.floor(x / ZOOM)) * 4;
    out.set(img.subarray(src, src + 4), (y * CROP_W + x) * 4);
  }
  return out;
}

/** Draws a thin box around where the actor was found, in the crop that centres on it. */
function frame(tile: Uint8Array, box: Box, ZOOM: number): void {
  const left = (box.cx - box.x0) * ZOOM;
  const right = (box.x1 - box.cx) * ZOOM;
  const up = (box.cy - box.y0) * ZOOM;
  const down = (box.y1 - box.cy) * ZOOM;
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= CROP_W || y >= CROP_H) return;
    const at = (y * CROP_W + x) * 4;
    tile[at] = 255; tile[at + 1] = 0; tile[at + 2] = 255; tile[at + 3] = 255;
  };
  const mx = CROP_W >> 1, my = CROP_H >> 1;
  for (let x = mx - left; x <= mx + right; x += 2) { put(x, my - up - 2); put(x, my + down + 2); }
  for (let y = my - up; y <= my + down; y += 2) { put(mx - left - 2, y); put(mx + right + 2, y); }
}

/** The picture inside the box, enlarged to fill a panel, with the pixels the actor did not add darkened. */
function isolated(img: Uint8Array, box: Box): Uint8Array {
  const pad = 6;
  const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
  const w = Math.min(WIDTH, box.x1 + pad) - x0, h = Math.min(HEIGHT, box.y1 + pad) - y0;
  const scale = Math.max(1, Math.min(6, Math.floor(Math.min(CROP_W / w, CROP_H / h))));
  const out = new Uint8Array(CROP_W * CROP_H * 4);
  for (let y = 0; y < CROP_H; y++) for (let x = 0; x < CROP_W; x++) {
    const sx = x0 + Math.floor(x / scale), sy = y0 + Math.floor(y / scale);
    const at = (y * CROP_W + x) * 4;
    if (sx >= WIDTH || sy >= HEIGHT || sx - x0 >= w || sy - y0 >= h) { out[at + 3] = 255; continue; }
    const src = (sy * WIDTH + sx) * 4;
    const keep = box.mask[sy * WIDTH + sx] ? 1 : 0.25;
    out[at] = img[src]! * keep; out[at + 1] = img[src + 1]! * keep; out[at + 2] = img[src + 2]! * keep; out[at + 3] = 255;
  }
  return out;
}

/** Two panels side by side. */
function beside(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 * CROP_W * CROP_H * 4);
  for (let y = 0; y < CROP_H; y++) {
    out.set(left.subarray(y * CROP_W * 4, (y + 1) * CROP_W * 4), y * 2 * CROP_W * 4);
    out.set(right.subarray(y * CROP_W * 4, (y + 1) * CROP_W * 4), (y * 2 + 1) * CROP_W * 4);
  }
  return out;
}

function sheet(tiles: Uint8Array[], cols: number, tileW: number): { w: number; h: number; data: Uint8Array } {
  const rows = Math.ceil(tiles.length / cols);
  const w = cols * (tileW + 2);
  const h = rows * (CROP_H + 2);
  const data = new Uint8Array(w * h * 4).fill(40);
  tiles.forEach((t, i) => {
    const ox = (i % cols) * (tileW + 2);
    const oy = Math.floor(i / cols) * (CROP_H + 2);
    for (let y = 0; y < CROP_H; y++) data.set(t.subarray(y * tileW * 4, (y + 1) * tileW * 4), ((oy + y) * w + ox) * 4);
  });
  return { w, h, data };
}

async function main(): Promise<void> {
  const dist = resolve(values.dist!);
  const cartridge = readCartridge(join(dist, 'assets'));
  const cards = readTitleCards(cartridge);
  const script = parseInput(readFileSync(values.input!, 'utf8'), values.input!);
  const soft = new SoftRenderer();
  let drawing = false;
  let replaying = true;
  let latest: Shot | null = null;
  const game = await bootGame(pathToFileURL(join(dist, 'oot.js')).href, cartridge, {
    onGfxTask: (task) => {
      if (replaying || !drawing) return;
      const result = task.displayList();
      soft.drawTask(result);
      const last = result.batches[result.batches.length - 1];
      const image = last ? soft.image(last.state.colorImage.addr) : null;
      if (image) latest = { image: image.slice() };
    },
  });
  for (let frame = 1; frame <= Number(values['start-frame']); frame++) {
    const pad = padAt(script, frame);
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await game.frame();
    if (r.fatal) throw new Error(`trap at frame ${frame}: ${r.fatal}`);
  }
  game.setPad(0, 0, 0);
  replaying = false;

  const write32 = (addr: number, v: number) => {
    const ram = game.ram();
    new DataView(ram.buffer, ram.byteOffset, ram.byteLength).setUint32(addr & 0x7fffff, v >>> 0);
  };
  const word = (n: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, n); return d.getUint32(0); };
  /** Runs frames until the game hands over a full picture. */
  const shot = async (): Promise<Shot | null> => {
    latest = null;
    drawing = true;
    for (let k = 0; k < 8 && !latest; k++) {
      const r = await game.frame();
      if (r.fatal) throw new Error(`trap: ${r.fatal}`);
    }
    drawing = false;
    return latest;
  };
  const entrances = Array.from({ length: ENTRANCE_COUNT }, (_, i) => {
    const w = game.rd32(ENTRANCE_TABLE + i * 4);
    return { scene: w >> 24, spawn: (w << 8) >> 24 };
  });
    const manifest: unknown[] = [];
  const live = () => readActors(game.rd32, playState(game.rd32)!).flatMap((l) => l.actors);

  for (const fileIndex of values.scenes!.split(',').map(Number)) {
    const entrance = entrances.findIndex((e) => e.scene >= 0 && cards.file(e.scene) === fileIndex);
    if (entrance < 0) { console.log(`no entrance for card file ${fileIndex}`); continue; }
    requestEntrance(game.rd32, write32, playState(game.rd32)!, entrance);
    // Tapping A closes the conversations that start when a scene is entered (Kokiri Forest opens one at once).
    for (let k = 1; k <= SETTLE; k++) {
      const pad = padAt(TAP_A, k);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      if (r.fatal) throw new Error(`trap: ${r.fatal}`);
    }
    game.setPad(0, 0, 0);
    const play = playState(game.rd32)!;
    console.log(`file ${fileIndex}: entrance ${entrance}, scene ${play.scene}`);
    const dir = join(resolve(values.out!), `scene-${play.scene}`);
    mkdirSync(dir, { recursive: true });
    const byKey = new Map<number, Actor[]>();
    for (const a of live()) byKey.set(a.id * 16 + a.category, [...(byKey.get(a.id * 16 + a.category) ?? []), a]);
    const snapshot = game.saveState();
    const tiles: Uint8Array[] = [];
    const rows: Record<string, unknown>[] = [];
    const skipped: { id: number; category: number }[] = [];
    for (const group of byKey.values()) {
      const first = group[0]!;
      if (first.category === 2 && first.id === 0) continue;
      const now = live();
      const target = now.find((a) => a.addr === first.addr && a.id === first.id) ?? now.find((a) => a.id === first.id && a.category === first.category);
      if (!target) continue;
      const link = now.find((x) => x.category === 2 && x.id === 0);
      if (!link) continue;
      // The same game state is run three times for each spot, with the actor drawn, with it left out (draw pointer null) and with it drawn again; what differs
      // between the first two and not the first and third is the actor.
      let best: { box: Box; image: Uint8Array } | null = null;
      for (const [dx, dz] of BESIDE) {
        const results: (Shot | null)[] = [];
        for (const hide of [false, true, false]) {
          await game.loadState(snapshot);
          const spot = [link.position.x + dx, link.position.y, link.position.z + dz];
          if (dx || dz) spot.forEach((v, i) => write32(target.addr + ACTOR_POSITION + i * 4, word(v)));
          if (hide) write32(target.addr + DRAW_POINTER, 0);
          for (let k = 0; k < LAG; k++) await shot();
          results.push(await shot());
        }
        const [shown, hidden, again] = results;
        const box = shown && hidden && again && differ(shown.image, hidden.image, again.image);
        if (box && shown) { best = { box, image: shown.image }; break; }
      }
      if (!best) { skipped.push({ id: first.id, category: first.category }); continue; }
      const { box } = best;
      const tile = zoom(best.image, box.cx, box.cy, zoomOf(box));
      const n = tiles.length;
      const stamped = tile.slice();
      frame(stamped, box, zoomOf(box));
      stamp(stamped, CROP_W, String(n));
      tiles.push(beside(stamped, isolated(best.image, box)));
      rows.push({ tile: n, id: first.id, category: first.category, instances: group.length, addr: first.addr, position: target.position, screen: [box.cx, box.cy], pixels: box.n });
      writeFileSync(join(dir, `${first.id.toString(16).padStart(4, '0')}-c${first.category}.png`), encodePng(CROP_W, CROP_H, tile));
    }
    for (let s = 0; s * 8 < tiles.length; s++) {
      const sh = sheet(tiles.slice(s * 8, s * 8 + 8), 2, 2 * CROP_W);
      writeFileSync(join(dir, `sheet-${s}.png`), encodePng(sh.w, sh.h, sh.data));
    }
    manifest.push({ cardFile: fileIndex, scene: play.scene, entrance, tiles: rows, skipped });
    writeFileSync(join(resolve(values.out!), 'manifest.json'), JSON.stringify(manifest, null, 1));
    console.log(`scene ${play.scene}: ${rows.length} distinct (id, category) pairs`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
