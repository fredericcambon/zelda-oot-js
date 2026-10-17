// The one -O2 build of the game that the ROM-gated suites share. global-setup.ts builds it before any test file runs; the
// suites read it back with loadBase().
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Analyses, recompiles, compiles and links the game, with the assets next to it; whatever is up to date or cached is reused. */
export async function buildBase(rom: string, log: (msg: string) => void): Promise<void> {
  const inventory = await analyze({ romPath: rom, outDir: BASE_DIR, workDir: join(BASE_DIR, 'work'), useGhidra: false });
  const ctx = loadContext(rom);
  const opts = { ...baseOptions(), log };
  const gen = generate(ctx, inventory, opts.cDir);
  const summary: Summary = { problems: gen.problems, functions: gen.functions, osBindings: gen.osBindings, cFiles: gen.files.filter((n) => n.endsWith('.c')).length };
  writeFileSync(join(BASE_DIR, 'summary.json'), JSON.stringify(summary));
  if (gen.problems.length > 0) return;
  await link(opts, await compileAll(opts, runtimeSources()));
  writeAssets(ctx.rom, buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory)), join(opts.distDir, 'assets'));
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
