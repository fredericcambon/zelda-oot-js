// `npm run sweep -- <static|scenes|report>`: the gap sweep (docs/re/gaps.md).
//   static   reads the ROM (OOT_ROM) and the inventory and writes out/sweep/static.json
//   scenes   forces each entrance of the game's entrance table in a built game (dist, ideally from `npm run port -- --coverage`);
//            --shard k/n runs every n-th entrance from the k-th and writes scenes-k.json, so shards can run side by side
//   report   writes the tables of both into the marker blocks of docs/re/gaps.md
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import type { Inventory } from '../analyze/types.ts';
import { ENTRANCE_COUNT } from '../headless/state.ts';
import { renderScenes, renderStatic, replaceBlock } from './render.ts';
import { DEFAULT_START_FRAME, mergeReports, sweepScenes, type SceneSweepReport } from './scenes.ts';
import { staticSweep, type StaticSweep } from './static.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'out/sweep' },
    inventory: { type: 'string', default: 'out/inventory.json' },
    rom: { type: 'string' },
    dist: { type: 'string', default: 'dist-cov' },
    frames: { type: 'string', default: '300' },
    from: { type: 'string', default: '0' },
    to: { type: 'string', default: String(ENTRANCE_COUNT - 1) },
    every: { type: 'string', default: '1' },
    entrances: { type: 'string' },
    shard: { type: 'string' },
    'start-frame': { type: 'string', default: String(DEFAULT_START_FRAME) },
    input: { type: 'string', default: 'tools/headless/newgame.input' },
    dump: { type: 'string' },
    'dumps-per-scene': { type: 'string', default: '2' },
    doc: { type: 'string', default: 'docs/re/gaps.md' },
  },
});

const out = resolve(values.out!);
const staticPath = join(out, 'static.json');

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}

async function main(): Promise<number> {
  mkdirSync(out, { recursive: true });
  const command = positionals[0];
  if (command === 'static') {
    const inventory = JSON.parse(readFileSync(values.inventory!, 'utf8')) as Inventory;
    const result = staticSweep(loadContext(romPathFromEnv(values.rom)), inventory, resolve('runtime'));
    writeFileSync(staticPath, JSON.stringify(result));
    console.log(`wrote ${staticPath}: ${result.tasks.tasks.length} RSP task kinds, ${result.os.entries.length} OS routines, ${result.os.mmio.length} register accesses`);
    return 0;
  }
  if (command === 'scenes') {
    const [shard, shards] = (values.shard ?? '0/1').split('/').map(Number) as [number, number];
    const scenesPath = join(out, shards > 1 ? `scenes-${shard}.json` : 'scenes.json');
    const entrances = (values.entrances
      ? values.entrances.split(',').map(Number)
      : Array.from({ length: Math.floor((Number(values.to) - Number(values.from)) / Number(values.every)) + 1 }, (_, i) => Number(values.from) + i * Number(values.every))
    ).filter((e) => e % shards === shard);
    const save = (report: SceneSweepReport) => writeFileSync(scenesPath, JSON.stringify(report));
    const report = await sweepScenes({
      dist: values.dist!, entrances, frames: Number(values.frames), startFrame: Number(values['start-frame']), input: values.input!,
      dumpDir: values.dump, dumpsPerScene: Number(values['dumps-per-scene']), log: (m) => console.log(m), onProgress: save,
    });
    save(report);
    const bad = report.results.filter((r) => r.status === 'trap' || r.status === 'halted');
    console.log(`wrote ${scenesPath}: ${report.results.length} entrances, ${bad.length} trapped or halted`);
    return 0;
  }
  if (command === 'report') {
    const s = readJson<StaticSweep>(staticPath);
    if (!s) throw new Error(`run \`sweep static\` first (${staticPath} is missing)`);
    const parts = readdirSync(out).filter((f) => /^scenes(-\d+)?\.json$/.test(f)).map((f) => readJson<SceneSweepReport>(join(out, f))!);
    const scenes = parts.length > 0 ? mergeReports(parts) : undefined;
    let doc = readFileSync(values.doc!, 'utf8');
    doc = replaceBlock(doc, 'static', renderStatic(s, scenes));
    if (scenes) doc = replaceBlock(doc, 'scenes', renderScenes(scenes, s));
    writeFileSync(values.doc!, doc);
    console.log(`updated ${values.doc}`);
    return 0;
  }
  console.error('usage: sweep <static|scenes|report> [options]');
  return 2;
}

process.exitCode = await main();
