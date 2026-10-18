// Reads the PNG files the upscaler writes: 8-bit RGB or RGBA (also gray with or without alpha), not interlaced.
import { inflateSync } from 'node:zlib';
import type { RgbaImage } from '../gfx/types.ts';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(data: Uint8Array): RgbaImage {
  if (SIGNATURE.some((b, i) => data[i] !== b)) throw new Error('not a PNG file');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let width = 0, height = 0, type = -1;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= data.length; ) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...data.subarray(at + 4, at + 8));
    const body = data.subarray(at + 8, at + 8 + length);
    if (name === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[at + 16] !== 8 || data[at + 20] !== 0) throw new Error('only 8-bit, not interlaced PNG files are read');
      type = data[at + 17]!;
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[type];
  if (!channels || width === 0 || height === 0) throw new Error('unsupported PNG colour type');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? rows[y * stride + x - channels]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      rows[y * stride + x] = (v + predicted) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    if (channels >= 3) rgba.set([rows[s]!, rows[s + 1]!, rows[s + 2]!, channels === 4 ? rows[s + 3]! : 255], i * 4);
    else rgba.set([rows[s]!, rows[s]!, rows[s]!, channels === 2 ? rows[s + 1]! : 255], i * 4);
  }
  return { width, height, rgba };
}
