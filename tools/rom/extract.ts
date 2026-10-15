import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locateFileTable, type FileEntry } from './filetable.ts';
import { loadRom } from './rom.ts';
import { isYaz0, yaz0Decode } from './yaz0.ts';

export interface IndexEntry extends FileEntry {
  size: number;
  path: string;
}

export interface ExtractIndex {
  sha1: string;
  gameCode: string;
  fileTableOffset: number;
  files: IndexEntry[];
}

/** Returns the decompressed contents of one file, checking the declared size. */
export function readFile(rom: Uint8Array, e: FileEntry): Uint8Array {
  const size = e.virtualEnd - e.virtualStart;
  if (!e.compressed) return rom.subarray(e.romStart, e.romStart + size);
  if (!isYaz0(rom, e.romStart)) throw new Error(`file ${e.index}: compressed entry has no Yaz0 magic`);
  const out = yaz0Decode(rom.subarray(e.romStart, e.romEnd));
  if (out.length !== size) {
    throw new Error(`file ${e.index}: decompressed to ${out.length} bytes, table declares ${size}`);
  }
  return out;
}

export function extractRom(raw: Uint8Array, outDir: string): ExtractIndex {
  const rom = loadRom(raw);
  const table = locateFileTable(rom.data);
  const filesDir = join(outDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const files = table.entries.map((e): IndexEntry => {
    const name = `${String(e.index).padStart(4, '0')}_${e.virtualStart.toString(16).padStart(8, '0')}.bin`;
    writeFileSync(join(filesDir, name), readFile(rom.data, e));
    return { ...e, size: e.virtualEnd - e.virtualStart, path: `files/${name}` };
  });

  const index: ExtractIndex = {
    sha1: rom.sha1,
    gameCode: rom.header.gameCode,
    fileTableOffset: table.offset,
    files,
  };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}
