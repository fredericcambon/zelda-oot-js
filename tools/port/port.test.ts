import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTree } from './cache.ts';
import { loadBase } from '../recomp/test-base.ts';
import { runtimeSources } from './build.ts';

const rom = process.env.OOT_ROM;

describe.skipIf(!rom || !existsSync(rom))('whole ROM', () => {
  it('recompiles and compiles with no errors and no untranslated instructions', async () => {
    const base = loadBase();
    expect(base.problems).toEqual([]);
    expect(base.functions).toBeGreaterThan(10_000);
    expect(base.osBindings).toBeGreaterThan(100);

    const cDir = base.opts.cDir;
    for (const f of readdirSync(cDir).filter((n) => n.endsWith('.c'))) {
      expect(readFileSync(join(cDir, f), 'utf8'), f).not.toContain('rt_unimpl');
    }

    const objects = await base.objects();
    expect(objects.length).toBe(base.cFiles + runtimeSources().length);
    expect(existsSync(join(base.opts.distDir, 'oot.js'))).toBe(true);
    expect(existsSync(join(base.opts.distDir, 'oot.wasm'))).toBe(true);
  }, 3_600_000);

  it('serves a second port into fresh folders entirely from the shared cache, byte for byte, in under a minute', () => {
    const base = resolve('out', 'port-cache-test');
    rmSync(base, { recursive: true, force: true });
    // Both runs use the machine's shared cache, which the shared game build has already filled with the objects and the link.
    const port = (run: string) => {
      const dirs = ['out', 'work', 'generated', 'dist'].map((d) => join(base, run, d));
      const t0 = performance.now();
      const r = spawnSync('npx', ['tsx', 'tools/port/cli.ts', '--no-ghidra', '--out', dirs[0]!, '--work', dirs[1]!, '--generated', dirs[2]!, '--dist', dirs[3]!], {
        encoding: 'utf8', shell: true, env: process.env, maxBuffer: 1 << 28,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return { dist: dirs[3]!, log: r.stdout, seconds: (performance.now() - t0) / 1000 };
    };
    const first = port('first');
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
