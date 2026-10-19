// `npx tsx tools/gfx/lighting-probe.ts [--dist dist] [--entrances 0,1,..|--per-scene] [--frames 240] [--tasks 20] [--out out/lighting]`:
// walks the display lists of a built game over a sample of scenes and measures what the lighting uses (docs/re/lighting.md): the
// share of triangles drawn from lit and from unlit vertices, the normals of the lit vertices, the lights and the combiner inputs.
//
// The walker reads the lists straight from guest memory and keeps only the state it needs (segments, geometry mode, lights, model-view
// stack, combiner, cycle type). It follows calls and branches, executes no culling (CULLDL, BRANCH_Z), and so draws a little more than
// the interpreter in runtime/gfx/dl.c; the per-task VTX count is compared with the interpreter's own to show by how much.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { bootGame, type Game } from '../headless/boot.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { ENTRANCE_COUNT, ENTRANCE_TABLE, playState, requestEntrance, SCENE_RECORD_SIZE, SCENE_TABLE } from '../headless/state.ts';
import { decodeCombine } from './types.ts';

const GEO_LIGHTING = 0x20000, GEO_TEXGEN = 0x40000, GEO_FOG = 0x10000;

export interface Tally {
  tasks: number;
  vtxCommands: number;
  interpreterVtxCommands: number;
  vertexLoads: number;
  litVertexLoads: number;
  vertices: number;
  litVertices: number;
  triangles: number;
  litTriangles: number;
  litTrianglesTexgen: number;
  litTrianglesFog: number;
  /** Triangles by lit/unlit and by whether the combiner reads the shade colour (rgb) or shade alpha. */
  byClass: Record<string, number>;
  /** Unlit triangles whose three vertex colours differ (a baked gradient), and those whose are all equal. */
  unlitVarying: number;
  unlitFlat: number;
  /** Lit vertices by |n| / 127. */
  lengthBins: Record<string, number>;
  zeroNormals: number;
  /** Lit triangles by cosine between the geometric normal (model space) and the sum of the vertex normals. */
  faceCos: Record<string, number>;
  faceCosSum: number;
  faceCosCount: number;
  /** Lit triangles by the scale (length of the first row of the 3x3 part) of the model-view matrix, decade bins. */
  scaleBins: Record<string, number>;
  litBySegment: Record<string, number>;
  unlitBySegment: Record<string, number>;
  lightSets: Record<string, number>;
  lightBytes: Record<string, Record<string, number>>;
  numLights: Record<string, number>;
  lightSources: Record<string, number>;
  /** Geometry mode at each vertex load, and the lit vertices' |n| in bytes. */
  geometryModes: Record<string, number>;
  lengthBytes: Record<string, number>;
}

export const newTally = (): Tally => ({
  tasks: 0, vtxCommands: 0, interpreterVtxCommands: 0, vertexLoads: 0, litVertexLoads: 0, vertices: 0, litVertices: 0, triangles: 0, litTriangles: 0,
  litTrianglesTexgen: 0, litTrianglesFog: 0, byClass: {}, unlitVarying: 0, unlitFlat: 0, lengthBins: {}, zeroNormals: 0, faceCos: {}, faceCosSum: 0,
  faceCosCount: 0, scaleBins: {}, litBySegment: {}, unlitBySegment: {}, lightSets: {}, lightBytes: {}, numLights: {}, lightSources: {}, geometryModes: {}, lengthBytes: {},
});

const bump = (r: Record<string, number>, k: string, by = 1): void => void (r[k] = (r[k] ?? 0) + by);
const hex = (n: number, width = 2): string => (n & ((1 << (width * 4)) - 1)).toString(16).padStart(width, '0');

interface Vertex {
  lit: boolean;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  r: number; g: number; b: number;
  loadSegment: string;
}

/** Walks one graphics task's display list. */
export class Walker {
  private seg = new Array<number>(16).fill(0);
  private geo = 0;
  private numLights = 0;
  private lights: number[][] = Array.from({ length: 10 }, () => new Array<number>(16).fill(0));
  private lightSource: number[] = new Array(10).fill(0);
  private verts: (Vertex | undefined)[] = new Array(32).fill(undefined);
  private mv: number[] = identity();
  private stack: number[][] = [];
  private combineShade = false;
  private combineShadeAlpha = false;
  private otherH = 0;
  private commands = 0;
  /** The last commands executed (address, both words), for captures. */
  readonly ring: string[] = [];
  /** Set to the ring and the vertices at the first lit vertex load when `captureLit` is on. */
  captureLit = false;
  capture: { commands: string[]; vertices: string[] } | undefined;
  private readonly view: DataView;

  constructor(private readonly ram: Uint8Array, private readonly tally: Tally) {
    this.view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
  }

  private phys(a: number): number {
    return (this.seg[(a >>> 24) & 15]! + (a & 0xffffff)) & 0x7fffff;
  }

  run(start: number, depth = 0): boolean {
    let at = this.phys(start);
    for (;;) {
      if (++this.commands > 2_000_000) return false;
      const w0 = this.view.getUint32(at), w1 = this.view.getUint32(at + 4);
      const op = w0 >>> 24;
      if (this.captureLit) {
        this.ring.push(`0x${(at + 0x80000000).toString(16)}: ${w0.toString(16).padStart(8, '0')} ${w1.toString(16).padStart(8, '0')}`);
        if (this.ring.length > 40) this.ring.shift();
      }
      at += 8;
      switch (op) {
        case 0xde: // DL
          if (depth < 16) this.run(w1, depth + 1);
          if ((w0 >>> 16) & 1) return true;
          break;
        case 0xdf:
          return true;
        case 0x01: this.vtx(w0, w1); break;
        case 0x05: this.tri((w0 >>> 16) & 255, (w0 >>> 8) & 255, w0 & 255); break;
        case 0x06:
        case 0x07:
          this.tri((w0 >>> 16) & 255, (w0 >>> 8) & 255, w0 & 255);
          this.tri((w1 >>> 16) & 255, (w1 >>> 8) & 255, w1 & 255);
          break;
        case 0xd9: this.geo = ((this.geo & w0 & 0xffffff) | w1) >>> 0; break;
        case 0xdb: {
          const index = (w0 >>> 16) & 255;
          if (index === 6) this.seg[((w0 & 0xffff) >>> 2) & 15] = w1 & 0xffffff;
          else if (index === 2) this.numLights = Math.min(7, Math.floor(w1 / 24));
          break;
        }
        case 0xdc: {
          if ((w0 & 255) !== 0x0a) break;
          const offset = ((w0 >>> 8) & 255) * 8;
          const slot = offset / 24;
          if (offset % 24 !== 0 || slot >= 10) break;
          const p = this.phys(w1);
          for (let i = 0; i < 16; i++) this.lights[slot]![i] = this.ram[p + i]!;
          this.lightSource[slot] = w1;
          break;
        }
        case 0xda: this.matrix(w0, w1); break;
        case 0xd8: for (let n = Math.floor(w1 / 64); n > 0 && this.stack.length > 0; n--) this.mv = this.stack.pop()!; break;
        case 0xfc:
          this.combineRaw = [w0 & 0xffffff, w1];
          this.recombine();
          break;
        case 0xe3: {
          const len = (w0 & 255) + 1, shift = 32 - ((w0 >>> 8) & 255) - len;
          const mask = len === 32 ? 0xffffffff : (((1 << len) - 1) << shift) >>> 0;
          this.otherH = (((this.otherH & ~mask) | (w1 & mask)) >>> 0);
          this.recombine();
          break;
        }
        default: break;
      }
    }
  }

  private combineRaw: [number, number] | undefined;

  private recombine(): void {
    if (!this.combineRaw) return;
    const [w0, w1] = this.combineRaw;
    const c = decodeCombine(w0, w1);
    const cycles = ((this.otherH >>> 20) & 3) === 1 ? 2 : 1;
    this.combineShade = false;
    this.combineShadeAlpha = false;
    for (let k = 0; k < cycles; k++) {
      const s = c.cycles[k]!;
      if (s.rgb[0] === 4 || s.rgb[1] === 4 || s.rgb[2] === 4 || s.rgb[3] === 4) this.combineShade = true;
      if (s.rgb[2] === 11 || s.alpha.some((v) => v === 4)) this.combineShadeAlpha = true;
    }
  }

  private matrix(w0: number, w1: number): void {
    const params = (w0 & 255) ^ 1;
    if (params & 4) return;
    const p = this.phys(w1);
    const m = new Array<number>(16);
    for (let i = 0; i < 16; i++) m[i] = this.view.getInt16(p + i * 2) + this.view.getUint16(p + 32 + i * 2) / 65536;
    if (params & 1) this.stack.push(this.mv.slice());
    this.mv = params & 2 ? m : multiply(m, this.mv);
  }

  private vtx(w0: number, w1: number): void {
    const t = this.tally;
    const n = (w0 >>> 12) & 255;
    const v0 = ((w0 >>> 1) & 127) - n;
    t.vtxCommands++;
    if (v0 < 0 || v0 + n > 32) return;
    const lit = (this.geo & GEO_LIGHTING) !== 0;
    bump(t.geometryModes, `${lit ? 'lit' : 'unlit'} 0x${this.geo.toString(16)}`);
    if (lit && this.captureLit && !this.capture) {
      this.capture = {
        commands: this.ring.slice(),
        vertices: Array.from({ length: Math.min(n, 6) }, (_, i) => Array.from(this.ram.subarray(this.phys(w1) + i * 16, this.phys(w1) + i * 16 + 16), (b) => hex(b)).join(' ')),
      };
    }
    const segment = (w1 >>> 24) < 16 ? `seg${w1 >>> 24}` : 'absolute';
    const p = this.phys(w1);
    t.vertexLoads++;
    t.vertices += n;
    if (lit) {
      t.litVertexLoads++;
      t.litVertices += n;
      this.recordLights();
    }
    for (let i = 0; i < n; i++) {
      const a = p + i * 16;
      const v: Vertex = {
        lit, x: this.view.getInt16(a), y: this.view.getInt16(a + 2), z: this.view.getInt16(a + 4),
        nx: this.view.getInt8(a + 12), ny: this.view.getInt8(a + 13), nz: this.view.getInt8(a + 14),
        r: this.ram[a + 12]!, g: this.ram[a + 13]!, b: this.ram[a + 14]!, loadSegment: segment,
      };
      this.verts[v0 + i] = v;
      if (lit) {
        const len = Math.hypot(v.nx, v.ny, v.nz) / 127;
        if (len === 0) t.zeroNormals++;
        bump(t.lengthBytes, String(Math.round(len * 127)));
        const bins = [0.1, 0.9, 0.95, 1.05, 1.1];
        const names = ['<0.1', '0.1-0.9', '0.9-0.95', '0.95-1.05', '1.05-1.1', '>1.1'];
        bump(t.lengthBins, names[bins.findIndex((b) => len < b) === -1 ? 5 : bins.findIndex((b) => len < b)]!);
      }
    }
  }

  private recordLights(): void {
    const t = this.tally;
    bump(t.numLights, String(this.numLights));
    const parts: string[] = [];
    for (let i = 0; i < this.numLights; i++) {
      const l = this.lights[2 + i]!;
      parts.push(`L${i} col=${hex(l[0]!)}${hex(l[1]!)}${hex(l[2]!)} dir=(${i8(l[8]!)},${i8(l[9]!)},${i8(l[10]!)})`);
      for (const [name, idx] of [['b3', 3], ['b4-6', 4], ['b7', 7], ['b11', 11], ['b12-15', 12]] as const) {
        const val = idx === 4 ? `${hex(l[4]!)}${hex(l[5]!)}${hex(l[6]!)}${l[4] === l[0] && l[5] === l[1] && l[6] === l[2] ? '(=col)' : ''}` : idx === 12 ? [l[12], l[13], l[14], l[15]].map((x) => hex(x!)).join('') : hex(l[idx]!);
        bump((t.lightBytes[name] ??= {}), val);
      }
      bump(t.lightSources, this.lightSource[2 + i]! >>> 24 === 0x80 ? `0x${(this.lightSource[2 + i]! >>> 0).toString(16)}`.slice(0, 7) + 'xxxx' : `seg${this.lightSource[2 + i]! >>> 24}`);
    }
    const amb = this.lights[2 + this.numLights]!;
    parts.push(`amb=${hex(amb[0]!)}${hex(amb[1]!)}${hex(amb[2]!)}`);
    bump(t.lightSets, parts.join(' '));
  }

  private tri(b0: number, b1: number, b2: number): void {
    const t = this.tally;
    const vs = [this.verts[b0 >> 1], this.verts[b1 >> 1], this.verts[b2 >> 1]];
    if (vs.some((v) => !v)) return;
    const [a, b, c] = vs as [Vertex, Vertex, Vertex];
    t.triangles++;
    const lit = a.lit && b.lit && c.lit;
    const cls = `${lit ? 'lit' : 'unlit'}+${this.combineShade ? 'shade-rgb' : 'no-shade-rgb'}${this.combineShadeAlpha ? '+shade-a' : ''}`;
    bump(t.byClass, cls);
    if (!lit) {
      bump(t.unlitBySegment, a.loadSegment);
      const same = (u: Vertex, v: Vertex) => u.r === v.r && u.g === v.g && u.b === v.b;
      if (same(a, b) && same(b, c)) t.unlitFlat++;
      else t.unlitVarying++;
      return;
    }
    t.litTriangles++;
    bump(t.litBySegment, a.loadSegment);
    if (this.geo & GEO_TEXGEN) t.litTrianglesTexgen++;
    if (this.geo & GEO_FOG) t.litTrianglesFog++;
    const scale = Math.hypot(this.mv[0]!, this.mv[1]!, this.mv[2]!);
    const decade = scale <= 0 ? 'zero' : `1e${Math.floor(Math.log10(scale))}`;
    bump(t.scaleBins, decade);
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    const sx = a.nx + b.nx + c.nx, sy = a.ny + b.ny + c.ny, sz = a.nz + b.nz + c.nz;
    const fl = Math.hypot(fx, fy, fz), sl = Math.hypot(sx, sy, sz);
    if (fl > 0 && sl > 0) {
      const cos = (fx * sx + fy * sy + fz * sz) / (fl * sl);
      t.faceCosSum += cos;
      t.faceCosCount++;
      bump(t.faceCos, cos > 0.9 ? '>0.9' : cos > 0.5 ? '0.5..0.9' : cos > -0.5 ? '-0.5..0.5' : cos > -0.9 ? '-0.9..-0.5' : '<-0.9');
    }
  }
}

const i8 = (b: number): number => (b << 24) >> 24;

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a: number[], b: number[]): number[] {
  const r = new Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) r[i * 4 + c]! += a[i * 4 + k]! * b[k * 4 + c]!;
  return r;
}

function merge(into: Tally, from: Tally): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = (into as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number') (into as unknown as Record<string, number>)[k] = (cur as number) + v;
    else if (v && typeof v === 'object') {
      const target = cur as Record<string, unknown>;
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === 'number') target[k2] = ((target[k2] as number | undefined) ?? 0) + v2;
        else {
          const inner = ((target[k2] as Record<string, number> | undefined) ??= {});
          for (const [k3, v3] of Object.entries(v2 as Record<string, number>)) inner[k3] = (inner[k3] ?? 0) + v3;
        }
      }
    }
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string', default: 'dist' },
      entrances: { type: 'string' },
      'per-scene': { type: 'boolean', default: false },
      frames: { type: 'string', default: '240' },
      tasks: { type: 'string', default: '20' },
      'start-frame': { type: 'string', default: '19000' },
      input: { type: 'string', default: 'tools/headless/newgame.input' },
      out: { type: 'string', default: 'out/lighting' },
    },
  });
  const out = resolve(values.out!);
  mkdirSync(out, { recursive: true });
  const script = parseInput(readFileSync(values.input!, 'utf8'), values.input!);
  const cartridge = readCartridge(join(resolve(values.dist!), 'assets'));
  const keep = Number(values.tasks);
  let replaying = true;
  const pending: Tally[] = [];
  const start = async (): Promise<Game> => {
    replaying = true;
    const game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, cartridge, {
      onGfxTask: (task) => {
        if (replaying) return;
        // The memory is only valid now, so the list is walked here.
        const t = newTally();
        new Walker(task.ram, t).run(task.data);
        t.tasks = 1;
        t.interpreterVtxCommands = task.displayList().opcodes.get(1) ?? 0;
        pending.push(t);
      },
    });
    let frame = 0;
    while (frame < Number(values['start-frame'])) {
      frame++;
      const pad = padAt(script, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      if (r.fatal) throw new Error(`trap at frame ${frame}: ${r.fatal}`);
    }
    game.setPad(0, 0, 0);
    replaying = false;
    return game;
  };

  let game = await start();
  const table = Array.from({ length: ENTRANCE_COUNT }, (_, i) => {
    const word = game.rd32(ENTRANCE_TABLE + i * 4);
    return { scene: (word << 0) >> 24, spawn: (word << 8) >> 24 };
  });
  let sceneCount = 0;
  while (game.rd32(SCENE_TABLE + sceneCount * SCENE_RECORD_SIZE) < game.rd32(SCENE_TABLE + sceneCount * SCENE_RECORD_SIZE + 4)) sceneCount++;
  let entrances: number[];
  if (values.entrances) entrances = values.entrances.split(',').map(Number);
  else {
    const seen = new Set<number>();
    entrances = [];
    table.forEach((e, i) => {
      if (e.scene >= 0 && e.scene < sceneCount && !seen.has(e.scene)) {
        seen.add(e.scene);
        entrances.push(i);
      }
    });
  }
  const perScene: Record<string, { entrance: number; reached: number | null; tally: Tally }> = {};
  const total = newTally();
  const write32 = (addr: number, value: number): void => {
    const ram = game.ram();
    new DataView(ram.buffer, ram.byteOffset, ram.byteLength).setUint32(addr & 0x7fffff, value >>> 0);
  };
  for (const entrance of entrances) {
    let play = playState(game.rd32);
    if (!play) {
      game = await start();
      play = playState(game.rd32)!;
    }
    pending.length = 0;
    requestEntrance(game.rd32, write32, play, entrance);
    let failed = false;
    for (let k = 0; k < Number(values.frames); k++) {
      const r = await game.frame();
      if (r.fatal || !r.alive) {
        failed = true;
        break;
      }
    }
    const reached = playState(game.rd32)?.scene ?? null;
    const tally = newTally();
    for (const p of pending.slice(-keep)) merge(tally, p);
    const scene = table[entrance]!.scene;
    console.log(`entrance ${entrance} scene ${scene} reached ${reached}${failed ? ' (trap)' : ''}: ${tally.tasks} tasks, ${tally.triangles} tris, ${tally.litTriangles} lit`);
    if (!failed && reached === scene) {
      perScene[`scene-${scene}`] = { entrance, reached, tally };
      merge(total, tally);
    }
    if (failed || reached !== scene) {
      game = await start();
    }
  }
  writeFileSync(join(out, 'lighting.json'), JSON.stringify({ perScene, total }, null, 1));
  console.log(`wrote ${join(out, 'lighting.json')} (${Object.keys(perScene).length} scenes)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
