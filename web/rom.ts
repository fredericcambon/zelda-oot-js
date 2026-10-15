// Loads the ROM the user picked and checks it is the supported one. The bytes never leave the page.
export const ROM_SHA1 = '328a1f1beba30ce5e178f031662019eb32c5f3b5';

export async function sha1Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Hashing needs a secure context: open the page through localhost or https');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', data as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the file and returns its bytes when its SHA-1 is the supported ROM's. */
export async function readRom(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha1Hex(bytes);
  if (hash !== ROM_SHA1) {
    throw new Error(`This is not the supported ROM (Ocarina of Time, PAL 1.0, big-endian .z64). SHA-1 is ${hash}.`);
  }
  return bytes;
}
