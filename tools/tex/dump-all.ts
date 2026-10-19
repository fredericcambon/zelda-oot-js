// `npm run tex -- dump --all [--dist dist] [--out out/texdump] [--frames 600] [--entrances 238,626] [--fresh]`: the texture dump of the whole game. For every
// scene and spawn the entrance table names (the first entry of each pair), as child and as adult, by day and by night, it forces the entrance in the
// scripted new game (as the scene sweep does, tools/sweep/scenes.ts), lets the scene load and its actors and animated textures run, then walks Link
// round a circle of headings so that the camera, which trails him, turns with him. Each visit is saved to `<out>/visits/<key>.json` when it ends, so
// an interrupted run continues with the visits that are missing; the pictures go to `<out>/<hash>.png` and `index.json` and `report.json` merge all visits.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCartridge } from '../assets/write.ts';
import { encodePng } from '../gfx/png.ts';
import { bootGame, type Game } from '../headless/boot.ts';
import { padAt, parseInput, type InputScript } from '../headless/input.ts';
import { ENTRANCE_COUNT, playState, requestEntrance, SETUP_FLAG, TIME_OF_DAY } from '../headless/state.ts';
import { countSceneRecords, DEFAULT_START_FRAME, readEntrances, type Age } from '../sweep/scenes.ts';
import { type Edge, type GroupStats, isChurning, SHORT_LIVED_FRAMES, type TextureRecord, TextureCollector } from './collect.ts';

export type TimeOfDay = 'day' | 'night';
export const AGES: readonly Age[] = ['child', 'adult'];
export const TIMES: readonly TimeOfDay[] = ['day', 'night'];
/** The time of day written before the entrance is forced: noon, and midnight (the game takes the night records for times below 0x4555 or above 0xC000, tools/headless/state.ts). */
const TIME_VALUE: Record<TimeOfDay, number> = { day: 0x8000, night: 0 };

/**
 * The byte of the play context that the overlay of file 35 copies into the flag at SETUP_FLAG when the state ends (`lbu 7656(ctx+0x10000)`, `sw` to 0x801183D4 at
 * 0x808496DC-0x808496E8). Writing the flag alone is undone by that copy, so an adult run sets both (observed: entry 238 with only the flag written loads entry 236,
 * scene 84; with both, the variant word reads 2 by day and 3 by night and the scene is 85).
 */
const CTX_AGE_BYTE = 0x11de8;

/** Video frames of a visit with A taps (the entrance's cutscene and the scene's loading), then the circle of headings. */
const SETTLE_FRAMES = 150;
const HEADINGS: Array<[number, number]> = [[0, 80], [57, 57], [80, 0], [57, -57], [0, -80], [-57, -57], [-80, 0], [-57, 57]];
const HEADING_FRAMES = 50;
/** Video frame of a visit at which the scene of the play state is compared with the scene the table names. */
const CHECK_FRAME = 60;
/** Visits between two writes of the merged index (the visit files are what a resumed run reads). */
const PUBLISH_EVERY = 25;

/** `hang`: the game made no progress (a guest loop that never yields) and the worker was killed; the visit has no textures. */
export type VisitStatus = 'ok' | 'trap' | 'halted' | 'hang' | 'left-play-state' | 'not-reached';

export interface VisitFile {
  key: string;
  /** The first table entry with this scene and spawn. */
  entrance: number;
  scene: number;
  spawn: number;
  age: Age;
  time: TimeOfDay;
  status: VisitStatus;
  reason?: string;
  /** The scene of the play state at the check frame and at the end, or null when none was loaded. */
  sceneAtCheck: number | null;
  sceneAtEnd: number | null;
  frames: number;
  tasks: number;
  records: TextureRecord[];
  groups: GroupStats[];
}

/** A texture of the merged index: the facts of `TextureRecord` over all visits, and where it was seen. */
export type MergedRecord = Omit<TextureRecord, 'first' | 'last'> & { ages: Age[]; times: TimeOfDay[] };

const EDGE_RANK: Record<Edge, number> = { clamp: 0, mirror: 1, wrap: 2 };
const widest = (a: Edge, b: Edge): Edge => (EDGE_RANK[a] >= EDGE_RANK[b] ? a : b);

export const visitKey = (scene: number, spawn: number, age: Age, time: TimeOfDay): string => `s${scene}-p${spawn}-${age}-${time}`;

export interface Merged {
  tasks: number;
  textures: MergedRecord[];
  churningGroups: GroupStats[];
}

/**
 * Combines the visits. A texture's frames add up, its scenes, ages and times union, its edge treatment is the widest any visit saw, and it is volatile
 * when its group churns over all visits together (the rule of `TextureCollector.finish`) and it was drawn in few frames in all.
 */
export function mergeVisits(visits: readonly VisitFile[]): Merged {
  const groups = new Map<string, GroupStats>();
  const byHash = new Map<string, MergedRecord>();
  let tasks = 0;
  for (const v of visits) {
    tasks += v.tasks;
    for (const g of v.groups) {
      const sum = groups.get(g.group) ?? { group: g.group, present: 0, withNew: 0 };
      sum.present += g.present;
      sum.withNew += g.withNew;
      groups.set(g.group, sum);
    }
    for (const r of v.records) {
      const m = byHash.get(r.hash);
      if (!m) {
        const rest: Partial<TextureRecord> = { ...r };
        delete rest.first;
        delete rest.last;
        byHash.set(r.hash, { ...(rest as MergedRecord), scenes: [...r.scenes], reach: r.reach && [...r.reach], ages: [v.age], times: [v.time] });
        continue;
      }
      m.frames += r.frames;
      m.edgeS = widest(m.edgeS, r.edgeS);
      m.edgeT = widest(m.edgeT, r.edgeT);
      m.pictures = Math.max(m.pictures, r.pictures);
      for (const s of r.scenes) if (!m.scenes.includes(s)) m.scenes.push(s);
      if (!m.ages.includes(v.age)) m.ages.push(v.age);
      if (!m.times.includes(v.time)) m.times.push(v.time);
      if (r.reach) {
        const a = (m.reach ??= [...r.reach]);
        a[0] = Math.min(a[0], r.reach[0]); a[1] = Math.min(a[1], r.reach[1]); a[2] = Math.max(a[2], r.reach[2]); a[3] = Math.max(a[3], r.reach[3]);
      }
    }
  }
  const churning = new Set([...groups.values()].filter(isChurning).map((g) => g.group));
  const textures = [...byHash.values()];
  for (const m of textures) {
    m.scenes.sort((a, b) => a - b);
    m.volatile = churning.has(`${m.width}x${m.height}:${m.fmt}.${m.siz}`) && m.frames <= SHORT_LIVED_FRAMES;
  }
  return { tasks, textures, churningGroups: [...groups.values()].filter(isChurning) };
}

/** The scene and spawn pairs of the entrance table with the first entry of each, and the entries that name no scene. */
export function plannedEntrances(table: readonly { scene: number; spawn: number }[], sceneRecords: number, only?: readonly number[]): { chosen: { entrance: number; scene: number; spawn: number }[]; invalid: number[] } {
  const seen = new Set<string>();
  const chosen: { entrance: number; scene: number; spawn: number }[] = [];
  const invalid: number[] = [];
  for (const entrance of only ?? table.map((_, i) => i)) {
    const info = table[entrance];
    if (!info) throw new Error(`entrance ${entrance} is outside the table of ${table.length}`);
    if (info.scene < 0 || info.scene >= sceneRecords) {
      invalid.push(entrance);
      continue;
    }
    const id = `${info.scene}/${info.spawn}`;
    if (seen.has(id)) continue;
    seen.add(id);
    chosen.push({ entrance, ...info });
  }
  return { chosen, invalid };
}

export interface DumpAllOptions {
  dist: string;
  out: string;
  /** Video frames of a visit. */
  frames?: number;
  /** Only these table entries (before the scene and spawn pairs are chosen); all when unset. */
  entrances?: number[];
  /** Forget the saved visits. */
  fresh?: boolean;
  log?: (line: string) => void;
}

export async function dumpAll({ dist, out, frames = 600, entrances, fresh = false, log = console.log }: DumpAllOptions): Promise<void> {
  const root = resolve(out);
  if (fresh) rmSync(root, { recursive: true, force: true });
  const visitsDir = join(root, 'visits');
  mkdirSync(visitsDir, { recursive: true });
  const visits: VisitFile[] = readdirSync(visitsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(visitsDir, f), 'utf8')) as VisitFile);
  const known = new Set(visits.flatMap((v) => v.records.map((r) => r.hash)));
  const done = new Set(visits.map((v) => v.key));

  const cartridge = readCartridge(join(resolve(dist), 'assets'));
  const tapA: InputScript = parseInput('tap A 100 4000 40 3', 'tap');
  const script = parseInput(readFileSync(new URL('../headless/newgame.input', import.meta.url), 'utf8'), 'newgame.input');
  let collector: TextureCollector | undefined;
  let tasks = 0;
  const start = async (): Promise<Game> => {
    const game: Game = await bootGame(pathToFileURL(resolve(dist, 'oot.js')).href, cartridge, {
      onGfxTask: (task) => {
        if (!collector) return;
        collector.nextFrame(playState(game.rd32)?.scene ?? -1);
        collector.add(task.displayList());
        tasks++;
      },
    });
    for (let f = 1; f <= DEFAULT_START_FRAME; f++) {
      const pad = padAt(script, f);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      if (r.fatal || !r.alive) throw new Error(`the scripted new game stops at frame ${f}: ${r.fatal ?? 'nothing can run'}`);
    }
    if (!playState(game.rd32)) throw new Error(`no scene is loaded at frame ${DEFAULT_START_FRAME}`);
    game.setPad(0, 0, 0);
    return game;
  };

  let game = await start();
  const table = readEntrances(game);
  const { chosen, invalid } = plannedEntrances(table, countSceneRecords(game), entrances);
  const childFlag = game.rd32(SETUP_FLAG);
  if (childFlag === 0) throw new Error('the scripted new game starts with the age flag clear; the dump cannot tell the ages apart');
  const jobs = chosen.flatMap((c) => AGES.flatMap((age) => TIMES.map((time) => ({ ...c, age, time, key: visitKey(c.scene, c.spawn, age, time) }))));
  const todo = jobs.filter((j) => !done.has(j.key));
  log(`${chosen.length} scene and spawn pairs of ${ENTRANCE_COUNT} entries (${invalid.length} entries name no scene), ${jobs.length} visits, ${jobs.length - todo.length} saved already`);

  let written = 0;
  const publish = (): Merged => {
    const merged = mergeVisits(visits);
    const failed = visits.filter((v) => v.status !== 'ok').map((v) => ({ key: v.key, entrance: v.entrance, status: v.status, reason: v.reason ?? null }));
    const okScenes = [...new Set(visits.filter((v) => v.status === 'ok').map((v) => v.scene))].sort((a, b) => a - b);
    const allScenes = [...new Set(chosen.map((c) => c.scene))].sort((a, b) => a - b);
    const volatile = merged.textures.filter((t) => t.volatile).length;
    writeFileSync(join(root, 'index.json'), JSON.stringify({
      tasks: merged.tasks,
      visits: visits.map((v) => ({ ...v, records: undefined, groups: undefined, textures: v.records.length })),
      textures: Object.fromEntries(merged.textures.map((t) => [t.hash, t])),
    }, null, 1));
    writeFileSync(join(root, 'report.json'), JSON.stringify({
      tasks: merged.tasks, unique: merged.textures.length, volatile, churningGroups: merged.churningGroups,
      visits: { planned: jobs.length, saved: visits.length, ok: visits.length - failed.length, failed: failed.length },
      scenes: { planned: allScenes.length, visited: okScenes.length, missing: allScenes.filter((s) => !okScenes.includes(s)) },
      failed, entriesWithoutScene: invalid,
    }, null, 1));
    return merged;
  };

  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
    log('interrupted: finishing the visit in progress');
  });

  let needFresh = false;
  for (const job of todo) {
    if (stop) break;
    if (needFresh || !playState(game.rd32)) {
      game = await start();
      needFresh = false;
    }
    const play = playState(game.rd32)!;
    const ram = game.ram();
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    const write32 = (addr: number, value: number) => view.setUint32(addr & 0x7fffff, value >>> 0);
    const flag = job.age === 'child' ? childFlag : 0;
    write32(SETUP_FLAG, flag);
    view.setUint8((play.context + CTX_AGE_BYTE) & 0x7fffff, flag);
    write32(TIME_OF_DAY, ((TIME_VALUE[job.time] << 16) | (game.rd32(TIME_OF_DAY) & 0xffff)) >>> 0);
    requestEntrance(game.rd32, write32, play, job.entrance);

    writeFileSync(join(root, 'current.json'), JSON.stringify({ key: job.key, entrance: job.entrance, scene: job.scene, spawn: job.spawn, age: job.age, time: job.time }));
    collector = new TextureCollector(known);
    const before = tasks;
    let status: VisitStatus = 'ok';
    let reason: string | undefined;
    let sceneAtCheck: number | null = null;
    let ran = 0;
    for (let k = 1; k <= frames; k++) {
      ran = k;
      const a = padAt(tapA, k);
      const heading = k <= SETTLE_FRAMES ? [0, 0] : HEADINGS[Math.floor((k - SETTLE_FRAMES) / HEADING_FRAMES) % HEADINGS.length]!;
      game.setPad(k <= SETTLE_FRAMES ? a.buttons : 0, heading[0]!, heading[1]!);
      const r = await game.frame();
      if (r.fatal || !r.alive) {
        status = r.fatal ? 'trap' : 'halted';
        reason = r.fatal ?? 'nothing can run';
        break;
      }
      if (k === CHECK_FRAME) sceneAtCheck = playState(game.rd32)?.scene ?? null;
    }
    const sceneAtEnd = status === 'ok' || status === 'trap' ? playState(game.rd32)?.scene ?? null : null;
    if (status === 'ok') {
      if (sceneAtEnd === null) {
        status = 'left-play-state';
        reason = 'no scene is loaded at the end of the visit';
      } else if (sceneAtCheck !== job.scene) {
        status = 'not-reached';
        reason = `the play state shows scene ${sceneAtCheck ?? 'none'} at frame ${CHECK_FRAME}, the table names ${job.scene}`;
      }
    }
    const { records, pixels, groups } = collector.finish();
    collector = undefined;
    for (const r of records) {
      if (!known.has(r.hash)) writeFileSync(join(root, `${r.hash}.png`), encodePng(r.width, r.height, pixels.get(r.hash)!));
      known.add(r.hash);
    }
    const visit: VisitFile = {
      key: job.key, entrance: job.entrance, scene: job.scene, spawn: job.spawn, age: job.age, time: job.time, status, ...(reason ? { reason } : {}),
      sceneAtCheck, sceneAtEnd, frames: ran, tasks: tasks - before, records, groups,
    };
    visits.push(visit);
    // The pictures are on disk before the visit file: a visit that is saved always has its pictures.
    writeFileSync(join(visitsDir, `${job.key}.json`), JSON.stringify(visit));
    written++;
    log(`${visits.length}/${jobs.length} ${job.key} (entry ${job.entrance}): ${status}${reason ? `, ${reason}` : ''}, ${records.length} textures, ${known.size} in all`);
    if (status !== 'ok') needFresh = true;
    if (written % PUBLISH_EVERY === 0) publish();
  }
  const merged = publish();
  const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')) as { volatile: number; visits: { ok: number; failed: number }; scenes: { visited: number; planned: number } };
  log(`${merged.textures.length} unique textures, ${report.volatile} change from frame to frame (kept original); ${report.scenes.visited} of ${report.scenes.planned} scenes visited, ${report.visits.ok} visits ok, ${report.visits.failed} failed (${written} run now); written to ${out}`);
  if (stop) log('stopped early: run again to continue');
}

export interface SuperviseOptions extends DumpAllOptions {
  /** Seconds without a line of output after which the worker is killed. */
  hangSeconds?: number;
  /** Arguments of the worker command line after `dump --all`. */
  workerArgs: string[];
}

/**
 * Runs `dumpAll` in a worker process and restarts it after a hang: the recompiled game runs inside the worker's thread, so a guest loop that never yields
 * cannot be interrupted from within. A visit that hangs is saved with the status `hang` and skipped by the restarted worker.
 */
export async function superviseDumpAll({ out, fresh = false, hangSeconds = 120, workerArgs, log = console.log }: SuperviseOptions): Promise<void> {
  const root = resolve(out);
  if (fresh) rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'visits'), { recursive: true });
  for (;;) {
    rmSync(join(root, 'current.json'), { force: true });
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'dump', '--all', '--worker', ...workerArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
    let lastLine = Date.now();
    let hung = false;
    child.stdout.on('data', (chunk: Buffer) => {
      lastLine = Date.now();
      process.stdout.write(chunk);
    });
    const watch = setInterval(() => {
      if (Date.now() - lastLine < hangSeconds * 1000) return;
      hung = true;
      if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
      else child.kill('SIGKILL');
    }, 5000);
    const code = await new Promise<number | null>((done) => child.once('close', done));
    clearInterval(watch);
    if (!hung) {
      if (code !== 0) throw new Error(`the dump worker exited with status ${code}`);
      return;
    }
    const current = join(root, 'current.json');
    if (!existsSync(current)) {
      log(`the worker made no progress for ${hangSeconds} s before its first visit`);
      throw new Error('the dump worker hangs while starting the game');
    }
    const job = JSON.parse(readFileSync(current, 'utf8')) as Pick<VisitFile, 'key' | 'entrance' | 'scene' | 'spawn' | 'age' | 'time'>;
    const visit: VisitFile = { ...job, status: 'hang', reason: `no output for ${hangSeconds} s: the game does not yield`, sceneAtCheck: null, sceneAtEnd: null, frames: 0, tasks: 0, records: [], groups: [] };
    writeFileSync(join(root, 'visits', `${job.key}.json`), JSON.stringify(visit));
    log(`${job.key} (entry ${job.entrance}): hang, worker killed`);
  }
}
