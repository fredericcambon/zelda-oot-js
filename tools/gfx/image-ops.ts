// Small RGBA picture helpers for capture and comparison tools: crop, box downscale, difference statistics, contact sheet.
import type { RgbaImage } from './types.ts';

export interface Region { x: number; y: number; w: number; h: number }

export interface DiffStats {
  /** Mean absolute difference per colour channel, 0-255. */
  mean: number;
  /** Largest absolute difference of any colour channel. */
  max: number;
  /** Share of pixels (0-1) whose worst channel differs by more than the threshold. */
  share: number;
  /** Bounding box of those pixels, or null when none differ. */
  box: Region | null;
}

export const DIFF_THRESHOLD = 8;

export function parseRegion(text: string): Region {
  const p = text.split(',').map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v)) || p[2]! <= 0 || p[3]! <= 0) throw new Error(`bad region "${text}", expected x,y,w,h`);
  return { x: p[0]!, y: p[1]!, w: p[2]!, h: p[3]! };
}

/** The part of the picture inside the region, clamped to the picture. */
export function crop(img: RgbaImage, r: Region): RgbaImage {
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(img.width, Math.round(r.x + r.w)), y1 = Math.min(img.height, Math.round(r.y + r.h));
  const width = x1 - x0, height = y1 - y0;
  if (width <= 0 || height <= 0) throw new Error(`region ${r.x},${r.y},${r.w},${r.h} is outside the ${img.width}x${img.height} picture`);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1) * 4), y * width * 4);
  return { width, height, rgba };
}

/** Box-filter downscale so the longer side is at most `max`; pictures already small enough are returned as they are. */
export function downscale(img: RgbaImage, max: number): RgbaImage {
  const long = Math.max(img.width, img.height);
  if (long <= max) return img;
  const f = max / long;
  const width = Math.max(1, Math.round(img.width * f)), height = Math.max(1, Math.round(img.height * f));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * img.height) / height), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * img.width) / width), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / width));
      const sum = [0, 0, 0, 0];
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) for (let k = 0; k < 4; k++) sum[k]! += img.rgba[(sy * img.width + sx) * 4 + k]!;
      const n = (sy1 - sy0) * (sx1 - sx0);
      for (let k = 0; k < 4; k++) rgba[(y * width + x) * 4 + k] = Math.round(sum[k]! / n);
    }
  }
  return { width, height, rgba };
}

function sameSize(a: RgbaImage, b: RgbaImage): void {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`pictures differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
}

export function diffStats(a: RgbaImage, b: RgbaImage): DiffStats {
  sameSize(a, b);
  let sum = 0, max = 0, over = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let i = 0; i < a.width * a.height; i++) {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.rgba[i * 4 + k]! - b.rgba[i * 4 + k]!);
      sum += d;
      worst = Math.max(worst, d);
    }
    max = Math.max(max, worst);
    if (worst > DIFF_THRESHOLD) {
      over++;
      const x = i % a.width, y = (i - x) / a.width;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const n = a.width * a.height;
  return { mean: sum / (n * 3), max, share: over / n, box: over ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

/** Absolute per-channel difference, multiplied by `gain` and clamped; opaque. */
export function diffImage(a: RgbaImage, b: RgbaImage, gain = 4): RgbaImage {
  sameSize(a, b);
  const rgba = new Uint8Array(a.width * a.height * 4);
  for (let i = 0; i < a.width * a.height; i++) {
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.min(255, Math.abs(a.rgba[i * 4 + k]! - b.rgba[i * 4 + k]!) * gain);
    rgba[i * 4 + 3] = 255;
  }
  return { width: a.width, height: a.height, rgba };
}

export function formatDiff(s: DiffStats): string {
  const box = s.box ? `${s.box.x},${s.box.y},${s.box.w},${s.box.h}` : 'none';
  return `diff mean ${s.mean.toFixed(2)} max ${s.max} over${DIFF_THRESHOLD} ${(100 * s.share).toFixed(1)}% box ${box}`;
}

/** Pictures in a grid of `columns` cells, each cell the size of the largest picture; the sheet's longer side is at most `max`. */
export function contactSheet(images: RgbaImage[], columns: number, max: number): RgbaImage {
  const cols = Math.max(1, Math.min(columns, images.length)), rows = Math.ceil(images.length / cols);
  const cw = Math.max(...images.map((i) => i.width)), ch = Math.max(...images.map((i) => i.height));
  const width = cols * cw, height = rows * ch;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  images.forEach((img, n) => {
    const ox = (n % cols) * cw, oy = Math.floor(n / cols) * ch;
    for (let y = 0; y < img.height; y++) rgba.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * width + ox) * 4);
  });
  return downscale({ width, height, rgba }, max);
}
