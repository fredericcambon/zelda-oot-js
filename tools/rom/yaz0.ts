export const YAZ0_HEADER_SIZE = 16;

export function isYaz0(data: Uint8Array, offset = 0): boolean {
  return (
    data.length >= offset + 4 &&
    data[offset] === 0x59 &&
    data[offset + 1] === 0x61 &&
    data[offset + 2] === 0x7a &&
    data[offset + 3] === 0x30
  );
}

/**
 * Decodes a Yaz0 stream: "Yaz0", big-endian decoded size, 8 reserved bytes,
 * then groups of one flag byte (MSB first) followed by up to 8 items.
 * A set flag bit is a literal byte. A clear bit is a back reference in two
 * bytes `NR RR`: distance = (low nibble of NR << 8 | RR) + 1, length = N + 2,
 * or, when N is 0, a third byte gives length = byte + 0x12.
 */
export function yaz0Decode(src: Uint8Array, offset = 0): Uint8Array {
  if (!isYaz0(src, offset)) throw new Error('missing Yaz0 magic');
  if (src.length < offset + YAZ0_HEADER_SIZE) throw new Error('truncated Yaz0 header');
  const size = new DataView(src.buffer, src.byteOffset + offset + 4, 4).getUint32(0);
  const out = new Uint8Array(size);
  let ip = offset + YAZ0_HEADER_SIZE;
  let op = 0;
  while (op < size) {
    if (ip >= src.length) throw new Error('truncated Yaz0 stream');
    const flags = src[ip++]!;
    for (let bit = 0x80; bit !== 0 && op < size; bit >>= 1) {
      if (flags & bit) {
        if (ip >= src.length) throw new Error('truncated Yaz0 stream');
        out[op++] = src[ip++]!;
        continue;
      }
      if (ip + 2 > src.length) throw new Error('truncated Yaz0 stream');
      const b1 = src[ip++]!;
      const b2 = src[ip++]!;
      const dist = (((b1 & 0x0f) << 8) | b2) + 1;
      let len = b1 >> 4;
      if (len === 0) {
        if (ip >= src.length) throw new Error('truncated Yaz0 stream');
        len = src[ip++]! + 0x12;
      } else {
        len += 2;
      }
      if (dist > op) throw new Error(`Yaz0 back reference before start of output at ${op}`);
      if (op + len > size) throw new Error('Yaz0 run overflows the declared size');
      for (let i = 0; i < len; i++, op++) out[op] = out[op - dist]!;
    }
  }
  return out;
}
