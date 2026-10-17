// `npm run port -- --rom <path>`: verify → extract → analyse → assets → recompile → Emscripten, ending in dist/.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../analyze/run.ts';
import { classify } from '../assets/classify.ts';
import { PACK_FILE } from '../assets/pack.ts';
import { buildManifest, writeAssets, writePack } from '../assets/write.ts';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
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
      optimize: { type: 'string', default: DEFAULT_OPTIMIZE },
      'trace-calls': { type: 'boolean', default: false },
      coverage: { type: 'boolean', default: false },
    },
  });
  const log = (m: string) => console.log(m);
  const stage = (n: number, name: string) => log(`\n[${n}/6] ${name}`);
  try {
    const romPath = romPathFromEnv(values.rom);

    stage(1, 'verify');
    const ctx = loadContext(romPath);
    log(`ROM verified (SHA-1 ${ctx.sha1}); ${ctx.files.length} files in the file table`);

    stage(2, 'analyse');
    const inventory = await analyze({
      romPath, outDir: values.out!, workDir: values.work!, useGhidra: !values['no-ghidra'], log,
    });

    stage(3, 'classify, write the assets and the pack');
    const manifest = buildManifest(ctx.sha1, ctx.rom.length, classify(ctx, inventory));
    const assetsDir = resolve(values.dist!, 'assets');
    writeAssets(ctx.rom, manifest, assetsDir);
    const unknown = manifest.entries.filter((e) => e.type === 'unknown').length;
    log(`wrote ${manifest.entries.length} assets to ${assetsDir} (${unknown} without a type, each with its reason in the manifest)`);
    // The entries tile the ROM (checked by buildManifest), so the cartridge image is the ROM itself.
    const packFile = resolve(values.dist!, PACK_FILE);
    await writePack(ctx.rom, packFile);
    log(`wrote ${packFile}`);

    stage(4, 'recompile');
    const cDir = resolve(values.generated!, 'c');
    const gen = generate(ctx, inventory, cDir);
    log(`recompiled ${gen.functions} functions into ${gen.files.length} files in ${cDir}`);
    if (gen.problems.length > 0) {
      for (const p of gen.problems.slice(0, 40)) console.error(`problem: ${p}`);
      throw new Error(`${gen.problems.length} problems while recompiling`);
    }

    stage(5, 'compile with Emscripten');
    const toolchain = ensureToolchain(log);
    const opts = {
      cDir, objDir: resolve(values.generated!, values['trace-calls'] ? 'obj-trace' : values.coverage ? 'obj-cov' : 'obj'), traceCalls: values['trace-calls'], coverage: values.coverage, distDir: resolve(values.dist!), toolchain, optimize: values.optimize, log,
    };
    const objects = await compileAll(opts, runtimeSources());

    stage(6, 'link');
    log(`wrote ${await link(opts, objects)}`);
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
