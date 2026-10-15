import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { generate } from '../recomp/generate.ts';
import { ensureToolchain } from '../recomp/toolchain.ts';
import { compileAll, link, runtimeSources } from './build.ts';

const rom = process.env.OOT_ROM;

describe.skipIf(!rom || !existsSync(rom))('whole ROM', () => {
  it('recompiles and compiles with no errors and no untranslated instructions', async () => {
    const work = resolve('out', 'port-test');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const cDir = join(work, 'c');
    const gen = generate(loadContext(rom!), inventory, cDir);
    expect(gen.problems).toEqual([]);
    expect(gen.functions).toBeGreaterThan(10_000);
    expect(gen.osBindings).toBeGreaterThan(100);

    for (const f of readdirSync(cDir).filter((n) => n.endsWith('.c'))) {
      expect(readFileSync(join(cDir, f), 'utf8'), f).not.toContain('rt_unimpl');
    }

    const opts = { cDir, objDir: join(work, 'obj'), distDir: join(work, 'dist'), toolchain: ensureToolchain(), log: () => {} };
    const objects = await compileAll(opts, runtimeSources());
    expect(objects.length).toBe(gen.files.filter((n) => n.endsWith('.c')).length + runtimeSources().length);
    const out = await link(opts, objects);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(work, 'dist', 'oot.wasm'))).toBe(true);
  }, 3_600_000);
});
