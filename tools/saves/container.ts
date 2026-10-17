// A DexDrive dump of a Controller Pak and the notes in it. The layout is read from the one sample file
// (docs/re/saves.md lists the file offsets) and from the Controller Pak file-system description on n64brew.dev.

export const DEXDRIVE_MAGIC = '123-456-STD';
/** The comments of the notes (0x1000 bytes) sit between the header and the card image. */
export const COMMENTS_AT = 0x40;
export const CARD_AT = 0x1040;
export const PAGE = 0x100;
export const PAGES = 128;
export const CARD_SIZE = PAGE * PAGES;
/** Pages 0 to 4 hold the label area, the index table and its copy, and the note table; note data starts at page 5. */
export const FIRST_DATA_PAGE = 5;
export const NOTE_ENTRY = 0x20;
export const NOTE_ENTRIES = 16;
/** Page 3 starts the note table. */
const NOTE_TABLE_PAGE = 3;
const INDEX_PAGES = [1, 2] as const;
const ID_PAGE = 0;

export interface Note {
  /** Index in the note table. */
  entry: number;
  gameCode: string;
  publisher: string;
  startPage: number;
  status: number;
  /** The 16 name bytes and the 4 extension bytes of the entry, as stored. */
  nameBytes: string;
  extensionBytes: string;
  /** Pages of the note in order, following the index table. */
  pages: number[];
  /** File offset of the first byte of the first page. */
  fileOffset: number;
  length: number;
  /** The comment the dump tool stored for the note's entry. */
  comment: string;
  /** The note's data: pages concatenated. */
  data: Uint8Array;
}

export interface Container {
  header: string;
  /** Bytes 0x0B to 0x3F of the dump header, as stored. */
  headerBytes: string;
  id: { sum: number; checksum1: number; checksum2: number; checksum1Ok: boolean };
  indexTableChecksumOk: boolean;
  indexTableCopyEqual: boolean;
  notes: Note[];
  problems: string[];
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;

function cString(b: Uint8Array): string {
  let end = b.indexOf(0);
  if (end < 0) end = b.length;
  return new TextDecoder('latin1').decode(b.subarray(0, end));
}

export function parseContainer(file: Uint8Array): Container {
  if (file.length !== CARD_AT + CARD_SIZE) throw new Error(`a DexDrive dump of one card is ${CARD_AT + CARD_SIZE} bytes, this file has ${file.length}`);
  const header = cString(file.subarray(0, 0x0b));
  if (header !== DEXDRIVE_MAGIC) throw new Error(`the file does not start with ${DEXDRIVE_MAGIC}`);
  const card = file.subarray(CARD_AT);
  const page = (n: number) => card.subarray(n * PAGE, (n + 1) * PAGE);
  const problems: string[] = [];

  const id = page(ID_PAGE);
  let sum = 0;
  for (let i = 0x20; i < 0x3c; i += 2) sum = (sum + u16(id, i)) & 0xffff;
  const checksum1 = u16(id, 0x3c);
  const checksum2 = u16(id, 0x3e);
  if (checksum1 !== sum) problems.push(`label area checksum ${checksum1.toString(16)} differs from the sum ${sum.toString(16)} of 0x20-0x3B`);

  const index = page(INDEX_PAGES[0]);
  let indexSum = 0;
  for (let i = 0x0a; i < PAGE; i++) indexSum = (indexSum + index[i]!) & 0xff;
  const indexTableChecksumOk = index[1] === indexSum;
  const indexTableCopyEqual = hex(index) === hex(page(INDEX_PAGES[1]));
  if (!indexTableChecksumOk) problems.push('index table checksum byte differs from the sum of bytes 0x0A-0xFF');
  if (!indexTableCopyEqual) problems.push('the two copies of the index table differ');

  const notes: Note[] = [];
  for (let entry = 0; entry < NOTE_ENTRIES; entry++) {
    const raw = card.subarray(NOTE_TABLE_PAGE * PAGE + entry * NOTE_ENTRY, NOTE_TABLE_PAGE * PAGE + (entry + 1) * NOTE_ENTRY);
    const startPage = u16(raw, 6);
    if (startPage < FIRST_DATA_PAGE || startPage >= PAGES) continue;
    const pages: number[] = [];
    for (let p = startPage; ; ) {
      if (pages.includes(p)) {
        problems.push(`note ${entry}: the page chain loops at page ${p}`);
        break;
      }
      pages.push(p);
      const next = u16(index, p * 2);
      if (next === 1) break;
      if (next < FIRST_DATA_PAGE || next >= PAGES) {
        problems.push(`note ${entry}: page ${p} points at ${next}`);
        break;
      }
      p = next;
    }
    const data = new Uint8Array(pages.length * PAGE);
    pages.forEach((p, i) => data.set(page(p), i * PAGE));
    const commentAt = COMMENTS_AT + entry * 0x100;
    notes.push({
      entry,
      gameCode: hex(raw.subarray(0, 4)).toUpperCase(),
      publisher: hex(raw.subarray(4, 6)).toUpperCase(),
      startPage,
      status: raw[8]!,
      nameBytes: hex(raw.subarray(0x10, 0x1c)),
      extensionBytes: hex(raw.subarray(0x1c, 0x20)),
      pages,
      fileOffset: CARD_AT + startPage * PAGE,
      length: data.length,
      comment: cString(file.subarray(commentAt, commentAt + 0x100)),
      data,
    });
  }
  return {
    header,
    headerBytes: hex(file.subarray(0x0b, 0x40)),
    id: { sum, checksum1, checksum2, checksum1Ok: checksum1 === sum },
    indexTableChecksumOk,
    indexTableCopyEqual,
    notes,
    problems,
  };
}

export interface PayloadStats {
  length: number;
  /** Shannon entropy in bits per byte: 8 is uniformly random. */
  entropy: number;
  zeroBytes: number;
  distinctBytes: number;
  /** Highest fraction of equal bytes at one distance over distances 1..512; a random payload stays near 1/256. */
  bestRepeatFraction: number;
}

export function payloadStats(data: Uint8Array): PayloadStats {
  const counts = new Array<number>(256).fill(0);
  for (const b of data) counts[b]!++;
  let entropy = 0;
  for (const c of counts) if (c > 0) entropy -= (c / data.length) * Math.log2(c / data.length);
  let best = 0;
  for (let k = 1; k <= 512 && k < data.length; k++) {
    let equal = 0;
    for (let i = 0; i + k < data.length; i++) if (data[i] === data[i + k]) equal++;
    best = Math.max(best, equal / (data.length - k));
  }
  return {
    length: data.length,
    entropy: Math.round(entropy * 1000) / 1000,
    zeroBytes: counts[0]!,
    distinctBytes: counts.filter((c) => c > 0).length,
    bestRepeatFraction: Math.round(best * 10000) / 10000,
  };
}
