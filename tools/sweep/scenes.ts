// The scene sweep: for each entrance of the game's entrance table, force the game into it, run a fixed number of video
// frames and record what went wrong. One game instance carries on from entrance to entrance; after a trap or when the game
// leaves the play state, a fresh instance replays the scripted new game up to the start frame and the sweep continues.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCartridge } from '../assets/write.ts';
import type { DisplayListResult } from '../gfx/types.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame, type CoverageSnapshot, type Game } from '../headless/boot.ts';
import { padAt, parseInput, type InputScript } from '../headless/input.ts';
import { Synth } from '../audio/synth.ts';
import { findShortLoop } from './loops.ts';
import { mixerAccepts } from './static.ts';
import { ENTRANCE_COUNT, ENTRANCE_TABLE, playState, requestEntrance, SCENE_RECORD_SIZE, SCENE_TABLE, SETUP_FLAG, SETUP_VARIANT } from '../headless/state.ts';

/** Frames drawn before a dumped frame, so that its colour image is complete. */
const DRAW_LEAD = 8;
/** Retraces at the end of a run in which a scene must have drawn something. */
const BLANK_WINDOW = 30;
/** The game under player control in Link's house: the earliest point from which the scripted new game leaves a plain play state. */
export const DEFAULT_START_FRAME = 19000;

/** `not-reached`: the play state shows another scene than the table names. */
export type EntranceStatus = 'ok' | 'trap' | 'halted' | 'invalid-scene' | 'left-play-state' | 'not-reached';

/**
 * The age the run is made as. The flag at SETUP_FLAG chooses the setup layers (non-zero: 0 and 1, zero: 2 and 3, `setupVariantFor`);
 * the new game, a child, has it non-zero (checked when the sweep starts).
 */
export type Age = 'child' | 'adult';

export interface EntranceResult {
  /** The table entry the run aims at. */
  entrance: number;
  age: Age;
  /** Scene and spawn that entry names. */
  scene: number;
  spawn: number;
  /** The setup variant the game added to the index it was given; the entry it loaded is the index plus this. */
  variant: number;
  /** The index written for the game: the entry minus the variant the game had before. */
  forced: number;
  /** The entry the game loaded (index plus variant) and the scene it names; the entry aimed at when the variant did not change. */
  effective: number;
  effectiveScene: number | null;
  /** Recompiled functions that ran for the first time in this run (in this game instance). */
  newFunctions: number;
  /** Blocks beyond RDRAM (first address, accesses) that the code touched during this run. */
  outsideRdram: { addr: number; hits: number }[];
  status: EntranceStatus;
  /** Scene of the play state after the run, or null when there was none. */
  reachedScene: number | null;
  frames: number;
  gfxTasks: number;
  /** Triangles and rectangles drawn in the last frames of the run. */
  primitivesAtEnd: number;
  blank: 'no' | 'no-geometry' | 'single-colour';
  trap?: string;
  /**
   * Display-list opcodes the interpreter does not know, with counts, and the first command of each (both words and its address).
   * A `*` after the opcode marks commands that follow an opcode 0xdd of the same list.
   */
  unknownCommands: Record<string, number>;
  unknownSamples: Record<string, string>;
  /** Audio opcodes the mixer rejects, with counts. */
  unknownAudio: Record<string, number>;
  /** Peak-to-peak range of the last 8192 mono samples the game queued, and the period in samples when they repeat exactly. */
  audioRange: number;
  audioLoop?: number;
  problems: string[];
  dumps: string[];
}

export interface SceneSweepReport {
  frames: number;
  startFrame: number;
  sceneRecords: number;
  results: EntranceResult[];
  /** Display-list and audio opcodes executed over the whole sweep, with counts. */
  graphicsOpcodes: Record<string, number>;
  audioOpcodes: Record<string, number>;
  rspTasks: { type: number; ucode: number; count: number }[];
  /** Present when the module is a coverage build. */
  coverage?: {
    functions: number[];
    osCalls: [number, number][];
    outsideRdram: { addr: number; hits: number; function: number }[];
  };
  /** Instances started: one at the beginning and one per recovery. */
  restarts: number;
}

export interface SweepOptions {
  dist: string;
  entrances: number[];
  ages: Age[];
  frames: number;
  startFrame: number;
  /** The controller script that plays the new game up to the start frame. */
  input: string;
  /** Where the dumped frames go; none are drawn when unset. */
  dumpDir?: string;
  dumpsPerScene: number;
  log: (message: string) => void;
  /** Called after each entrance with the report so far. */
  onProgress?: (report: SceneSweepReport) => void;
}

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by;
};
const opKey = (op: number) => op.toString(16).padStart(2, '0');

/** What one run of an entrance collects from the display lists and audio tasks the game submits. */
class Collector {
  tasks = 0;
  unknownCommands: Record<string, number> = {};
  unknownSamples: Record<string, string> = {};
  unknownAudio: Record<string, number> = {};
  problems = new Set<string>();
  /** Mono samples (left and right averaged) the game queued to the audio interface. */
  pcm: Int16Array[] = [];
  recent: number[] = [];
  retrace = 0;
  /** Whether the display lists of the tasks now arriving are drawn into the software renderer. */
  draw = false;
}

class Session {
  private constructor(
    readonly game: Game,
    private readonly collector: { current: Collector },
    readonly soft: SoftRenderer,
    private readonly total: { graphics: Record<string, number>; audio: Record<string, number> },
  ) {}

  static async start(
    opts: SweepOptions, script: InputScript, cartridge: Uint8Array, total: { graphics: Record<string, number>; audio: Record<string, number> },
  ): Promise<Session> {
    const collector = { current: new Collector() };
    // The display lists of the scripted start are not interpreted: nothing of it is reported and it is most of the run's time.
    let replaying = true;
    const soft = new SoftRenderer();
    const synth = new Synth();
    const game = await bootGame(pathToFileURL(resolve(opts.dist, 'oot.js')).href, cartridge, {
      onGfxTask: (task) => {
        if (replaying) return;
        const c = collector.current;
        c.tasks++;
        const result = task.displayList();
        record(c, total.graphics, result);
        if (c.draw) soft.drawTask(result);
        c.recent.push(primitives(result));
        if (c.recent.length > BLANK_WINDOW) c.recent.shift();
      },
      onAudioTask: (task) => {
        if (replaying) return;
        const c = collector.current;
        const view = new DataView(task.ram.buffer, task.ram.byteOffset, task.ram.byteLength);
        for (let at = task.data & 0x7ffff8; at + 8 <= (task.data & 0x7ffff8) + task.size; at += 8) {
          const op = (view.getUint32(at) >>> 24) & 0x7f;
          bump(total.audio, opKey(op));
          if (!AUDIO_OPCODES.has(op)) bump(c.unknownAudio, opKey(op));
        }
        try {
          synth.run(task.ram, { list: task.data & 0x1fffffff, size: task.size, dataSegment: task.microcodeData & 0x1fffffff });
        } catch (err) {
          if (c.problems.size < 8) c.problems.add(`audio: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onAiBuffer: (buffer) => {
        if (replaying) return;
        const at = buffer.addr & 0x7fffff;
        const dv = new DataView(buffer.ram.buffer, buffer.ram.byteOffset + at, buffer.length);
        const mono = new Int16Array(buffer.length >> 2);
        for (let i = 0; i < mono.length; i++) mono[i] = (dv.getInt16(i * 4) + dv.getInt16(i * 4 + 2)) >> 1;
        collector.current.pcm.push(mono);
      },
    });
    const session = new Session(game, collector, soft, total);
    let frame = 0;
    while (frame < opts.startFrame) {
      frame++;
      const pad = padAt(script, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      if (r.fatal) throw new Error(`the scripted new game traps at frame ${frame}: ${r.fatal}`);
    }
    if (!playState(game.rd32)) throw new Error(`no scene is loaded at frame ${opts.startFrame}`);
    game.setPad(0, 0, 0);
    replaying = false;
    return session;
  }

  /** Writes a word of guest memory. */
  write32 = (addr: number, value: number): void => {
    const ram = this.game.ram();
    new DataView(ram.buffer, ram.byteOffset, ram.byteLength).setUint32(addr & 0x7fffff, value >>> 0);
  };

  begin(): Collector {
    this.collector.current = new Collector();
    return this.collector.current;
  }
}

/** Audio opcodes the mixer implements (tools/audio/synth.ts). */
const AUDIO_OPCODES = new Set(Array.from({ length: 128 }, (_, op) => op).filter(mixerAccepts));

function record(c: Collector, total: Record<string, number>, result: DisplayListResult): void {
  for (const [op, n] of result.opcodes) bump(total, opKey(op), n);
  let switched = false;
  for (const u of result.unknown) {
    const op = u.w0 >>> 24;
    if (op === 0xdd) switched = true;
    const key = switched && op !== 0xdd ? `${opKey(op)}*` : opKey(op);
    bump(c.unknownCommands, key);
    c.unknownSamples[key] ??= `${u.w0.toString(16).padStart(8, '0')} ${u.w1.toString(16).padStart(8, '0')} at 0x${u.addr.toString(16)}`;
  }
  for (const p of result.problems) if (c.problems.size < 8) c.problems.add(p.replace(/0x[0-9a-f]+/g, '0x…'));
}

function primitives(result: DisplayListResult): number {
  let n = 0;
  for (const b of result.batches) n += b.kind === 'triangles' ? b.positions.length / 12 : 1;
  return n;
}

/** Pixels that differ from the most frequent colour: a blank or flat frame has none. */
function nonFlatPixels(img: Uint8Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < img.length; i += 4) {
    const key = (img[i]! << 16) | (img[i + 1]! << 8) | img[i + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return img.length / 4 - Math.max(...counts.values());
}

/** The entrance table of the game's memory: scene and spawn of each entry. */
function readEntrances(game: Game): { scene: number; spawn: number }[] {
  return Array.from({ length: ENTRANCE_COUNT }, (_, i) => {
    const word = game.rd32(ENTRANCE_TABLE + i * 4);
    return { scene: (word << 0) >> 24, spawn: (word << 8) >> 24 };
  });
}

/** Records of the scene table that name a file range inside the cartridge; the table ends at the first that does not. */
function countSceneRecords(game: Game): number {
  let n = 0;
  for (;; n++) {
    const start = game.rd32(SCENE_TABLE + n * SCENE_RECORD_SIZE);
    const end = game.rd32(SCENE_TABLE + n * SCENE_RECORD_SIZE + 4);
    if (start >= end || end > 0x4000000) return n;
  }
}

export async function sweepScenes(opts: SweepOptions): Promise<SceneSweepReport> {
  const script = parseInput(readFileSync(opts.input, 'utf8'), opts.input);
  const cartridge = readCartridge(join(resolve(opts.dist), 'assets'));
  const total = { graphics: {} as Record<string, number>, audio: {} as Record<string, number> };
  const report: SceneSweepReport = {
    frames: opts.frames, startFrame: opts.startFrame, sceneRecords: 0, results: [], graphicsOpcodes: total.graphics, audioOpcodes: total.audio,
    rspTasks: [], restarts: 0,
  };
  const coverage = { functions: new Set<number>(), osCalls: new Map<number, number>(), outside: new Map<number, { addr: number; hits: number; function: number }>() };
  const taskKinds = new Map<string, { type: number; ucode: number; count: number }>();
  let haveCoverage = false;

  const absorb = (game: Game) => {
    for (const k of game.rspTasks()) {
      const key = `${k.type}:${k.ucode}`;
      const seen = taskKinds.get(key);
      if (seen) seen.count += k.count;
      else taskKinds.set(key, { ...k });
    }
    const snap: CoverageSnapshot | undefined = game.coverage();
    if (!snap) return;
    haveCoverage = true;
    for (const f of snap.functions) coverage.functions.add(f);
    for (const [addr, hits] of snap.osCalls) coverage.osCalls.set(addr, (coverage.osCalls.get(addr) ?? 0) + hits);
    for (const o of snap.outsideRdram) {
      const seen = coverage.outside.get(o.addr);
      if (seen) seen.hits += o.hits;
      else coverage.outside.set(o.addr, { ...o });
    }
  };
  const publish = () => {
    report.rspTasks = [...taskKinds.values()];
    if (haveCoverage) {
      report.coverage = {
        functions: [...coverage.functions].sort((a, b) => a - b),
        osCalls: [...coverage.osCalls].sort((a, b) => a[0] - b[0]),
        outsideRdram: [...coverage.outside.values()].sort((a, b) => a.addr - b.addr),
      };
    }
  };

  opts.log(`starting the game and playing it to frame ${opts.startFrame}`);
  let session = await Session.start(opts, script, cartridge, total);
  report.restarts = 1;
  const table = readEntrances(session.game);
  report.sceneRecords = countSceneRecords(session.game);
  const dumped = new Map<number, number>();
  if (opts.dumpDir) mkdirSync(resolve(opts.dumpDir), { recursive: true });

  const childFlag = session.game.rd32(SETUP_FLAG);
  if (childFlag === 0) throw new Error('the scripted new game starts with the age flag clear; the sweep cannot tell the ages apart');
  for (const entrance of opts.entrances) for (const age of opts.ages) {
    const info = table[entrance];
    if (!info) throw new Error(`entrance ${entrance} is outside the table of ${ENTRANCE_COUNT}`);
    const base: EntranceResult = {
      entrance, age, scene: info.scene, spawn: info.spawn, variant: 0, forced: entrance, effective: entrance, effectiveScene: null, newFunctions: 0, outsideRdram: [], status: 'ok', reachedScene: null, frames: 0, gfxTasks: 0, primitivesAtEnd: 0, blank: 'no',
      unknownCommands: {}, unknownSamples: {}, unknownAudio: {}, audioRange: 0, problems: [], dumps: [],
    };
    if (info.scene < 0 || info.scene >= report.sceneRecords) {
      report.results.push({ ...base, status: 'invalid-scene' });
      continue;
    }
    let play = playState(session.game.rd32);
    if (!play) {
      absorb(session.game);
      opts.log(`the game left the play state; restarting`);
      session = await Session.start(opts, script, cartridge, total);
      report.restarts++;
      play = playState(session.game.rd32)!;
    }
    const collector = session.begin();
    const before = session.game.coverage();
    session.write32(SETUP_FLAG, age === 'child' ? childFlag : 0);
    const forced = requestEntrance(session.game.rd32, session.write32, play, entrance);
    const dumpKey = info.scene * 2 + (age === 'child' ? 0 : 1);
    const wantDumps = opts.dumpDir && (dumped.get(dumpKey) ?? 0) === 0;
    const dumpFrames = wantDumps ? Array.from({ length: opts.dumpsPerScene }, (_, k) => Math.round((opts.frames * (k + 1)) / opts.dumpsPerScene)) : [];
    if (wantDumps) dumped.set(dumpKey, opts.dumpsPerScene);
    const result: EntranceResult = { ...base, forced };
    let lastImage: Uint8Array | undefined;
    for (let k = 1; k <= opts.frames; k++) {
      collector.draw = dumpFrames.some((f) => k > f - DRAW_LEAD && k <= f);
      const r = await session.game.frame();
      result.frames = k;
      if (r.fatal) {
        result.status = 'trap';
        result.trap = r.fatal;
        break;
      }
      if (!r.alive) {
        result.status = 'halted';
        break;
      }
      if (dumpFrames.includes(k)) {
        const img = session.soft.image(session.game.framebuffer());
        if (img) {
          lastImage = img.slice();
          const name = `entrance-${String(entrance).padStart(4, '0')}-scene-${info.scene}-${age}-frame-${k}.png`;
          writeFileSync(join(resolve(opts.dumpDir!), name), encodePng(WIDTH, HEIGHT, img));
          result.dumps.push(name);
        }
      }
    }
    result.gfxTasks = collector.tasks;
    result.primitivesAtEnd = collector.recent.reduce((a, b) => a + b, 0);
    result.unknownCommands = collector.unknownCommands;
    result.unknownSamples = collector.unknownSamples;
    result.unknownAudio = collector.unknownAudio;
    result.problems = [...collector.problems];
    const pcm = new Int16Array(collector.pcm.reduce((n, c) => n + c.length, 0));
    collector.pcm.reduce((at, c) => (pcm.set(c, at), at + c.length), 0);
    result.audioRange = pcm.length === 0 ? 0 : Math.max(...pcm.subarray(-8192)) - Math.min(...pcm.subarray(-8192));
    result.audioLoop = findShortLoop(pcm)?.period;
    result.reachedScene = playState(session.game.rd32)?.scene ?? null;
    result.variant = session.game.rd32(SETUP_VARIANT);
    result.effective = forced + result.variant;
    result.effectiveScene = table[result.effective]?.scene ?? null;
    const after = session.game.coverage();
    if (before && after) {
      const ran = new Set(before.functions);
      result.newFunctions = after.functions.filter((f) => !ran.has(f)).length;
      const seen = new Map(before.outsideRdram.map((o) => [o.addr, o.hits]));
      result.outsideRdram = after.outsideRdram.map((o) => ({ addr: o.addr, hits: o.hits - (seen.get(o.addr) ?? 0) })).filter((o) => o.hits > 0);
    }
    if (result.status === 'ok') {
      if (result.reachedScene === null) result.status = 'left-play-state';
      else if (result.reachedScene !== result.effectiveScene) result.status = 'not-reached';
      if (collector.tasks === 0 || result.primitivesAtEnd === 0) result.blank = 'no-geometry';
      else if (lastImage && nonFlatPixels(lastImage) === 0) result.blank = 'single-colour';
    }
    report.results.push(result);
    opts.log(`entrance ${entrance} ${age} (scene ${info.scene} spawn ${info.spawn}): ${result.status}, reached ${result.reachedScene ?? 'none'}${result.blank === 'no' ? '' : `, ${result.blank}`}${result.trap ? `, ${result.trap}` : ''}`);
    // A game that did not take the entrance may be stuck in a state that would swallow the next one too.
    if (result.status === 'trap' || result.status === 'halted' || result.status === 'not-reached') {
      absorb(session.game);
      session = await Session.start(opts, script, cartridge, total);
      report.restarts++;
    }
    if (report.results.length % 25 === 0) {
      publish();
      opts.onProgress?.(report);
    }
  }
  absorb(session.game);
  publish();
  opts.onProgress?.(report);
  return report;
}

/** Combines the reports of sweeps that covered different entrances (the shards of one run). */
export function mergeReports(reports: SceneSweepReport[]): SceneSweepReport {
  const first = reports[0];
  if (!first) throw new Error('no reports to merge');
  const sum = (pick: (r: SceneSweepReport) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const r of reports) for (const [k, v] of Object.entries(pick(r))) bump(out, k, v);
    return out;
  };
  const tasks = new Map<string, { type: number; ucode: number; count: number }>();
  for (const k of reports.flatMap((r) => r.rspTasks)) {
    const seen = tasks.get(`${k.type}:${k.ucode}`);
    if (seen) seen.count += k.count;
    else tasks.set(`${k.type}:${k.ucode}`, { ...k });
  }
  const merged: SceneSweepReport = {
    ...first,
    results: reports.flatMap((r) => r.results).sort((a, b) => a.entrance - b.entrance || a.age.localeCompare(b.age)),
    graphicsOpcodes: sum((r) => r.graphicsOpcodes), audioOpcodes: sum((r) => r.audioOpcodes), rspTasks: [...tasks.values()],
    restarts: reports.reduce((n, r) => n + r.restarts, 0),
  };
  const withCoverage = reports.filter((r) => r.coverage);
  if (withCoverage.length > 0) {
    const os = new Map<number, number>();
    const outside = new Map<number, { addr: number; hits: number; function: number }>();
    for (const c of withCoverage.map((r) => r.coverage!)) {
      for (const [a, n] of c.osCalls) os.set(a, (os.get(a) ?? 0) + n);
      for (const o of c.outsideRdram) {
        const seen = outside.get(o.addr);
        if (seen) seen.hits += o.hits;
        else outside.set(o.addr, { ...o });
      }
    }
    merged.coverage = {
      functions: [...new Set(withCoverage.flatMap((r) => r.coverage!.functions))].sort((a, b) => a - b),
      osCalls: [...os].sort((a, b) => a[0] - b[0]),
      outsideRdram: [...outside.values()].sort((a, b) => a.addr - b.addr),
    };
  }
  return merged;
}
