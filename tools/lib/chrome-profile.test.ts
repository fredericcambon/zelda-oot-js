import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeWithRetry, sweepProfiles, type FileOps } from './chrome-profile.ts';

const HOUR = 60 * 60 * 1000;
let temp: string;
let root: string;

const age = (path: string, ms: number) => utimesSync(path, new Date(Date.now() - ms), new Date(Date.now() - ms));
const profile = (parent: string, name: string, ageMs: number, marker = 'Default') => {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  if (marker === 'Local State') writeFileSync(join(dir, marker), '{}');
  else mkdirSync(join(dir, marker), { recursive: true });
  if (marker.includes('/')) age(join(dir, marker.split('/')[0]!), ageMs);
  age(join(dir, marker), ageMs);
  age(dir, ageMs);
  return dir;
};

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'chrome-profile-test-'));
  root = join(temp, 'oot-chrome-profiles');
  mkdirSync(root);
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe('sweepProfiles', () => {
  it('removes old profiles in the root and keeps recent ones', () => {
    const old = profile(root, 'shot-a', 2 * HOUR);
    const recent = profile(root, 'shot-b', 60_000);
    expect(sweepProfiles({ root, temp })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('removes old legacy profiles only for the listed prefixes', () => {
    const gone = [profile(temp, 'oot-chrome-1', 2 * HOUR), profile(temp, 'chr-2', 2 * HOUR, 'Local State'), profile(temp, 'oot-touch-3', 2 * HOUR, 'profile/Default')];
    const kept = [profile(temp, 'other-4', 2 * HOUR), profile(temp, 'oot-shot-5', 60_000)];
    sweepProfiles({ root, temp });
    for (const d of gone) expect(existsSync(d)).toBe(false);
    for (const d of kept) expect(existsSync(d)).toBe(true);
  });

  it('leaves folders that are not profiles alone', () => {
    const plain = join(temp, 'oot-chrome-plain');
    mkdirSync(plain);
    age(plain, 2 * HOUR);
    const file = join(temp, 'chr-file');
    writeFileSync(file, 'x');
    age(file, 2 * HOUR);
    sweepProfiles({ root, temp });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('logs one line when a folder cannot be removed', () => {
    profile(root, 'a', 2 * HOUR);
    profile(root, 'b', 2 * HOUR);
    const lines: string[] = [];
    const ops: FileOps = { remove: () => { throw new Error('EBUSY'); }, sleep: async () => {}, log: (l) => lines.push(l) };
    expect(sweepProfiles({ root, temp, ops })).toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe('removeWithRetry', () => {
  const fake = (failures: number) => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const lines: string[] = [];
    let left = failures;
    const ops: FileOps = {
      remove: (p) => {
        calls.push(p);
        if (left-- > 0) throw new Error('EBUSY: resource busy or locked');
      },
      sleep: async (ms) => void sleeps.push(ms),
      log: (l) => lines.push(l),
    };
    return { ops, calls, sleeps, lines };
  };

  it('retries with growing pauses until the folder goes', async () => {
    const f = fake(2);
    expect(await removeWithRetry('p', { tries: 5, delayMs: 100, ops: f.ops })).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(f.sleeps).toEqual([100, 200]);
    expect(f.lines).toEqual([]);
  });

  it('logs one line after the last try fails', async () => {
    const f = fake(99);
    expect(await removeWithRetry('p', { tries: 5, delayMs: 100, ops: f.ops })).toBe(false);
    expect(f.calls).toHaveLength(5);
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain('EBUSY');
  });
});
