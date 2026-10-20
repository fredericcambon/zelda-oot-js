import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { syncSite } from './sync.ts';

let temp: string;
let site: string;
let dest: string;
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'pages-sync-test-'));
  site = join(temp, 'site');
  dest = join(temp, 'dest');
  mkdirSync(site);
  mkdirSync(join(dest, '.git'), { recursive: true });
  writeFileSync(join(dest, '.git', 'HEAD'), 'ref');
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

it('copies new and changed files, skips unchanged ones, deletes removed ones', async () => {
  put(site, 'index.html', 'page v1');
  put(site, 'a/same.bin', 'same');
  put(site, 'a/swap.bin', 'aaaa');
  put(dest, 'a/same.bin', 'same');
  put(dest, 'a/swap.bin', 'bbbb'); // same size, other content
  put(dest, 'old/gone.png', 'gone');
  const result = await syncSite(site, dest);
  expect(result.written.sort()).toEqual(['a/swap.bin', 'index.html']);
  expect(result.deleted).toEqual(['old/gone.png']);
  expect(result.bytes).toBe('page v1'.length + 4);
  expect(readFileSync(join(dest, 'a/swap.bin'), 'utf8')).toBe('aaaa');
  expect(existsSync(join(dest, 'old'))).toBe(false);
  expect(readFileSync(join(dest, '.git', 'HEAD'), 'utf8')).toBe('ref');

  const again = await syncSite(site, dest);
  expect(again).toEqual({ written: [], deleted: [], bytes: 0 });
});
