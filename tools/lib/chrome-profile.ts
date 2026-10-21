// Chrome profile directories for the browser tools and tests. Every launch gets its profile here, so it is removed
// after Chrome has exited (Windows refuses to delete files a running Chrome holds) and leftovers of earlier runs are swept.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { constants, getPriority, setPriority, tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROFILE_ROOT = join(tmpdir(), 'oot-chrome-profiles');

/** Prefixes earlier versions of the tools used directly in the temp directory. */
export const LEGACY_PREFIXES = ['oot-chrome-', 'oot-page-profile-', 'oot-capture-', 'oot-shot-', 'oot-touch-', 'oot-measure-', 'oot-record-', 'oot-ao-', 'chr-'];

export const MAX_AGE_MS = 60 * 60 * 1000;

export interface FileOps {
  remove(path: string): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

const realOps: FileOps = {
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.warn(line),
};

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** A Chrome profile has a `Default` folder or a `Local State` file, directly or in a `profile` subfolder. */
export function looksLikeProfile(dir: string): boolean {
  return [dir, join(dir, 'profile')].some((d) => existsSync(join(d, 'Default')) || existsSync(join(d, 'Local State')));
}

function sweepFolder(folder: string, accept: (name: string) => boolean, now: number, ops: FileOps, maxAgeMs: number): number {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return 0;
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    if (!accept(name)) continue;
    const path = join(folder, name);
    try {
      if (!statSync(path).isDirectory() || !looksLikeProfile(path)) continue;
      const newest = Math.max(mtime(path), mtime(join(path, 'Default')), mtime(join(path, 'profile')), mtime(join(path, 'profile', 'Default')));
      if (now - newest <= maxAgeMs) continue;
      ops.remove(path);
      removed++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) ops.log(`chrome-profile: could not remove ${failed} old profile folder(s) in ${folder}`);
  return removed;
}

/** Removes profiles older than `maxAgeMs` from `root` and from `temp` (only folders with a legacy prefix). Returns how many went. */
export function sweepProfiles({ root = PROFILE_ROOT, temp = tmpdir(), now = Date.now(), maxAgeMs = MAX_AGE_MS, ops = realOps }: { root?: string; temp?: string; now?: number; maxAgeMs?: number; ops?: FileOps } = {}): number {
  return sweepFolder(root, () => true, now, ops, maxAgeMs) + sweepFolder(temp, (name) => LEGACY_PREFIXES.some((p) => name.startsWith(p)), now, ops, maxAgeMs);
}

let swept = false;

/** Makes a new profile folder; the first call of the process also sweeps old ones. Remove it with `removeChromeProfile`. */
export function createChromeProfile(label = 'chrome'): string {
  if (!swept) {
    swept = true;
    sweepProfiles();
  }
  mkdirSync(PROFILE_ROOT, { recursive: true });
  return mkdtempSync(join(PROFILE_ROOT, `${label}-`));
}

/** Removes `dir`, retrying with a growing pause while a file is still locked; logs one line if it never goes. */
export async function removeWithRetry(dir: string, { tries = 5, delayMs = 250, ops = realOps }: { tries?: number; delayMs?: number; ops?: FileOps } = {}): Promise<boolean> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      ops.remove(dir);
      return true;
    } catch (e) {
      last = e;
      if (i < tries - 1) await ops.sleep(delayMs * 2 ** i);
    }
  }
  ops.log(`chrome-profile: could not remove ${dir}: ${last instanceof Error ? last.message : String(last)}`);
  return false;
}

function stop(chrome: ChildProcess): void {
  if (chrome.pid && process.platform === 'win32') spawnSync('taskkill', ['/pid', String(chrome.pid), '/t', '/f'], { stdio: 'ignore' });
  else chrome.kill('SIGKILL');
}

/** Stops `chrome` if it still runs, waits for it to exit, then removes its profile (pauses total about 6 s). */
export async function removeChromeProfile(dir: string, chrome?: ChildProcess): Promise<boolean> {
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
    stop(chrome);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  return removeWithRetry(dir, { tries: 6, delayMs: 200 });
}

/** Starts Chrome at Idle priority on Windows. A child process inherits its parent's priority class, so this process runs at Idle only for the spawn call and Chrome's own children inherit it from Chrome. */
export function spawnChrome(exe: string, args: string[], options: SpawnOptions = { stdio: 'ignore' }): ChildProcess {
  if (process.platform !== 'win32') return spawn(exe, args, options);
  const before = getPriority(0);
  try {
    setPriority(0, constants.priority.PRIORITY_LOW);
    return spawn(exe, args, options);
  } finally {
    setPriority(0, before);
  }
}
