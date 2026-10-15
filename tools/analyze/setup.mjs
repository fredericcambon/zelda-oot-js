// Fetches Ghidra and the JDK it needs into .tools/ (git-ignored) when missing.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';

export const GHIDRA_VERSION = '12.1.4';
const GHIDRA_URL =
  'https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip';
const GHIDRA_SHA256 = 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db';

const JDK_RELEASE = 'jdk-21.0.12.1%2B1';
const JDK_FILE = 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip';
const JDK_WIN_SHA256 = 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const toolsDir = join(root, '.tools');
export const ghidraDir = join(toolsDir, `ghidra_${GHIDRA_VERSION}_PUBLIC`);
export const jdkDir = join(toolsDir, 'jdk-21');

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function download(url, dest, expected) {
  console.log(`downloading ${url}`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}): ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  const got = await sha256(dest);
  if (expected && got !== expected) throw new Error(`SHA-256 mismatch for ${url}: ${got}`);
  console.log(`sha256 ${got}`);
}

// GNU tar (Git Bash) misreads "C:" as a remote host; use the bsdtar shipped with Windows.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const r = spawnSync(TAR, ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not extract ${zip}`);
}

function jdkSource() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { url: `https://github.com/adoptium/temurin21-binaries/releases/download/${JDK_RELEASE}/${JDK_FILE}`, sha: JDK_WIN_SHA256 };
  }
  const os = { linux: 'linux', darwin: 'mac' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return { url: `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`, sha: null };
}

export function javaHome() {
  if (process.env.OOT_JAVA_HOME) return process.env.OOT_JAVA_HOME;
  const mac = join(jdkDir, 'Contents', 'Home');
  return existsSync(mac) ? mac : jdkDir;
}

export function analyzeHeadlessPath() {
  const name = process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless';
  return join(ghidraDir, 'support', name);
}

export async function setup() {
  mkdirSync(join(toolsDir, 'downloads'), { recursive: true });
  if (!existsSync(join(jdkDir, 'bin')) && !existsSync(join(jdkDir, 'Contents')) && !process.env.OOT_JAVA_HOME) {
    const { url, sha } = jdkSource();
    const archive = join(toolsDir, 'downloads', url.endsWith('.zip') ? 'jdk.zip' : 'jdk.tar.gz');
    await download(url, archive, sha);
    const tmp = join(toolsDir, 'jdk-tmp');
    rmSync(tmp, { recursive: true, force: true });
    if (archive.endsWith('.zip')) unzip(archive, tmp);
    else {
      mkdirSync(tmp, { recursive: true });
      spawnSync(TAR, ['-xzf', archive, '-C', tmp], { stdio: 'inherit' });
    }
    const inner = readdirSync(tmp)[0];
    rmSync(jdkDir, { recursive: true, force: true });
    renameSync(join(tmp, inner), jdkDir);
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!existsSync(analyzeHeadlessPath())) {
    const archive = join(toolsDir, 'downloads', 'ghidra.zip');
    await download(GHIDRA_URL, archive, GHIDRA_SHA256);
    unzip(archive, toolsDir);
  }
  console.log(`JDK: ${javaHome()}\nGhidra: ${ghidraDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  });
}
