// Splits the ROM into the pieces the browser fetches: the header, every file of the file table as stored (compressed
// where the ROM stores it compressed), the file table itself, and whatever lies between. The pieces tile the image, so
// the page rebuilds it from the index without ever being given the ROM.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locateFileTable, type FileEntry } from './filetable.ts';
import { loadRom } from './rom.ts';

/** The header ends and the boot code starts here (the ROM header is 0x40 bytes, the IPL boot area follows to 0x1000). */
export const HEADER_END = 0x1000;
const TABLE_ENTRY_SIZE = 16;

export type PieceKind = 'header' | 'file' | 'filetable' | 'gap';

export interface Piece {
  /** ROM range [start, end). */
  start: number;
  end: number;
  kind: PieceKind;
  /** File-table index, for `file` and for the parts of the file that contains the file table. */
  file?: number;
  /** Path relative to the index. */
  path: string;
}

export interface PieceIndex {
  size: number;
  pieces: Piece[];
}

/** The ranges that tile `[0, size)`; pure, so it can be tested without a ROM. */
export function planPieces(size: number, entries: FileEntry[], tableOffset: number, tableEntries: number): Omit<Piece, 'path'>[] {
  const tableEnd = tableOffset + tableEntries * TABLE_ENTRY_SIZE;
  const cuts = new Set<number>([0, size, HEADER_END, tableOffset, tableEnd]);
  for (const e of entries) {
    cuts.add(e.romStart);
    cuts.add(e.romEnd);
  }
  const sorted = [...cuts].filter((c) => c >= 0 && c <= size).sort((a, b) => a - b);
  const pieces: Omit<Piece, 'path'>[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!, end = sorted[i + 1]!;
    const owner = entries.find((e) => e.romStart <= start && end <= e.romEnd && e.romEnd > e.romStart);
    if (start < HEADER_END) pieces.push({ start, end, kind: 'header' });
    else if (start >= tableOffset && end <= tableEnd) pieces.push({ start, end, kind: 'filetable', file: owner?.index });
    else if (owner) pieces.push({ start, end, kind: 'file', file: owner.index });
    else pieces.push({ start, end, kind: 'gap' });
  }
  return pieces;
}

const pieceName = (p: Omit<Piece, 'path'>) => `${p.start.toString(16).padStart(8, '0')}-${p.kind}${p.file !== undefined ? `-${p.file}` : ''}.bin`;

/** Writes `<outDir>/index.json` and one file per piece. */
export function writeRomPieces(raw: Uint8Array, outDir: string): PieceIndex {
  const rom = loadRom(raw).data;
  const table = locateFileTable(rom);
  mkdirSync(outDir, { recursive: true });
  const pieces = planPieces(rom.length, table.entries, table.offset, table.entries.length).map((p): Piece => {
    const piece = { ...p, path: pieceName(p) };
    writeFileSync(join(outDir, piece.path), rom.subarray(p.start, p.end));
    return piece;
  });
  const index: PieceIndex = { size: rom.length, pieces };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index) + '\n');
  return index;
}
