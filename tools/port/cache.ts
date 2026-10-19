// Content-addressed build cache shared by every worktree of this machine. An entry is a directory of files plus an
// `entry.json` that lists their sizes and hashes; it appears under its final name by one rename, so readers never see a
// half-written entry. Any entry that cannot be read back exactly is a miss, never an error.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export const DEFAULT_MAX_GB = 10;

/** Folders of the cache directory that belong to other tools (test states, vitest's timing cache) and that eviction leaves alone. */
const UNMANAGED = new Set(['intro-state', 'vitest']);

export function defaultCacheDir(): string {
  return process.env.OOT_CACHE_DIR || join(homedir(), '.zelda-oot-js', 'cache');
}

/** The size cap in bytes: `OOT_CACHE_MAX_GB` when it is a positive number, else 10 GB. */
export function defaultMaxBytes(): number {
  const gb = Number(process.env.OOT_CACHE_MAX_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_MAX_GB) * 1024 ** 3;
}

/** One hash of an ordered list of strings; the parts cannot run into each other. */
export function hashKey(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${Buffer.byteLength(p)}:`).update(p);
  return h.digest('hex');
}

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');

const fileHashes = new Map<string, { stamp: string; hash: string }>();

/** SHA-1 of a file's bytes; repeated calls for an unchanged file (same size and modification time) reuse the result. */
export function hashFile(path: string): string {
  const full = resolve(path);
  const st = statSync(full);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const known = fileHashes.get(full);
  if (known?.stamp === stamp) return known.hash;
  const hash = sha1(readFileSync(full));
  fileHashes.set(full, { stamp, hash });
  return hash;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

const IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Hash of the source of a tool: every module reachable from `entries` through relative imports, plus every file under
 * `dataDirs` (files the tool reads at run time).
 */
export function sourceHash(entries: string[], dataDirs: string[] = []): string {
  const files = new Set<string>();
  const pending = entries.map((e) => resolve(e));
  for (let f = pending.pop(); f !== undefined; f = pending.pop()) {
    if (files.has(f) || !existsSync(f)) continue;
    files.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) pending.push(resolve(dirname(f), m[1]!));
  }
  for (const d of dataDirs) for (const f of walk(resolve(d))) files.add(f);
  const root = process.cwd();
  return hashKey(...[...files].sort().flatMap((f) => [relative(root, f).replaceAll('\\', '/'), hashFile(f)]));
}

interface EntryFile {
  path: string;
  size: number;
  sha1: string;
}

interface EntryManifest {
  version: 1;
  files: EntryFile[];
  bytes: number;
  meta?: unknown;
}

export interface CacheHit {
  meta: unknown;
}

const MANIFEST = 'entry.json';
const STALE_TMP_MS = 3_600_000;

export class Cache {
  constructor(readonly dir: string, readonly maxBytes: number) {}

  private entryDir(kind: string, key: string): string {
    return join(this.dir, kind, key);
  }

  private tmpPath(label: string): string {
    return join(this.dir, 'tmp', `${label}-${process.pid}-${randomBytes(4).toString('hex')}`);
  }

  /** Removes an entry in a way that no reader can catch half-deleted. */
  private drop(path: string): void {
    try {
      const gone = this.tmpPath('drop');
      mkdirSync(dirname(gone), { recursive: true });
      renameSync(path, gone);
      rmSync(gone, { recursive: true, force: true });
    } catch {
      rmSync(path, { recursive: true, force: true });
    }
  }

  /**
   * Copies the entry's files below `dest`. Every size and hash is checked, and `accept` (when given) may veto a file's
   * bytes, before anything is written. Returns undefined, and drops the entry, when it is missing, unreadable, does not
   * match its manifest or is vetoed. A failure to write below `dest` is a miss too, but leaves the sound entry alone.
   */
  restore(kind: string, key: string, dest: string, accept?: (path: string, data: Buffer) => boolean): CacheHit | undefined {
    const dir = this.entryDir(kind, key);
    if (!existsSync(dir)) return undefined;
    let manifest: EntryManifest;
    const loaded: { path: string; data: Buffer }[] = [];
    try {
      manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as EntryManifest;
      if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('unknown manifest');
      for (const f of manifest.files) {
        const data = readFileSync(join(dir, f.path));
        if (data.length !== f.size || sha1(data) !== f.sha1) throw new Error(`${f.path} does not match its manifest`);
        if (accept && !accept(f.path, data)) throw new Error(`${f.path} is not acceptable`);
        loaded.push({ path: f.path, data });
      }
    } catch {
      this.drop(dir);
      return undefined;
    }
    try {
      for (const { path, data } of loaded) {
        const target = join(dest, path);
        mkdirSync(dirname(target), { recursive: true });
        const part = `${target}.part-${process.pid}`;
        writeFileSync(part, data);
        renameSync(part, target);
      }
      const now = new Date();
      utimesSync(join(dir, MANIFEST), now, now);
    } catch {
      // The destination is busy or unwritable (another process holds the file); the entry itself is sound.
      return undefined;
    }
    return { meta: manifest.meta };
  }

  /** Stores `files` (paths relative to `root`) as an entry. A failure to store is not an error: the build just stays uncached. */
  store(kind: string, key: string, root: string, files: string[], meta?: unknown): boolean {
    const final = this.entryDir(kind, key);
    const tmp = this.tmpPath(kind);
    try {
      const list: EntryFile[] = [];
      for (const path of files) {
        const data = readFileSync(join(root, path));
        const target = join(tmp, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        list.push({ path, size: data.length, sha1: sha1(data) });
      }
      const manifest: EntryManifest = { version: 1, files: list, bytes: list.reduce((n, f) => n + f.size, 0), meta };
      writeFileSync(join(tmp, MANIFEST), JSON.stringify(manifest));
      mkdirSync(dirname(final), { recursive: true });
      renameSync(tmp, final);
      return true;
    } catch {
      // Another worktree stored the same entry first, or the disk refused; either way the entry is not ours to write.
      rmSync(tmp, { recursive: true, force: true });
      return existsSync(join(final, MANIFEST));
    }
  }

  /** Deletes the least recently used entries until the cache fits `maxBytes`. Returns how many it deleted. */
  evict(): number {
    const entries: { path: string; bytes: number; used: number }[] = [];
    if (!existsSync(this.dir)) return 0;
    for (const kind of readdirSync(this.dir)) {
      if (UNMANAGED.has(kind)) continue;
      const kindDir = join(this.dir, kind);
      if (kind === 'tmp') {
        for (const t of readdirSync(kindDir)) {
          const p = join(kindDir, t);
          try {
            if (Date.now() - statSync(p).mtimeMs > STALE_TMP_MS) rmSync(p, { recursive: true, force: true });
          } catch { /* another process removed it */ }
        }
        continue;
      }
      for (const key of readdirSync(kindDir)) {
        const path = join(kindDir, key);
        try {
          const manifest = join(path, MANIFEST);
          const bytes = (JSON.parse(readFileSync(manifest, 'utf8')) as EntryManifest).bytes;
          entries.push({ path, bytes, used: statSync(manifest).mtimeMs });
        } catch {
          // Unreadable entries are of no use to anyone.
          this.drop(path);
        }
      }
    }
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    let deleted = 0;
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (total <= this.maxBytes) break;
      this.drop(e.path);
      total -= e.bytes;
      deleted++;
    }
    return deleted;
  }
}

/** Every file below `root`, as paths relative to it with forward slashes, sorted. */
export function listTree(root: string): string[] {
  return walk(resolve(root)).map((f) => relative(resolve(root), f).replaceAll('\\', '/')).sort();
}
