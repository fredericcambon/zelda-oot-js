// Shared dependencies: one `npm ci` per package-lock.json hash in ~/.zelda-oot-js/deps/<hash>/, and a directory junction
// from <worktree>/node_modules to it. Plain Node with no imports from the repo, so it runs before node_modules exists.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { constants, homedir, setPriority } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNUSED_DAYS = 14;
const READY = 'ready';
const LOCK_STALE_MS = 3_600_000;

export const depsRoot = () => process.env.OOT_DEPS_DIR || join(homedir(), '.zelda-oot-js', 'deps');

export function lockHash(lockFile) {
  return createHash('sha256').update(readFileSync(lockFile)).digest('hex');
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` while holding a lock file that no other process holds; a lock older than an hour is taken over. */
function withLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // The holder just released it.
      }
      sleep(1000);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** Tools the package scripts run; each must have a launcher in node_modules/.bin. */
export const REQUIRED_BINS = ['tsx', 'vite', 'vitest', 'eslint', 'tsc'];

/**
 * True when the install in `dir` is whole: the marker holds the top-level package count taken at install time, node_modules
 * has at least that many entries and .bin has every required tool. A marker without a count (an older install) is not whole.
 * Costs one readdir and a few stats.
 */
export function isComplete(dir, bins = REQUIRED_BINS) {
  try {
    const expected = Number.parseInt(readFileSync(join(dir, READY), 'utf8'), 10);
    if (!(expected > 0)) return false;
    const modules = join(dir, 'node_modules');
    if (readdirSync(modules).length < expected) return false;
    const ext = process.platform === 'win32' ? '.cmd' : '';
    return bins.every((b) => existsSync(join(modules, '.bin', b + ext)));
  } catch {
    return false;
  }
}

// A deletion that follows the worktree's junction (robocopy /MIR does; Node, Remove-Item and rd do not) empties the shared
// install. A deny-delete entry for Everyone, inherited by every file and folder, makes any recursive delete fail instead.
// Reads, execution and writes are untouched, so vite, vitest, tsx and eslint run as before.
const EVERYONE = '*S-1-1-0';
const icacls = (args) => spawnSync('icacls', args, { stdio: 'ignore' }).status === 0;

/** Marks `modules` and everything in it undeletable (Windows only). */
export function protect(modules) {
  return process.platform !== 'win32' || icacls([modules, '/deny', `${EVERYONE}:(OI)(CI)(DE,DC)`, '/C', '/Q']);
}

/** Lifts the protection from `modules` so the folder can be replaced or removed (Windows only). */
export function unprotect(modules) {
  return process.platform !== 'win32' || !existsSync(modules) || icacls([modules, '/remove:d', EVERYONE, '/T', '/C', '/Q']);
}

/** Removes an install folder, lifting its protection first. */
export function removeInstall(dir) {
  unprotect(join(dir, 'node_modules'));
  rmSync(dir, { recursive: true, force: true });
}

/** Installs the packages for `repo`'s lock file into <deps>/<hash>/node_modules unless they are there. Returns that folder. */
export function ensureInstalled(repo, root = depsRoot(), log = console.log) {
  const hash = lockHash(join(repo, 'package-lock.json'));
  const dir = join(root, hash);
  const ready = join(dir, READY);
  if (!isComplete(dir)) {
    withLock(join(root, `${hash}.lock`), () => {
      if (isComplete(dir)) return;
      if (existsSync(ready)) log(`deps: ${dir} is incomplete; reinstalling`);
      removeInstall(dir);
      mkdirSync(dir, { recursive: true });
      for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(repo, f), join(dir, f));
      log(`deps: installing into ${dir} (once per package-lock.json)`);
      try {
        setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // A platform that refuses still installs.
      }
      const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error('npm ci failed');
      }
      const modules = join(dir, 'node_modules');
      const count = readdirSync(modules).length;
      if (!protect(modules)) log('deps: could not protect the install from deletion');
      writeFileSync(ready, String(count));
    });
  }
  const now = new Date();
  utimesSync(dir, now, now);
  return join(dir, 'node_modules');
}

/**
 * Makes `link` a directory junction to `target`. A missing link or an empty folder is replaced and a junction that points
 * elsewhere is repointed; a folder with content is left alone. Returns 'linked', 'unchanged' or 'kept'.
 */
export function junction(link, target) {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    let same = false;
    try {
      same = realpathSync(link) === realpathSync(target);
    } catch {
      // A dangling junction is replaced.
    }
    if (same) return 'unchanged';
    try {
      unlinkSync(link);
    } catch {
      rmdirSync(link);
    }
  } else if (st?.isDirectory()) {
    if (readdirSync(link).length > 0) return 'kept';
    rmdirSync(link);
  } else if (st) {
    return 'kept';
  }
  symlinkSync(target, link, 'junction');
  return 'linked';
}

/** Deletes the hash folders under `root` (other than `keep`) not used for `days` days. Returns their names. */
export function pruneUnused(root, keep, days = UNUSED_DAYS, now = Date.now()) {
  const removed = [];
  if (!existsSync(root)) return removed;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (name === keep || !/^[0-9a-f]{64}$/.test(name)) continue;
    try {
      if (!existsSync(join(path, READY)) || now - statSync(path).mtimeMs <= days * 86_400_000) continue;
      removeInstall(path);
      removed.push(name);
    } catch {
      // Another process is using or removing it.
    }
  }
  return removed;
}

export function main(repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const root = depsRoot();
  const target = ensureInstalled(repo, root);
  const link = join(repo, 'node_modules');
  const result = junction(link, target);
  if (result === 'kept') console.log(`deps: ${link} is a real folder with content; left alone (delete it, then run npm run deps)`);
  else console.log(`deps: node_modules -> ${target} (${result})`);
  const removed = pruneUnused(root, lockHash(join(repo, 'package-lock.json')));
  if (removed.length > 0) console.log(`deps: removed ${removed.length} folder(s) unused for ${UNUSED_DAYS} days`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
