// `npm run port -- --rom <path>`: verify → extract → analyse → recompile → Emscripten, ending in dist/.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../analyze/run.ts';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain, repoRoot } from '../recomp/toolchain.ts';
import { extractRom } from '../rom/extract.ts';
import { compileAll, link } from './build.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rom: { type: 'string' },
      out: { type: 'string', default: 'out' },
      work: { type: 'string', default: 'rea-work' },
      generated: { type: 'string', default: 'generated' },
      dist: { type: 'string', default: 'dist' },
      'no-ghidra': { type: 'boolean', default: false },
      optimize: { type: 'string', default: '-O1' },
    },
  });
  const log = (m: string) => console.log(m);
  const stage = (n: number, name: string) => log(`\n[${n}/5] ${name}`);
  try {
    const romPath = romPathFromEnv(values.rom);

    stage(1, 'verify and extract');
    const index = extractRom(readFileSync(romPath), values.out!);
    log(`ROM verified (SHA-1 ${index.sha1}); wrote ${index.files.length} files to ${values.out}`);

    stage(2, 'analyse');
    const inventory = await analyze({
      romPath, outDir: values.out!, workDir: values.work!, useGhidra: !values['no-ghidra'], log,
    });

    stage(3, 'recompile');
    const ctx = loadContext(romPath);
    const cDir = resolve(values.generated!, 'c');
    const gen = generate(ctx, inventory, cDir);
    log(`recompiled ${gen.functions} functions into ${gen.files.length} files in ${cDir}`);
    if (gen.problems.length > 0) {
      for (const p of gen.problems.slice(0, 40)) console.error(`problem: ${p}`);
      throw new Error(`${gen.problems.length} problems while recompiling`);
    }

    stage(4, 'compile with Emscripten');
    const toolchain = ensureToolchain(log);
    const opts = {
      cDir, objDir: resolve(values.generated!, 'obj'), distDir: resolve(values.dist!), toolchain, optimize: values.optimize, log,
    };
    const objects = await compileAll(opts, [join(repoRoot, 'runtime', 'stub.c')]);

    stage(5, 'link');
    log(`wrote ${await link(opts, objects)}`);
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
