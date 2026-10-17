import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACK_HEADER_SIZE, packImage, readPackHeader, sha256Hex, unpackImage } from './pack.ts';
import { writePack } from './write.ts';

const image = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) & 0xff);

describe('pack', () => {
  it('round-trips an image byte for byte and names its size and hash in the header', async () => {
    const pack = await packImage(image);
    expect(pack.length).toBe(PACK_HEADER_SIZE + image.length);
    expect(readPackHeader(pack)).toEqual({ size: image.length, sha256: await sha256Hex(image) });
    expect(Buffer.from(await unpackImage(pack)).equals(Buffer.from(image))).toBe(true);
  });

  it('is written to disk whole, with no temporary file left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oot-pack-'));
    try {
      await writePack(image, join(dir, 'game.pack'));
      const back = new Uint8Array(readFileSync(join(dir, 'game.pack')));
      expect(Buffer.from(await unpackImage(back)).equals(Buffer.from(image))).toBe(true);
      expect(() => readFileSync(join(dir, 'game.pack.tmp'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not a pack', async () => {
    await expect(unpackImage(new Uint8Array(PACK_HEADER_SIZE + 10))).rejects.toThrow(/not a game pack.*npm run port/);
    await expect(unpackImage(new Uint8Array(3))).rejects.toThrow(/not a game pack/);
  });

  it('refuses a truncated or extended pack, naming both sizes', async () => {
    const pack = await packImage(image);
    await expect(unpackImage(pack.subarray(0, pack.length - 1))).rejects.toThrow(/has 1063 bytes but its header says 1064.*npm run port/);
    await expect(unpackImage(new Uint8Array([...pack, 0]))).rejects.toThrow(/has 1065 bytes but its header says 1064/);
  });

  it('refuses an image whose bytes changed', async () => {
    const pack = await packImage(image);
    pack[PACK_HEADER_SIZE + 500]! ^= 1;
    await expect(unpackImage(pack)).rejects.toThrow(/does not match its hash.*npm run port/);
  });
});
