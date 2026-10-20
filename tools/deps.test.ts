import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module without declarations
import { junction, lockHash, pruneUnused } from './deps.mjs';

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

describe('pruneUnused', () => {
  it('removes old hash folders except the current one', () => {
    const day = 86_400;
    const old = Date.now() / 1000 - 15 * day;
    for (const n of ['old', 'cur', 'new']) mkdirSync(join(root, n));
    utimesSync(join(root, 'old'), old, old);
    utimesSync(join(root, 'cur'), old, old);
    expect(pruneUnused(root, 'cur')).toEqual(['old']);
    expect(existsSync(join(root, 'cur'))).toBe(true);
    expect(existsSync(join(root, 'new'))).toBe(true);
    expect(existsSync(join(root, 'old'))).toBe(false);
  });
});
