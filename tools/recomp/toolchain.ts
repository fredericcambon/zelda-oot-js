// Locates Emscripten, and fetches it into .tools/emsdk when it is missing.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolThreadEnv } from '../port/limits.ts';

export const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export interface Toolchain {
  python: string;
  emcc: string;
  env: NodeJS.ProcessEnv;
}

const emsdkDir = () => process.env.EMSDK ?? join(repoRoot, '.tools', 'emsdk');

export function findToolchain(): Toolchain | undefined {
  const emsdk = emsdkDir();
  const emcc = join(emsdk, 'upstream', 'emscripten', 'emcc.py');
  if (!existsSync(emcc)) return undefined;
  const pyDir = join(emsdk, 'python');
  const bundled = existsSync(pyDir)
    ? readdirSync(pyDir).map((d) => join(pyDir, d, process.platform === 'win32' ? 'python.exe' : 'bin/python3')).find(existsSync)
    : undefined;
  return {
    python: bundled ?? (process.platform === 'win32' ? 'python' : 'python3'),
    emcc,
    env: { ...toolThreadEnv(), EM_CONFIG: join(emsdk, '.emscripten') },
  };
}

function run(cmd: string, args: string[], cwd: string, log: (m: string) => void): void {
  // Windows needs a shell to launch .bat wrappers.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    log(`\`${cmd} ${args.join(' ')}\` failed`);
    throw new Error(`could not install Emscripten: \`${cmd} ${args.join(' ')}\` exited with ${r.status}`);
  }
}

/** The toolchain, installed first when it is not there yet. Throws when it cannot be installed. */
export function ensureToolchain(log: (m: string) => void = () => {}): Toolchain {
  const found = findToolchain();
  if (found) return found;
  const dir = emsdkDir();
  const win = process.platform === 'win32';
  if (!existsSync(join(dir, win ? 'emsdk.bat' : 'emsdk'))) {
    log('fetching emsdk into .tools/emsdk');
    run('git', ['clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', dir], repoRoot, log);
  }
  log('installing Emscripten (first run only)');
  const emsdk = join(dir, win ? 'emsdk.bat' : 'emsdk');
  run(emsdk, ['install', 'latest'], dir, log);
  run(emsdk, ['activate', 'latest'], dir, log);
  const installed = findToolchain();
  if (!installed) throw new Error(`Emscripten is not usable in ${dir} after installation`);
  return installed;
}
