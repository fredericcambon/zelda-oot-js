import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packDir, romSha1, texDirs } from './location.ts';

const SHA1 = '328a1f1beba30ce5e178f031662019eb32c5f3b5';

describe('texture trial location', () => {
  let tmp: string;
  let dist: string;
  const saved = { cache: process.env.OOT_CACHE_DIR, pack: process.env.OOT_TEXPACK_DIR };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tex-location-'));
    dist = join(tmp, 'dist');
    process.env.OOT_CACHE_DIR = join(tmp, 'cache');
    delete process.env.OOT_TEXPACK_DIR;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [['OOT_CACHE_DIR', saved.cache], ['OOT_TEXPACK_DIR', saved.pack]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const record = (sha1: string) => {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'manifest.json'), JSON.stringify({ rom: { sha1 } }));
  };

  it('keys the folders by the ROM hash recorded in dist', () => {
    record(SHA1);
    expect(romSha1(dist)).toBe(SHA1);
    expect(texDirs(dist)).toEqual({ dump: join(tmp, 'cache', 'tex', SHA1, 'dump'), pack: join(tmp, 'cache', 'tex', SHA1, 'pack') });
  });

  it('guards the folder against an older cache: a readable manifest dated far ahead', () => {
    record(SHA1);
    const { dump } = texDirs(dist);
    const guard = join(dump, '..', 'entry.json');
    expect(statSync(guard).mtimeMs).toBeGreaterThan(Date.now() + 365 * 86_400_000);
  });

  it('has no folders without a recorded ROM', () => {
    expect(() => texDirs(dist)).toThrow(/npm run port/);
    record('not-a-hash');
    expect(romSha1(dist)).toBeUndefined();
    expect(packDir(dist)).toBeUndefined();
  });

  it('serves the pack folder once the trial folder exists, or OOT_TEXPACK_DIR', () => {
    record(SHA1);
    expect(packDir(dist)).toBeUndefined();
    mkdirSync(join(tmp, 'cache', 'tex', SHA1), { recursive: true });
    expect(packDir(dist)).toBe(join(tmp, 'cache', 'tex', SHA1, 'pack'));
    process.env.OOT_TEXPACK_DIR = join(tmp, 'elsewhere');
    expect(packDir(dist)).toBe(join(tmp, 'elsewhere'));
  });
});
