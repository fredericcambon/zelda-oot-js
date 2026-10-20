// The colour images a graphics task draws that nothing displays, and their bytes as the RDP leaves them in RDRAM.
//
// The RDP writes what it draws into RDRAM; a renderer keeps its colour images apart from the guest's memory. The game reads some of them
// back: the pause menu copies the frame it paused on into one image and draws Link into another, then uses both as textures for as long
// as the page is open. A host that wants those textures right copies the images into the guest's memory after drawing the task.
import { CycleType, cycleTypeOf } from '../../web/shader.ts';
import type { Batch } from './types.ts';

/** A rectangle of an RGBA16 colour image, in pixels of the image. */
export interface ImageRegion {
  /** Physical address of the image's first pixel. */
  addr: number;
  /** Pixels per row of the image. */
  width: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const SCREEN_W = 320;
const SCREEN_H = 240;
const physical = (addr: number): number => addr & 0x1fffffff;

/**
 * The part of each colour image drawn into by `batches` that is not a screen (`isScreen`, an address the video interface scans out or
 * will) nor the depth buffer, for RGBA16 images only: a rectangle draw covers its own rectangle, a triangle draw its scissor.
 */
export function offscreenRegions(batches: readonly Batch[], isScreen: (addr: number) => boolean): ImageRegion[] {
  const regions = new Map<number, ImageRegion>();
  for (const b of batches) {
    const ci = b.state.colorImage;
    const addr = physical(ci.addr);
    if (ci.fmt !== 0 || ci.siz !== 2 || addr === physical(b.state.depthImage) || isScreen(addr)) continue;
    const sc = b.state.scissor;
    const full = sc.xl === 0 && sc.yl === 0;
    let x0 = full ? 0 : Math.max(0, sc.xh >> 2), y0 = full ? 0 : Math.max(0, sc.yh >> 2);
    let x1 = full ? SCREEN_W : Math.min(SCREEN_W, sc.xl >> 2), y1 = full ? SCREEN_H : Math.min(SCREEN_H, sc.yl >> 2);
    if (b.kind !== 'triangles') {
      const inclusive = cycleTypeOf(b.state.otherModeH) >= CycleType.COPY ? 1 : 0;
      x0 = Math.max(x0, b.xh >> 2);
      y0 = Math.max(y0, b.yh >> 2);
      x1 = Math.min(x1, Math.ceil(b.xl / 4) + inclusive);
      y1 = Math.min(y1, Math.ceil(b.yl / 4) + inclusive);
    }
    x1 = Math.min(x1, ci.width);
    if (x1 <= x0 || y1 <= y0) continue;
    const seen = regions.get(addr);
    if (!seen || seen.width !== ci.width) regions.set(addr, { addr, width: ci.width, x0, y0, x1, y1 });
    else {
      seen.x0 = Math.min(seen.x0, x0);
      seen.y0 = Math.min(seen.y0, y0);
      seen.x1 = Math.max(seen.x1, x1);
      seen.y1 = Math.max(seen.y1, y1);
    }
  }
  return [...regions.values()];
}

/** Writes `rgba` (`region`'s pixels, top row first) into `ram`, indexed by physical address, as RGBA5551 halfwords in the byte order of the console. */
export function writeRegion(ram: Uint8Array, region: ImageRegion, rgba: Uint8Array): void {
  const w = region.x1 - region.x0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const s = ((y - region.y0) * w + (x - region.x0)) * 4;
      const px = (Math.round((rgba[s]! * 31) / 255) << 11) | (Math.round((rgba[s + 1]! * 31) / 255) << 6) | (Math.round((rgba[s + 2]! * 31) / 255) << 1) | (rgba[s + 3]! >= 128 ? 1 : 0);
      const at = region.addr + (y * region.width + x) * 2;
      if (at + 2 > ram.length) return;
      ram[at] = px >>> 8;
      ram[at + 1] = px & 255;
    }
  }
}
