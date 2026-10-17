import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkKey, planObjects, type BuildOptions } from './build.ts';
import { Cache, defaultMaxBytes, hashKey, sourceHash } from './cache.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oot-cache-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, text: string) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
};

// Rewrites a file and moves its modification time, which is how a changed input is told from a remembered hash.
let clock = 1_700_000_000;
const edit = (rel: string, text: string) => {
  const path = put(rel, text);
  utimesSync(path, ++clock, clock);
};

describe('hashKey', () => {
  it('changes with any part and does not confuse where parts split', () => {
    expect(hashKey('a', 'b')).toBe(hashKey('a', 'b'));
    expect(hashKey('a', 'b')).not.toBe(hashKey('a', 'c'));
    expect(hashKey('ab', 'c')).not.toBe(hashKey('a', 'bc'));
  });
});

describe('sourceHash', () => {
  it('changes when an imported module or a data file changes, not when an unrelated file does', () => {
    const entry = put('t/main.ts', "import { x } from './dep.ts';\nexport const y = x;\n");
    put('t/dep.ts', 'export const x = 1;\n');
    put('t/other.ts', 'export const z = 1;\n');
    put('d/data.json', '{}');
    const base = () => sourceHash([entry], [join(root, 'd')]);
    const before = base();
    expect(base()).toBe(before);

    edit('t/other.ts', 'export const z = 2;\n');
    expect(base()).toBe(before);

    edit('t/dep.ts', 'export const x = 2;\n');
    const afterDep = base();
    expect(afterDep).not.toBe(before);

    edit('d/data.json', '{"a":1}');
    expect(base()).not.toBe(afterDep);
  });
});

describe('object and link keys', () => {
  const opts = (extra: Partial<BuildOptions> = {}): BuildOptions => ({
    cDir: join(root, 'c'), objDir: join(root, 'obj'), distDir: join(root, 'dist'), toolchain: { python: '', emcc: '', env: {} }, log: () => {}, ...extra,
  });
  const keys = (o: BuildOptions, version = '1.0') => Object.fromEntries(planObjects(o, [], version).map((j) => [j.name, j.key]));

  it('changes when a source, an included header, a flag or the emsdk version changes', () => {
    put('c/a.c', '#include "gen.h"\nint a;\n');
    put('c/b.c', 'int b;\n');
    put('c/gen.h', '#include "deep.h"\n');
    put('c/deep.h', '#define X 1\n');
    const base = keys(opts());
    expect(keys(opts())).toEqual(base);

    expect(keys(opts({ optimize: '-O1' }))['b-gen.o']).not.toBe(base['b-gen.o']);
    expect(keys(opts({ traceCalls: true }))['b-gen.o']).not.toBe(base['b-gen.o']);
    expect(keys(opts({ coverage: true }))['b-gen.o']).not.toBe(base['b-gen.o']);
    expect(keys(opts(), '2.0')['b-gen.o']).not.toBe(base['b-gen.o']);

    edit('c/b.c', 'int b2;\n');
    const source = keys(opts());
    expect(source['a-gen.o']).toBe(base['a-gen.o']);
    expect(source['b-gen.o']).not.toBe(base['b-gen.o']);

    // The header is included only through another header.
    edit('c/deep.h', '#define X 2\n');
    const header = keys(opts());
    expect(header['a-gen.o']).not.toBe(source['a-gen.o']);
    expect(header['b-gen.o']).toBe(source['b-gen.o']);
  });

  it('changes the key of an object when a header included with angle brackets changes', () => {
    put('c/a.c', '#include <hdr.h>\nint a;\n');
    put('c/hdr.h', '#define X 1\n');
    const before = keys(opts())['a-gen.o'];
    edit('c/hdr.h', '#define X 2\n');
    expect(keys(opts())['a-gen.o']).not.toBe(before);
  });

  it('gives two links that differ only in the bytes of an object different keys', () => {
    const obj = put('obj/a.o', 'one');
    const objects = [{ path: obj, key: 'same' }];
    const before = linkKey('1.0', '-O2', objects);
    edit('obj/a.o', 'two');
    expect(linkKey('1.0', '-O2', objects)).not.toBe(before);
  });

  it('gives the link a key that follows every object, the flags and the emsdk version', () => {
    const objects = [{ path: 'a.o', key: 'k1' }, { path: 'b.o', key: 'k2' }];
    const base = linkKey('1.0', '-O2', objects);
    expect(linkKey('1.0', '-O2', [objects[0]!, { path: 'b.o', key: 'k3' }])).not.toBe(base);
    expect(linkKey('1.0', '-O1', objects)).not.toBe(base);
    expect(linkKey('2.0', '-O2', objects)).not.toBe(base);
    expect(linkKey('1.0', '-O2', [...objects].reverse())).not.toBe(base);
  });
});

describe('Cache', () => {
  const cache = () => new Cache(join(root, 'cache'), 1 << 30);

  it('restores what was stored, with its metadata', () => {
    put('src/a/x.bin', 'hello');
    put('src/y.bin', 'world');
    const c = cache();
    expect(c.store('kind', 'k', join(root, 'src'), ['a/x.bin', 'y.bin'], { n: 2 })).toBe(true);
    const hit = c.restore('kind', 'k', join(root, 'dest'));
    expect(hit?.meta).toEqual({ n: 2 });
    expect(readFileSync(join(root, 'dest/a/x.bin'), 'utf8')).toBe('hello');
    expect(readFileSync(join(root, 'dest/y.bin'), 'utf8')).toBe('world');
    expect(c.restore('kind', 'other', join(root, 'dest2'))).toBeUndefined();
  });

  it('writes an entry under its final name in one step and leaves no temporary files', () => {
    put('src/x.bin', 'data');
    const c = cache();
    c.store('kind', 'k', join(root, 'src'), ['x.bin']);
    expect(readdirSync(join(root, 'cache', 'kind'))).toEqual(['k']);
    expect(readdirSync(join(root, 'cache', 'tmp'))).toEqual([]);
    // A second store of the same key (another worktree got there first) keeps the first entry.
    put('src/x.bin', 'data2');
    expect(c.store('kind', 'k', join(root, 'src'), ['x.bin'])).toBe(true);
    expect(readdirSync(join(root, 'cache', 'tmp'))).toEqual([]);
    expect(c.restore('kind', 'k', join(root, 'dest'))).toBeDefined();
    expect(readFileSync(join(root, 'dest/x.bin'), 'utf8')).toBe('data');
  });

  it('never exposes a half-written entry', () => {
    put('src/x.bin', 'data');
    const c = cache();
    expect(c.store('kind', 'k', join(root, 'src'), ['x.bin', 'missing.bin'])).toBe(false);
    expect(existsSync(join(root, 'cache', 'kind', 'k'))).toBe(false);
    expect(c.restore('kind', 'k', join(root, 'dest'))).toBeUndefined();
  });

  it('treats a file the caller rejects as a miss, writes nothing and removes the entry', () => {
    put('src/oot.js', 'js');
    put('src/oot.wasm', 'not wasm');
    const c = cache();
    c.store('link', 'k', join(root, 'src'), ['oot.js', 'oot.wasm']);
    expect(c.restore('link', 'k', join(root, 'dest'), (p) => p !== 'oot.wasm')).toBeUndefined();
    expect(existsSync(join(root, 'dest', 'oot.js'))).toBe(false);
    expect(existsSync(join(root, 'cache', 'link', 'k'))).toBe(false);
  });

  it('keeps a sound entry when the destination cannot be written', () => {
    put('src/x.bin', 'data');
    put('dest', 'a file where a folder is needed');
    const c = cache();
    c.store('kind', 'k', join(root, 'src'), ['x.bin']);
    expect(c.restore('kind', 'k', join(root, 'dest'))).toBeUndefined();
    expect(existsSync(join(root, 'cache', 'kind', 'k'))).toBe(true);
  });

  it.each([
    ['a changed file', (dir: string) => writeFileSync(join(dir, 'x.bin'), 'dat4')],
    ['a truncated file', (dir: string) => writeFileSync(join(dir, 'x.bin'), 'da')],
    ['a missing file', (dir: string) => rmSync(join(dir, 'x.bin'))],
    ['an unreadable manifest', (dir: string) => writeFileSync(join(dir, 'entry.json'), '{not json')],
    ['a missing manifest', (dir: string) => rmSync(join(dir, 'entry.json'))],
  ])('treats %s as a miss and removes the entry', (_name, damage) => {
    put('src/x.bin', 'data');
    const c = cache();
    c.store('kind', 'k', join(root, 'src'), ['x.bin']);
    damage(join(root, 'cache', 'kind', 'k'));
    expect(c.restore('kind', 'k', join(root, 'dest'))).toBeUndefined();
    expect(existsSync(join(root, 'cache', 'kind', 'k'))).toBe(false);
    expect(c.store('kind', 'k', join(root, 'src'), ['x.bin'])).toBe(true);
    expect(c.restore('kind', 'k', join(root, 'dest'))).toBeDefined();
  });

  it('evicts the least recently used entries until the cache fits its cap', () => {
    put('src/x.bin', 'x'.repeat(100));
    const c = new Cache(join(root, 'cache'), 250);
    for (const k of ['old', 'mid', 'new']) c.store('kind', k, join(root, 'src'), ['x.bin']);
    const age = (k: string, secs: number) => {
      const t = new Date(Date.now() - secs * 1000);
      utimesSync(join(root, 'cache', 'kind', k, 'entry.json'), t, t);
    };
    age('old', 300);
    age('mid', 200);
    age('new', 100);
    // Restoring the oldest entry makes it the most recently used.
    expect(c.restore('kind', 'old', join(root, 'dest'))).toBeDefined();
    expect(c.evict()).toBe(1);
    expect(readdirSync(join(root, 'cache', 'kind')).sort()).toEqual(['new', 'old']);
    expect(c.evict()).toBe(0);
  });

  it('reads the cap from OOT_CACHE_MAX_GB, defaulting to 10 GB', () => {
    const saved = process.env.OOT_CACHE_MAX_GB;
    try {
      delete process.env.OOT_CACHE_MAX_GB;
      expect(defaultMaxBytes()).toBe(10 * 1024 ** 3);
      process.env.OOT_CACHE_MAX_GB = '0.5';
      expect(defaultMaxBytes()).toBe(0.5 * 1024 ** 3);
      process.env.OOT_CACHE_MAX_GB = 'nonsense';
      expect(defaultMaxBytes()).toBe(10 * 1024 ** 3);
    } finally {
      if (saved === undefined) delete process.env.OOT_CACHE_MAX_GB;
      else process.env.OOT_CACHE_MAX_GB = saved;
    }
  });
});
