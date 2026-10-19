// Where the texture trial keeps its files: `<cache>/tex/<ROM SHA-1>/{dump,pack,texpack-work}` in the shared cache (tools/port/cache.ts), so a deleted
// worktree takes nothing with it. The ROM's SHA-1 is the one `npm run port` recorded in `<dist>/assets/manifest.json`.
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheDir } from '../port/cache.ts';

export function romSha1(dist: string): string | undefined {
  try {
    const sha1 = (JSON.parse(readFileSync(join(dist, 'assets', 'manifest.json'), 'utf8')) as { rom?: { sha1?: string } }).rom?.sha1;
    return sha1 && /^[0-9a-f]{40}$/.test(sha1) ? sha1 : undefined;
  } catch {
    return undefined;
  }
}

/** The folder of this ROM's trial files; without a built `dist` there is no ROM to key it by. */
export function texRoot(dist: string): string | undefined {
  const sha1 = romSha1(dist);
  return sha1 && join(defaultCacheDir(), 'tex', sha1);
}

export function texDirs(dist: string): { dump: string; pack: string } {
  const root = texRoot(dist);
  if (!root) throw new Error(`no ROM recorded in ${join(dist, 'assets', 'manifest.json')}: run npm run port -- --rom <path> first, or pass the folders explicitly`);
  // A cache without the `tex` exemption (an older checkout) drops every folder without a readable `entry.json`, and when over its size cap the
  // folders with the oldest `entry.json` first: an empty one dated far ahead keeps this folder and sorts it last.
  mkdirSync(root, { recursive: true });
  const guard = join(root, 'entry.json');
  if (!existsSync(guard)) writeFileSync(guard, JSON.stringify({ version: 1, files: [], bytes: 0 }));
  const ahead = new Date(Date.now() + 10 * 365 * 86_400_000);
  utimesSync(guard, ahead, ahead);
  return { dump: join(root, 'dump'), pack: join(root, 'pack') };
}

/** The pack folder the servers use: `OOT_TEXPACK_DIR`, else the cache's; undefined when there is none yet. */
export function packDir(dist: string): string | undefined {
  if (process.env.OOT_TEXPACK_DIR) return process.env.OOT_TEXPACK_DIR;
  const root = texRoot(dist);
  return root && existsSync(root) ? join(root, 'pack') : undefined;
}
