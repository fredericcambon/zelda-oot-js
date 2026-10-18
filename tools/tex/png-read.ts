// Reads the 8-bit RGBA PNG that a canvas writes (no interlacing).
import { inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function decodePng(file: Uint8Array): Image {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0, height = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at < file.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== 8 || (body[9] !== 6 && body[9] !== 2) || body[12] !== 0) throw new Error('only 8-bit RGB or RGBA without interlacing');
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const channels = file[25] === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0, b = prev[i]!, c = i >= channels ? prev[i - channels]! : 0;
      let v = src[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    prev.set(line);
    for (let x = 0; x < width; x++) out.set([line[x * channels]!, line[x * channels + 1]!, line[x * channels + 2]!, channels === 4 ? line[x * channels + 3]! : 255], (y * width + x) * 4);
  }
  return { width, height, rgba: out };
}
