// `npm run port -- --rom <path>`: verify → extract → analyse → assets → recompile → Emscripten, ending in dist/. Every step is served from the shared build cache (cache.ts) when its inputs are unchanged.
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../analyze/run.ts';
import { classify } from '../assets/classify.ts';
import { PACK_FILE } from '../assets/pack.ts';
import { buildManifest, writeAssets, writePack } from '../assets/write.ts';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import type { Inventory } from '../analyze/types.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { Cache, defaultCacheDir, defaultMaxBytes, hashKey, listTree, sourceHash } from './cache.ts';
import { compileAll, DEFAULT_OPTIMIZE, link, runtimeSources } from './build.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rom: { type: 'string' },
      out: { type: 'string', default: 'out' },
      work: { type: 'string', default: 'rea-work' },
      generated: { type: 'string', default: 'generated' },
      dist: { type: 'string', default: 'dist' },
      'no-ghidra': { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      optimize: { type: 'string', default: DEFAULT_OPTIMIZE },
      'trace-calls': { type: 'boolean', default: false },
      coverage: { type: 'boolean', default: false },
    },
  });
  const log = (m: string) => console.log(m);
  const cache = values['no-cache'] ? undefined : new Cache(defaultCacheDir(), defaultMaxBytes());
  const total = 6;
  const step = async (n: number, name: string, run: () => Promise<string | void> | string | void) => {
    log(`\n[${n}/${total}] ${name}`);
    const t0 = performance.now();
    const note = await run();
    log(`[${n}/${total}] ${name}: ${note ? `${note}, ` : ''}${((performance.now() - t0) / 1000).toFixed(1)} s`);
  };
  const outcome = (hit: boolean) => (cache ? (hit ? 'cache hit' : 'cache miss') : 'cache off');
  try {
    log(cache ? `build cache: ${cache.dir} (up to ${(cache.maxBytes / 1024 ** 3).toFixed(1)} GB)` : 'build cache: off');
    const romPath = romPathFromEnv(values.rom);

    let ctx!: ReturnType<typeof loadContext>;
    await step(1, 'verify', () => {
      ctx = loadContext(romPath);
      log(`ROM verified (SHA-1 ${ctx.sha1}); ${ctx.files.length} files in the file table`);
    });

    const outDir = resolve(values.out!);
    const useGhidra = !values['no-ghidra'];
    const analysisKey = hashKey('analysis', ctx.sha1, sourceHash(['tools/analyze/run.ts'], ['data', 'tools/analyze/ghidra']), useGhidra ? 'ghidra' : 'own-discovery-only');
    let inventory!: Inventory;
    await step(2, 'analyse', async () => {
      if (cache?.restore('analysis', analysisKey, outDir)) {
        inventory = JSON.parse(readFileSync(join(outDir, 'inventory.json'), 'utf8')) as Inventory;
        return outcome(true);
      }
      inventory = await analyze({ romPath, outDir, workDir: values.work!, useGhidra, log });
      cache?.store('analysis', analysisKey, outDir, ['inventory.json', ...listTree(join(outDir, 'elf')).map((f) => `elf/${f}`)]);
      return outcome(false);
    });

    await step(3, 'classify, write the assets and the pack', async () => {
      const assetsDir = resolve(values.dist!, 'assets');
      const key = hashKey('assets', analysisKey, sourceHash(['tools/assets/classify.ts', 'tools/assets/write.ts']));
      rmSync(assetsDir, { recursive: true, force: true });
      let hit = true;
      if (!cache?.restore('assets', key, assetsDir)) {
        hit = false;
        const manifest = buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory));
        writeAssets(ctx.rom, manifest, assetsDir);
        cache?.store('assets', key, assetsDir, listTree(assetsDir));
      }
      const manifest = JSON.parse(readFileSync(join(assetsDir, 'manifest.json'), 'utf8')) as { entries: { type: string }[] };
      const unknown = manifest.entries.filter((e) => e.type === 'unknown').length;
      log(`wrote ${manifest.entries.length} assets to ${assetsDir} (${unknown} without a type, each with its reason in the manifest)`);
      // The entries tile the ROM (checked by buildManifest), so the cartridge image is the ROM itself.
      await writePack(ctx.rom, resolve(values.dist!, PACK_FILE));
      return outcome(hit);
    });

    const cDir = resolve(values.generated!, 'c');
    await step(4, 'recompile', () => {
      const key = hashKey('generated-c', analysisKey, sourceHash(['tools/recomp/generate.ts'], ['data']));
      rmSync(cDir, { recursive: true, force: true });
      const hit = cache?.restore('generated-c', key, cDir);
      if (hit) {
        const m = hit.meta as { functions: number; files: number };
        log(`recompiled ${m.functions} functions into ${m.files} files in ${cDir}`);
        return outcome(true);
      }
      const gen = generate(ctx, inventory, cDir);
      log(`recompiled ${gen.functions} functions into ${gen.files.length} files in ${cDir}`);
      if (gen.problems.length > 0) {
        for (const p of gen.problems.slice(0, 40)) console.error(`problem: ${p}`);
        throw new Error(`${gen.problems.length} problems while recompiling`);
      }
      cache?.store('generated-c', key, cDir, listTree(cDir), { functions: gen.functions, files: gen.files.length });
      return outcome(false);
    });

    const toolchain = ensureToolchain(log);
    const opts = {
      cDir, objDir: resolve(values.generated!, values['trace-calls'] ? 'obj-trace' : values.coverage ? 'obj-cov' : 'obj'), traceCalls: values['trace-calls'], coverage: values.coverage, distDir: resolve(values.dist!), toolchain, optimize: values.optimize, cache, log,
    };
    let objects: Awaited<ReturnType<typeof compileAll>> = [];
    await step(5, 'compile with Emscripten', async () => {
      objects = await compileAll(opts, runtimeSources());
    });

    await step(6, 'link', async () => {
      log(`wrote ${await link(opts, objects)}`);
    });
    if (cache) {
      const evicted = cache.evict();
      if (evicted > 0) log(`build cache: evicted ${evicted} least recently used entries`);
    }
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
