export type ByteOrder = 'z64' | 'v64' | 'n64';

// First word of the header as stored in each order. Big-endian reads 80 37 12 40.
const MAGIC: Record<ByteOrder, readonly number[]> = {
  z64: [0x80, 0x37, 0x12, 0x40],
  v64: [0x37, 0x80, 0x40, 0x12],
  n64: [0x40, 0x12, 0x37, 0x80],
};

export function detectByteOrder(data: Uint8Array): ByteOrder {
  if (data.length < 4) throw new Error('ROM is too small to hold a header');
  for (const order of Object.keys(MAGIC) as ByteOrder[]) {
    if (MAGIC[order].every((b, i) => data[i] === b)) return order;
  }
  const head = Array.from(data.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`unrecognised ROM byte order (first bytes: ${head})`);
}

/** Returns a new big-endian (.z64) copy of the image. */
export function toBigEndian(data: Uint8Array, order: ByteOrder = detectByteOrder(data)): Uint8Array {
  if (data.length % 4 !== 0) throw new Error('ROM size is not a multiple of 4 bytes');
  const out = new Uint8Array(data.length);
  switch (order) {
    case 'z64':
      out.set(data);
      break;
    case 'v64':
      for (let i = 0; i < data.length; i += 2) {
        out[i] = data[i + 1]!;
        out[i + 1] = data[i]!;
      }
      break;
    case 'n64':
      for (let i = 0; i < data.length; i += 4) {
        out[i] = data[i + 3]!;
        out[i + 1] = data[i + 2]!;
        out[i + 2] = data[i + 1]!;
        out[i + 3] = data[i]!;
      }
      break;
  }
  return out;
}
