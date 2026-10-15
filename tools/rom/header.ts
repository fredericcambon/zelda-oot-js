export interface RomHeader {
  piConfig: number;
  clockRate: number;
  entryPoint: number;
  release: number;
  crc1: number;
  crc2: number;
  name: string;
  gameCode: string;
  version: number;
}

export const HEADER_SIZE = 0x40;

/** Parses the 0x40-byte header of a big-endian image. */
export function parseHeader(rom: Uint8Array): RomHeader {
  if (rom.length < HEADER_SIZE) throw new Error('ROM is too small to hold a header');
  const v = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
  const text = (off: number, len: number) =>
    new TextDecoder('latin1').decode(rom.subarray(off, off + len)).replace(/[\0 ]+$/, '');
  return {
    piConfig: v.getUint32(0x00),
    clockRate: v.getUint32(0x04),
    entryPoint: v.getUint32(0x08),
    release: v.getUint32(0x0c),
    crc1: v.getUint32(0x10),
    crc2: v.getUint32(0x14),
    name: text(0x20, 20),
    gameCode: text(0x3b, 4),
    version: rom[0x3f]!,
  };
}
