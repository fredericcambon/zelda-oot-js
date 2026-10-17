// The packed game file: a 64-byte header followed by the cartridge image the game's DMA reads from. The header carries
// the image size and its SHA-256, so the page checks the file before boot and the server derives a cache validator
// from it. Only Web Crypto is used, so the page and Node read the format with the same code.
export const PACK_FILE = 'game.pack';
export const PACK_HEADER_SIZE = 64;
export const MISSING_PACK_MESSAGE = 'The game files are missing: run `npm run port -- --rom <path>` first';

const MAGIC = new TextEncoder().encode('OOTPACK1');
const SIZE_AT = 8;
const HASH_AT = 12;
const HASH_BYTES = 32;

export interface PackHeader {
  /** Byte length of the cartridge image after the header. */
  size: number;
  /** Hex SHA-256 of the cartridge image. */
  sha256: string;
}

const rebuild = 'run `npm run port -- --rom <path>` again';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
}

export function packHeader(image: Uint8Array, sha256: string): Uint8Array {
  const head = new Uint8Array(PACK_HEADER_SIZE);
  head.set(MAGIC);
  new DataView(head.buffer).setUint32(SIZE_AT, image.length);
  for (let i = 0; i < HASH_BYTES; i++) head[HASH_AT + i] = parseInt(sha256.slice(i * 2, i * 2 + 2), 16);
  return head;
}

/** The whole pack file for a cartridge image. */
export async function packImage(image: Uint8Array): Promise<Uint8Array> {
  const pack = new Uint8Array(PACK_HEADER_SIZE + image.length);
  pack.set(packHeader(image, await sha256Hex(image)));
  pack.set(image, PACK_HEADER_SIZE);
  return pack;
}

/** Reads the header at the start of `bytes` (at least `PACK_HEADER_SIZE` bytes of the file). */
export function readPackHeader(bytes: Uint8Array): PackHeader {
  if (bytes.length < PACK_HEADER_SIZE || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error(`The game file is not a game pack: ${rebuild}`);
  }
  return {
    size: new DataView(bytes.buffer, bytes.byteOffset).getUint32(SIZE_AT),
    sha256: hex(bytes.subarray(HASH_AT, HASH_AT + HASH_BYTES)),
  };
}

/** Checks the pack's size and hash and returns the cartridge image, a view into `pack`. */
export async function unpackImage(pack: Uint8Array): Promise<Uint8Array> {
  const header = readPackHeader(pack);
  if (pack.length !== PACK_HEADER_SIZE + header.size) {
    throw new Error(`The game file has ${pack.length} bytes but its header says ${PACK_HEADER_SIZE + header.size}: ${rebuild}`);
  }
  const image = pack.subarray(PACK_HEADER_SIZE);
  if ((await sha256Hex(image)) !== header.sha256) throw new Error(`The game file does not match its hash: ${rebuild}`);
  return image;
}
