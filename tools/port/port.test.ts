import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { generate } from '../recomp/generate.ts';
import { listTree } from './cache.ts';
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

  it('serves a second port into fresh folders entirely from the shared cache, byte for byte, in under a minute', () => {
    const base = resolve('out', 'port-cache-test');
    rmSync(base, { recursive: true, force: true });
    const port = (run: string) => {
      const dirs = ['out', 'work', 'generated', 'dist'].map((d) => join(base, run, d));
      const t0 = performance.now();
      const r = spawnSync('npx', ['tsx', 'tools/port/cli.ts', '--no-ghidra', '--out', dirs[0]!, '--work', dirs[1]!, '--generated', dirs[2]!, '--dist', dirs[3]!], {
        encoding: 'utf8', shell: true, env: { ...process.env, OOT_CACHE_DIR: join(base, 'cache') }, maxBuffer: 1 << 28,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return { dist: dirs[3]!, log: r.stdout, seconds: (performance.now() - t0) / 1000 };
    };
    const first = port('first');
    expect(first.log).toContain('cache miss');
    const second = port('second');
    expect(second.log).not.toContain('cache miss');
    for (const step of ['analyse', 'classify, write the assets and the pack', 'recompile']) expect(second.log, step).toContain(`${step}: cache hit`);
    expect(second.log).toMatch(/compiling 0 of \d+ C files \(0 up to date, \d+ from the cache\)/);
    expect(second.log).toContain('link: cache hit');
    expect(second.seconds).toBeLessThan(60);

    const files = listTree(first.dist);
    expect(files.length).toBeGreaterThan(1000);
    expect(listTree(second.dist)).toEqual(files);
    for (const f of files) expect(readFileSync(join(second.dist, f)).equals(readFileSync(join(first.dist, f))), f).toBe(true);
  }, 3_600_000);
});
