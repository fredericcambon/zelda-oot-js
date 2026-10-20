// Build: make sure Emscripten is available locally, type-check, bundle the web shell.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants, getPriority, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Below normal for this process and the installs and bundling it starts; a lower priority already set is kept.
const { PRIORITY_BELOW_NORMAL } = constants.priority;
try {
  if (getPriority() < PRIORITY_BELOW_NORMAL) setPriority(PRIORITY_BELOW_NORMAL);
} catch {
  // A platform that refuses still builds.
}

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const emsdkDir = join(root, '.tools', 'emsdk');
const win = process.platform === 'win32';
const emsdk = join(emsdkDir, win ? 'emsdk.bat' : 'emsdk');
const emcc = join(emsdkDir, 'upstream', 'emscripten', 'emcc.py');

function run(cmd, args, cwd = root) {
  // Windows needs a shell to launch .bat and npx wrappers.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: win });
  if (r.status !== 0) {
    console.error(`build: \`${cmd} ${args.join(' ')}\` failed`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(emsdk)) {
  console.log('build: fetching emsdk into .tools/emsdk');
  run('git', ['clone', '--depth', '1', 'https://github.com/emscripten-core/emsdk.git', emsdkDir]);
}
if (!existsSync(emcc)) {
  console.log('build: installing Emscripten (first run only)');
  run(emsdk, ['install', 'latest'], emsdkDir);
  run(emsdk, ['activate', 'latest'], emsdkDir);
}

run('npx', ['vite', 'build']);
