import { describe, expect, it } from 'vitest';
import type { FileEntry } from './filetable.ts';
import { HEADER_END, planPieces } from './pieces.ts';

const file = (index: number, romStart: number, romEnd: number): FileEntry => ({ index, virtualStart: 0, virtualEnd: 0, romStart, romEnd, compressed: false });

describe('planPieces', () => {
  const size = 0x10000;
  const entries = [file(0, 0, 0x4000), file(1, 0x4000, 0x6000), file(2, 0x8000, 0xa000)];
  const pieces = planPieces(size, entries, 0x2000, 4);

  it('tiles the image without gaps or overlaps', () => {
    expect(pieces[0]!.start).toBe(0);
    expect(pieces.at(-1)!.end).toBe(size);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.start).toBe(pieces[i - 1]!.end);
  });

  it('separates the header, the file table, the files and the gaps', () => {
    const kinds = pieces.map((p) => [p.start, p.kind, p.file]);
    expect(kinds).toContainEqual([0, 'header', undefined]);
    expect(kinds).toContainEqual([0x2000, 'filetable', 0]);
    expect(kinds).toContainEqual([0x4000, 'file', 1]);
    expect(kinds).toContainEqual([0x6000, 'gap', undefined]);
    expect(kinds).toContainEqual([0x8000, 'file', 2]);
    expect(pieces.find((p) => p.kind === 'header')!.end).toBe(HEADER_END);
  });
});
