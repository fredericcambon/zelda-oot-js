import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_AT, CARD_SIZE, COMMENTS_AT, PAGE, parseContainer, payloadStats } from './container.ts';

interface NoteSpec {
  entry: number;
  gameCode: string;
  publisher: string;
  /** Pages in chain order. */
  pages: number[];
  comment?: string;
}

/** A DexDrive dump with the given notes; each page of a note is filled with its page number. */
function dump(notes: NoteSpec[], opts: { badIndexSum?: boolean; magic?: string } = {}): Uint8Array {
  const file = new Uint8Array(CARD_AT + CARD_SIZE);
  file.set(new TextEncoder().encode(opts.magic ?? '123-456-STD'));
  const card = file.subarray(CARD_AT);
  const view = new DataView(card.buffer, card.byteOffset, card.byteLength);
  view.setUint16(0x38, 1);
  card[0x3a] = 1;
  let sum = 0;
  for (let i = 0x20; i < 0x3c; i += 2) sum += view.getUint16(i);
  view.setUint16(0x3c, sum & 0xffff);
  view.setUint16(0x3e, (0xfffe - sum) & 0xffff);
  const index = card.subarray(PAGE, 2 * PAGE);
  const indexView = new DataView(index.buffer, index.byteOffset, index.byteLength);
  for (let p = 5; p < 128; p++) indexView.setUint16(p * 2, 3);
  for (const n of notes) {
    n.pages.forEach((p, i) => {
      indexView.setUint16(p * 2, i + 1 < n.pages.length ? n.pages[i + 1]! : 1);
      card.fill(p, p * PAGE, (p + 1) * PAGE);
    });
    const at = 3 * PAGE + n.entry * 0x20;
    for (let i = 0; i < 4; i++) card[at + i] = parseInt(n.gameCode.slice(i * 2, i * 2 + 2), 16);
    for (let i = 0; i < 2; i++) card[at + 4 + i] = parseInt(n.publisher.slice(i * 2, i * 2 + 2), 16);
    view.setUint16(at + 6, n.pages[0]!);
    file.set(new TextEncoder().encode(n.comment ?? ''), COMMENTS_AT + n.entry * 0x100);
  }
  let indexSum = 0;
  for (let i = 0x0a; i < PAGE; i++) indexSum += index[i]!;
  index[1] = (indexSum + (opts.badIndexSum ? 1 : 0)) & 0xff;
  card.set(index, 2 * PAGE);
  return file;
}

describe('parseContainer', () => {
  it('reads a note whose pages are chained out of order', () => {
    const c = parseContainer(dump([{ entry: 2, gameCode: '3BADD1E5', publisher: 'FADE', pages: [7, 5, 9], comment: 'hello' }]));
    expect(c.problems).toEqual([]);
    expect(c.id.checksum1Ok).toBe(true);
    expect(c.indexTableChecksumOk).toBe(true);
    expect(c.notes).toHaveLength(1);
    const n = c.notes[0]!;
    expect(n).toMatchObject({ entry: 2, gameCode: '3BADD1E5', publisher: 'FADE', startPage: 7, pages: [7, 5, 9], length: 3 * PAGE, comment: 'hello' });
    expect(n.fileOffset).toBe(CARD_AT + 7 * PAGE);
    expect(Array.from(n.data.filter((_, i) => i % PAGE === 0))).toEqual([7, 5, 9]);
  });

  it('reads several notes and skips empty entries', () => {
    const c = parseContainer(dump([
      { entry: 0, gameCode: '00000001', publisher: '0001', pages: [5] },
      { entry: 15, gameCode: '00000002', publisher: '0002', pages: [6, 7] },
    ]));
    expect(c.notes.map((n) => [n.entry, n.length])).toEqual([[0, PAGE], [15, 2 * PAGE]]);
  });

  it('reports a bad index table checksum', () => {
    const c = parseContainer(dump([], { badIndexSum: true }));
    expect(c.indexTableChecksumOk).toBe(false);
    expect(c.problems.join('\n')).toMatch(/index table checksum/);
  });

  it('reports a page chain that loops', () => {
    const file = dump([{ entry: 0, gameCode: '00000001', publisher: '0001', pages: [5, 6] }]);
    new DataView(file.buffer).setUint16(CARD_AT + PAGE + 6 * 2, 5);
    expect(parseContainer(file).problems.join('\n')).toMatch(/loops at page 5/);
  });

  it('refuses a file of the wrong size or without the dump header', () => {
    expect(() => parseContainer(dump([]).subarray(0, 1000))).toThrow(/bytes/);
    expect(() => parseContainer(dump([], { magic: '999-999-STD' }))).toThrow(/123-456-STD/);
  });
});

describe('payloadStats', () => {
  it('shows no structure for pseudo-random bytes and plenty for a repeated pattern', () => {
    let x = 12345;
    const random = Uint8Array.from({ length: 6144 }, () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) & 0xff);
    const r = payloadStats(random);
    expect(r.entropy).toBeGreaterThan(7.9);
    expect(r.bestRepeatFraction).toBeLessThan(0.02);
    const pattern = payloadStats(Uint8Array.from({ length: 6144 }, (_, i) => i % 16));
    expect(pattern.entropy).toBe(4);
    expect(pattern.bestRepeatFraction).toBe(1);
  });
});

describe.skipIf(!process.env.OOT_SAVE_SAMPLE)('the sample file', () => {
  it('holds one 24-page note whose payload shows no structure', () => {
    const c = parseContainer(new Uint8Array(readFileSync(process.env.OOT_SAVE_SAMPLE!)));
    expect(c.problems).toEqual([]);
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]).toMatchObject({ gameCode: '3BADD1E5', publisher: 'FADE', startPage: 5, fileOffset: 0x1540, length: 0x1800 });
    expect(payloadStats(c.notes[0]!.data).entropy).toBeGreaterThan(7.9);
  });
});
