// The analysis pipeline: layout → ELF images → Ghidra → our discovery → OS identification → inventory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wrapAll } from '../elf-wrap/wrap.ts';
import { loadContext } from './context.ts';
import { ghidraInstalled, runGhidra, type GhidraFacts } from './ghidra.ts';
import { analyseImage, buildSpecs } from './image.ts';
import { identifyOs } from './os.ts';
import { GHIDRA_VERSION, setup } from './setup.mjs';
import type { Inventory, InvImage } from './types.ts';

/** Leaves the file untouched when its bytes are unchanged, so its modification time keeps meaning "input changed". */
function writeIfChanged(path: string, data: Uint8Array | string): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  writeFileSync(path, bytes);
}

export interface AnalyzeOptions {
  romPath: string;
  outDir: string;
  workDir: string;
  useGhidra: boolean;
  forceGhidra?: boolean;
  shards?: number;
  log?: (msg: string) => void;
}

export async function analyze(opts: AnalyzeOptions): Promise<Inventory> {
  const log = opts.log ?? (() => {});
  const ctx = loadContext(opts.romPath);
  log(`ROM verified (SHA-1 ${ctx.sha1}); ${ctx.layout.overlays.length} overlays located`);

  const elfDir = join(opts.outDir, 'elf');
  mkdirSync(join(elfDir, 'plain'), { recursive: true });
  for (const img of wrapAll(ctx.rom, ctx.files, ctx.layout)) {
    writeIfChanged(join(elfDir, `${img.name}.elf`), img.elf);
    writeIfChanged(join(elfDir, 'plain', `${img.name}.elf`), img.elfPlain);
  }
  writeFileSync(join(elfDir, 'layout.json'), JSON.stringify(ctx.layout, null, 2) + '\n');

  const specs = buildSpecs(ctx);
  const ghidraOut = join(opts.workDir, 'ghidra', 'facts');
  const facts = new Map<string, GhidraFacts>();
  if (opts.useGhidra) {
    if (!ghidraInstalled()) {
      log('fetching Ghidra and a JDK into .tools/');
      await setup();
    }
    // Seed Ghidra with the entry points our own evidence supports; the rest is left to its analyzers.
    const seedsDir = join(opts.workDir, 'ghidra', 'seeds');
    mkdirSync(seedsDir, { recursive: true });
    for (const spec of specs) {
      const pass1 = analyseImage(spec);
      const seeds = pass1.functions.filter((f) => f.sources.some((s) => s !== 'gap' && s !== 'jal')).map((f) => f.start.toString(16));
      writeFileSync(join(seedsDir, `${spec.name}.seeds`), seeds.join('\n') + '\n');
    }
    log(`running Ghidra headless on ${specs.length} images`);
    const n = await runGhidra({
      elfDir: join(elfDir, 'plain'), seedsDir, outDir: ghidraOut, workDir: join(opts.workDir, 'ghidra'),
      shards: opts.shards, force: opts.forceGhidra, onLog: (l) => log(l),
    });
    log(`Ghidra analysed ${n} images`);
    for (const spec of specs) {
      const p = join(ghidraOut, `${spec.name}.json`);
      if (existsSync(p)) facts.set(spec.name, JSON.parse(readFileSync(p, 'utf8')) as GhidraFacts);
    }
  }

  const images: InvImage[] = specs.map((spec) => analyseImage(spec, { ghidra: facts.get(spec.name) ?? null }));
  const os = identifyOs(ctx, specs, images);
  const inventory: Inventory = {
    version: 1,
    rom: { sha1: ctx.sha1 },
    tool: opts.useGhidra ? { name: 'ghidra', version: GHIDRA_VERSION } : { name: 'own-discovery-only', version: '1' },
    layout: ctx.layout,
    images,
    os,
  };
  writeFileSync(join(opts.outDir, 'inventory.json'), JSON.stringify(inventory));
  log(`wrote ${join(opts.outDir, 'inventory.json')}`);
  return inventory;
}
