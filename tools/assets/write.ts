// Writes the classified ROM as `<dir>/<type>/<name>` files plus `<dir>/manifest.json`, and rebuilds the cartridge image
// from them. The runtime reads the image through the manifest, so the game runs without the ROM.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AssetEntry, Classification, TableInfo } from './classify.ts';

export interface ManifestEntry extends Omit<AssetEntry, 'file'> {
  /** Index in the file table, or -1 for ROM bytes outside every file. */
  file: number;
  /** Path of the stored bytes, relative to the manifest. */
  path: string;
}

export interface Manifest {
  version: 1;
  rom: { sha1: string; size: number };
  /** The stored bytes of every entry, laid at `romStart`, tile the cartridge image. */
  entries: ManifestEntry[];
  tables: TableInfo[];
  summary: Record<string, { files: number; bytes: number }>;
}

const hex8 = (n: number) => n.toString(16).padStart(8, '0');

export function assetPath(e: Pick<AssetEntry, 'file' | 'type' | 'virtualStart' | 'romStart'>): string {
  const name = e.file >= 0 ? `${String(e.file).padStart(4, '0')}-${hex8(e.virtualStart)}.bin` : `outside-${hex8(e.romStart)}.bin`;
  return `${e.type}/${name}`;
}

/** Checks that the entries cover `[0, size)` once. Returns the first problem found. */
export function tilingProblem(entries: Pick<AssetEntry, 'romStart' | 'romEnd'>[], size: number): string | undefined {
  let at = 0;
  for (const e of [...entries].sort((a, b) => a.romStart - b.romStart)) {
    if (e.romStart !== at) return `ROM ${at.toString(16)}-${e.romStart.toString(16)} is ${e.romStart > at ? 'covered by no entry' : 'covered twice'}`;
    at = e.romEnd;
  }
  return at === size ? undefined : `entries end at ${at.toString(16)}, the image at ${size.toString(16)}`;
}

export function buildManifest(sha1: string, size: number, c: Classification): Manifest {
  const entries = c.entries.map((e): ManifestEntry => ({ ...e, path: assetPath(e) }));
  const problem = tilingProblem(entries, size);
  if (problem) throw new Error(`asset entries do not tile the ROM: ${problem}`);
  const summary: Manifest['summary'] = {};
  for (const e of entries) {
    const s = (summary[e.type] ??= { files: 0, bytes: 0 });
    s.files++;
    s.bytes += e.romEnd - e.romStart;
  }
  return { version: 1, rom: { sha1, size }, entries, tables: c.tables, summary };
}

/** Replaces `dir` with the asset files and the manifest. */
export function writeAssets(rom: Uint8Array, manifest: Manifest, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  for (const e of manifest.entries) {
    const target = join(dir, e.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rom.subarray(e.romStart, e.romEnd));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
}

/** The cartridge image the game's DMA reads from, assembled from the files a manifest names. */
export function readCartridge(dir: string): Uint8Array {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const image = new Uint8Array(manifest.rom.size);
  for (const e of manifest.entries) image.set(readFileSync(join(dir, e.path)), e.romStart);
  return image;
}
