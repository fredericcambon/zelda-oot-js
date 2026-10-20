// Minimal PNG encoder (8-bit RGBA) for frame dumps.
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))];
  return Buffer.concat(parts);
}

/**
 * Smaller PNG of the same pixels: 8-bit RGB when every alpha is 255, each row filtered by the type with the smallest sum of
 * absolute residuals, and the best deflate level. Decoding gives back `rgba` exactly.
 */
export function encodePngSmall(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255);
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;
  const px = new Uint8Array(stride * height);
  if (opaque) for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) px.set(rgba.subarray(i, i + 3), o);
  else px.set(rgba);
  const header = new Uint8Array(13);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  header.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : px[y * stride + x]!);
  const raw = new Uint8Array((stride + 1) * height);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = at(x - bpp, y);
        const b = at(x, y - 1);
        const c = at(x - bpp, y - 1);
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const v = (px[y * stride + x]! - pred) & 255;
        row[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        raw[y * (stride + 1)] = f;
        raw.set(row, y * (stride + 1) + 1);
      }
    }
  }
  return Buffer.concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}
