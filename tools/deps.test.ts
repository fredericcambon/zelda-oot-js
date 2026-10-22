import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module without declarations
import { isComplete, junction, lockHash, pruneUnused } from './deps.mjs';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oot-deps-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lockHash', () => {
  it('is the sha256 of the lock file and changes with it', () => {
    const lock = join(root, 'package-lock.json');
    writeFileSync(lock, 'abc');
    expect(lockHash(lock)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    writeFileSync(lock, 'abd');
    expect(lockHash(lock)).not.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('junction', () => {
  const target = () => {
    const t = join(root, 'shared', 'node_modules');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'marker'), 'x');
    return t;
  };

  it('links a missing node_modules, and is a no-op the second time', () => {
    const link = join(root, 'wt', 'node_modules');
    mkdirSync(join(root, 'wt'));
    expect(junction(link, target())).toBe('linked');
    expect(readFileSync(join(link, 'marker'), 'utf8')).toBe('x');
    expect(junction(link, target())).toBe('unchanged');
  });

  it('replaces an empty folder', () => {
    const link = join(root, 'node_modules');
    mkdirSync(link);
    expect(junction(link, target())).toBe('linked');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('repoints a junction that leads elsewhere', () => {
    const link = join(root, 'node_modules');
    const other = join(root, 'other');
    mkdirSync(other);
    junction(link, other);
    expect(junction(link, target())).toBe('linked');
    expect(realpathSync(link)).toBe(realpathSync(target()));
  });

  it('leaves a real folder with content alone', () => {
    const link = join(root, 'node_modules');
    mkdirSync(link);
    writeFileSync(join(link, 'mine'), 'y');
    expect(junction(link, target())).toBe('kept');
    expect(existsSync(join(link, 'mine'))).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });
});

describe('isComplete', () => {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const bins = ['tsx', 'vite'];
  const fake = (count: number, binNames = bins, marker = String(count)) => {
    const dir = join(root, 'install');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    for (let i = 1; i < count; i++) mkdirSync(join(dir, 'node_modules', `p${i}`));
    for (const b of binNames) writeFileSync(join(dir, 'node_modules', '.bin', b + ext), '');
    writeFileSync(join(dir, 'ready'), marker);
    return dir;
  };

  it('accepts an install with its stored count and tools', () => {
    expect(isComplete(fake(5), bins)).toBe(true);
  });

  it('rejects a missing install, an empty marker and a missing .bin tool', () => {
    expect(isComplete(join(root, 'none'), bins)).toBe(false);
    expect(isComplete(fake(5, bins, ''), bins)).toBe(false);
    expect(isComplete(fake(5, ['tsx']), bins)).toBe(false);
  });

  it('rejects an install that lost top-level packages', () => {
    const dir = fake(5);
    rmSync(join(dir, 'node_modules', 'p1'), { recursive: true });
    rmSync(join(dir, 'node_modules', 'p2'), { recursive: true });
    expect(isComplete(dir, bins)).toBe(false);
  });
});

describe('pruneUnused', () => {
  it('removes old ready hash folders except the current one, and nothing else', () => {
    const day = 86_400;
    const old = Date.now() / 1000 - 15 * day;
    const [old_, cur, fresh, foreign, bare] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(64)) as [string, string, string, string, string];
    for (const n of [old_, cur, fresh, foreign, bare]) mkdirSync(join(root, n));
    for (const n of [old_, cur, fresh]) writeFileSync(join(root, n, 'ready'), '');
    mkdirSync(join(root, 'notes'));
    for (const n of [old_, cur, foreign, bare, 'notes']) utimesSync(join(root, n), old, old);
    expect(pruneUnused(root, cur)).toEqual([old_]);
    for (const n of [cur, fresh, foreign, bare, 'notes']) expect(existsSync(join(root, n))).toBe(true);
    expect(existsSync(join(root, old_))).toBe(false);
  });
});
