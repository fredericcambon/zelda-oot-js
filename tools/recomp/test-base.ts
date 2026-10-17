// The one -O2 build of the game that the ROM-gated suites share. global-setup.ts builds it before any test file runs; the
// suites read it back with loadBase().
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import type { Inventory } from '../analyze/types.ts';
import { classify } from '../assets/classify.ts';
import { buildManifest, readCartridge, writeAssets } from '../assets/write.ts';
import { Cache, defaultCacheDir, defaultMaxBytes } from '../port/cache.ts';
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
 * Analyses and recompiles the game, then compiles and links the -O2 build and the -DOOT_COVERAGE build (for the sweep suite) side
 * by side, each with its assets, so that one link overlaps the other's compiles; the objects of the -O2 build are also linked
 * at -O1 for the cross-build state test. Whatever is up to date or cached is reused.
 */
export async function buildGames(rom: string, log: (msg: string) => void): Promise<void> {
  const inventory = await analyze({ romPath: rom, outDir: BASE_DIR, workDir: join(BASE_DIR, 'work'), useGhidra: false });
  const ctx = loadContext(rom);
  const base = { ...baseOptions(), log };
  const gen = generate(ctx, inventory, base.cDir);
  const summary: Summary = { problems: gen.problems, functions: gen.functions, osBindings: gen.osBindings, cFiles: gen.files.filter((n) => n.endsWith('.c')).length };
  writeFileSync(join(BASE_DIR, 'summary.json'), JSON.stringify(summary));
  if (gen.problems.length > 0) return;
  const coverage = { ...base, objDir: join(COVERAGE_DIR, 'obj'), distDir: join(COVERAGE_DIR, 'dist'), coverage: true };
  await Promise.all([base, coverage].map(async (opts) => {
    const objects = await compileAll(opts, runtimeSources());
    const extra = opts === base ? [linkVariant(opts, '-O1', objects)] : [];
    await Promise.all([link(opts, objects), ...extra]);
    writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), join(opts.distDir, 'assets'));
  }));
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
