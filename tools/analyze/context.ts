// Loads the ROM named by $OOT_ROM (or --rom) and derives the layout every analysis stage works from.

import { readFileSync } from 'node:fs';
import { readFile } from '../rom/extract.ts';
import { locateFileTable, type FileEntry } from '../rom/filetable.ts';
import { loadRom } from '../rom/rom.ts';
import { analyseLayout, type RomLayout } from './layout.ts';

export interface RomContext {
  rom: Uint8Array;
  sha1: string;
  files: FileEntry[];
  layout: RomLayout;
  /** Decompressed contents of a file of the file table. */
  fileBytes(index: number): Uint8Array;
}

export function romPathFromEnv(explicit?: string): string {
  const p = explicit ?? process.env.OOT_ROM;
  if (!p) throw new Error('no ROM given: set OOT_ROM or pass --rom <path>');
  return p;
}

export function loadContext(romPath: string): RomContext {
  const loaded = loadRom(new Uint8Array(readFileSync(romPath)));
  const table = locateFileTable(loaded.data);
  const layout = analyseLayout(loaded.data, table.entries);
  const byIndex = new Map(table.entries.map((f) => [f.index, f]));
  return {
    rom: loaded.data,
    sha1: loaded.sha1,
    files: table.entries,
    layout,
    fileBytes(index) {
      const f = byIndex.get(index);
      if (!f) throw new Error(`no file ${index}`);
      return readFile(loaded.data, f);
    },
  };
}
