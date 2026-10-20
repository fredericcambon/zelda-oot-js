// The one -O2 build of the game that the ROM-gated suites share. global-setup.ts builds it before any test file runs; the
// suites read it back with loadBase().
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import type { Inventory } from '../analyze/types.ts';
import { classify } from '../assets/classify.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { Cache, defaultCacheDir, defaultMaxBytes, hashKey, listTree, sourceHash } from '../port/cache.ts';
import { compileAll, link, runtimeSources, type BuildOptions, type CompiledObject } from '../port/build.ts';
import { generate } from './generate.ts';
import { ensureToolchain } from './toolchain.ts';

export const BASE_DIR = resolve('out', 'test-base');
const COVERAGE_DIR = resolve('out', 'test-coverage');

/** Where the -O2 objects of the shared build are linked at another optimisation level. */
export const variantDistDir = (optimize: string) => resolve('out', `headless-test${optimize}`, 'dist');

export const testCache = () => new Cache(defaultCacheDir(), defaultMaxBytes());

export function baseOptions(): BuildOptions {
  return { cDir: join(BASE_DIR, 'c'), objDir: join(BASE_DIR, 'obj'), distDir: join(BASE_DIR, 'dist'), toolchain: ensureToolchain(), cache: testCache(), log: () => {} };
}

interface Summary {
  problems: string[];
  functions: number;
  osBindings: number;
  cFiles: number;
}

/** Links `objects` at another optimisation level; the link's response file goes in a folder of its own so that it cannot race the main link's. */
function linkVariant(opts: BuildOptions, optimize: string, objects: CompiledObject[]): Promise<string> {
  const objDir = join(BASE_DIR, `obj${optimize}`);
  mkdirSync(objDir, { recursive: true });
  return link({ ...opts, objDir, distDir: variantDistDir(optimize), optimize }, objects);
}

/**
 * Analyses and recompiles the game (served from the shared cache when unchanged, like `npm run port`), writes the assets once,
 * then compiles and links the -O2 build, the -O1 relink of its objects (for the cross-build state test) and the -DOOT_COVERAGE
 * build (for the sweep suite), one after another so that the machine runs one build at a time.
 */
export async function buildGames(rom: string, log: (msg: string) => void): Promise<void> {
  const ctx = loadContext(rom);
  const cache = testCache();
  const base = { ...baseOptions(), cache, log };
  const analysisKey = hashKey('analysis', ctx.sha1, sourceHash(['tools/analyze/run.ts'], ['data', 'tools/analyze/ghidra']), 'own-discovery-only');
  let inventory: Inventory;
  if (cache.restore('analysis', analysisKey, BASE_DIR)) inventory = JSON.parse(readFileSync(join(BASE_DIR, 'inventory.json'), 'utf8')) as Inventory;
  else {
    inventory = await analyze({ romPath: rom, outDir: BASE_DIR, workDir: join(BASE_DIR, 'work'), useGhidra: false });
    cache.store('analysis', analysisKey, BASE_DIR, ['inventory.json', ...listTree(join(BASE_DIR, 'elf')).map((f) => `elf/${f}`)]);
  }
  const generatedKey = hashKey('generated-c', analysisKey, sourceHash(['tools/recomp/generate.ts'], ['data']));
  rmSync(base.cDir, { recursive: true, force: true });
  // An entry stored by `npm run port` before the summary fields existed lacks them and is regenerated.
  const meta = cache.restore('generated-c', generatedKey, base.cDir)?.meta as Summary | undefined;
  if (meta && typeof meta.osBindings === 'number' && typeof meta.cFiles === 'number') {
    writeFileSync(join(BASE_DIR, 'summary.json'), JSON.stringify({ problems: [], functions: meta.functions, osBindings: meta.osBindings, cFiles: meta.cFiles } satisfies Summary));
  } else {
    rmSync(base.cDir, { recursive: true, force: true });
    const gen = generate(ctx, inventory, base.cDir);
    const cFiles = gen.files.filter((n) => n.endsWith('.c')).length;
    writeFileSync(join(BASE_DIR, 'summary.json'), JSON.stringify({ problems: gen.problems, functions: gen.functions, osBindings: gen.osBindings, cFiles } satisfies Summary));
    if (gen.problems.length > 0) return;
    cache.store('generated-c', generatedKey, base.cDir, listTree(base.cDir), { functions: gen.functions, files: gen.files.length, cFiles, osBindings: gen.osBindings });
  }
  const assetsDir = join(base.distDir, 'assets');
  writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), assetsDir);

  const objects = await compileAll(base, runtimeSources());
  await link(base, objects);
  await linkVariant(base, '-O1', objects);

  const coverage = { ...base, objDir: join(COVERAGE_DIR, 'obj'), distDir: join(COVERAGE_DIR, 'dist'), coverage: true };
  const coverageObjects = await compileAll(coverage, runtimeSources());
  await link(coverage, coverageObjects);
  shareAssets(assetsDir, join(coverage.distDir, 'assets'));
}

/** Makes `to` read the assets of `from`, as a junction (no privilege needed on Windows), so that the 1,500 files are written once. */
function shareAssets(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  symlinkSync(from, to, 'junction');
}

export function loadCoverage(): { moduleUrl: string; dist: string } {
  const dist = join(COVERAGE_DIR, 'dist');
  if (!existsSync(join(dist, 'oot.js'))) throw new Error('the coverage build is missing: it is made by the global setup when OOT_ROM is set');
  return { moduleUrl: pathToFileURL(join(dist, 'oot.js')).href, dist };
}

export interface Base extends Summary {
  opts: BuildOptions;
  inventory: Inventory;
  moduleUrl: string;
  /** The objects of the build, for relinking at another level. */
  objects: () => Promise<CompiledObject[]>;
  cartridge: () => Uint8Array;
}

export function loadBase(): Base {
  if (!existsSync(join(BASE_DIR, 'summary.json'))) throw new Error('the shared game build is missing: it is made by the global setup when OOT_ROM is set');
  const opts = baseOptions();
  return {
    ...(JSON.parse(readFileSync(join(BASE_DIR, 'summary.json'), 'utf8')) as Summary),
    opts,
    inventory: JSON.parse(readFileSync(join(BASE_DIR, 'inventory.json'), 'utf8')) as Inventory,
    moduleUrl: pathToFileURL(join(opts.distDir, 'oot.js')).href,
    objects: () => compileAll(opts, runtimeSources()),
    cartridge: () => readCartridge(join(opts.distDir, 'assets')),
  };
}
