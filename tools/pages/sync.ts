// Mirrors a built site folder into the working copy of the gh-pages branch, touching only the files whose content differs.
import { copyFileSync, createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface SyncResult {
  /** Files copied because they are new or their content differs. */
  written: string[];
  /** Files removed because the site no longer has them. */
  deleted: string[];
  /** Bytes of the written files. */
  bytes: number;
}

/** Paths (with `/` separators, relative to `root`) of every file under `root`, skipping the top-level `.git` folder. */
export function listFiles(root: string, dir = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!dir && entry.name === '.git') continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, rel));
    else files.push(rel);
  }
  return files;
}

function hashFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

async function differs(from: string, to: string): Promise<boolean> {
  let target;
  try {
    target = statSync(to);
  } catch {
    return true;
  }
  if (target.size !== statSync(from).size) return true;
  return (await hashFile(from)) !== (await hashFile(to));
}

/** Makes `dest` hold exactly the files of `site` (except `dest/.git`): copies new or changed files (size first, then hash), deletes the rest. */
export async function syncSite(site: string, dest: string): Promise<SyncResult> {
  const result: SyncResult = { written: [], deleted: [], bytes: 0 };
  const wanted = new Set(listFiles(site));
  for (const rel of wanted) {
    const from = join(site, rel);
    const to = join(dest, rel);
    if (!(await differs(from, to))) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    result.written.push(rel);
    result.bytes += statSync(from).size;
  }
  for (const rel of listFiles(dest)) {
    if (wanted.has(rel)) continue;
    rmSync(join(dest, rel));
    result.deleted.push(rel);
  }
  pruneEmptyDirs(dest);
  return result;
}

function pruneEmptyDirs(root: string, dir = ''): boolean {
  let empty = true;
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (!dir && entry.name === '.git') {
      empty = false;
      continue;
    }
    if (entry.isDirectory() && pruneEmptyDirs(root, rel)) rmSync(join(root, rel), { recursive: true });
    else empty = false;
  }
  return empty;
}
