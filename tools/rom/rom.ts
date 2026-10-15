import { createHash } from 'node:crypto';
import { detectByteOrder, toBigEndian, type ByteOrder } from './byteorder.ts';
import { parseHeader, type RomHeader } from './header.ts';

export const PAL_1_0_SHA1 = '328a1f1beba30ce5e178f031662019eb32c5f3b5';

export interface LoadedRom {
  data: Uint8Array;
  sourceOrder: ByteOrder;
  sha1: string;
  header: RomHeader;
}

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Normalises to big-endian and rejects any image that is not PAL 1.0. */
export function loadRom(raw: Uint8Array, expectedSha1 = PAL_1_0_SHA1): LoadedRom {
  const sourceOrder = detectByteOrder(raw);
  const data = toBigEndian(raw, sourceOrder);
  const sha1 = sha1Hex(data);
  if (sha1 !== expectedSha1) {
    throw new Error(
      `wrong ROM: SHA-1 is ${sha1}, expected ${expectedSha1} (Zelda: Ocarina of Time PAL 1.0). ` +
        'Only an unmodified PAL 1.0 dump is supported.',
    );
  }
  return { data, sourceOrder, sha1, header: parseHeader(data) };
}
