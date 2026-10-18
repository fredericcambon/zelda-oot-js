// Image operations of the x2 upscale: padding that continues a tile the way the game repeats it, bleeding colour under transparent texels,
// plain bilinear x2, and the pipeline that joins them around a model that doubles an opaque colour image.
import type { RgbaImage } from '../gfx/types.ts';
import type { AlphaKind, Edge } from './collect.ts';

/** Source index of coordinate `i` of an axis of length `n` under an edge rule (`i` may lie outside 0..n-1). */
export function edgeIndex(i: number, n: number, edge: Edge): number {
  if (edge === 'clamp') return Math.min(n - 1, Math.max(0, i));
  if (edge === 'wrap') return ((i % n) + n) % n;
  const m = ((i % (2 * n)) + 2 * n) % (2 * n);
  return m < n ? m : 2 * n - 1 - m;
}

/** `pad` texels more on every side, filled as a sampler would read them beyond the image. */
export function padImage(img: RgbaImage, pad: number, edgeS: Edge, edgeT: Edge): RgbaImage {
  const width = img.width + 2 * pad, height = img.height + 2 * pad;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = edgeIndex(y - pad, img.height, edgeT);
    for (let x = 0; x < width; x++) {
      const sx = edgeIndex(x - pad, img.width, edgeS);
      rgba.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

export function crop(img: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) rgba.set(img.rgba.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + width) * 4), row * width * 4);
  return { width, height, rgba };
}

/**
 * Gives every texel with `alpha(i) === 0` the colour of the nearest texel that has some, so that filtering across a cut-out's edge
 * mixes in the colour of the picture and never black or whatever the transparent texels held. Alpha is not changed.
 */
export function bleedColour(img: RgbaImage, transparent: (alpha: number) => boolean = (a) => a === 0): RgbaImage {
  const { width, height } = img;
  const rgba = img.rgba.slice();
  const done = new Uint8Array(width * height);
  let frontier: number[] = [];
  for (let i = 0; i < width * height; i++) if (!transparent(rgba[i * 4 + 3]!)) { done[i] = 1; frontier.push(i); }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width, y = (i / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx!, ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (done[j]) continue;
        done[j] = 1;
        rgba.set(rgba.subarray(i * 4, i * 4 + 3), j * 4);
        next.push(j);
      }
    }
    frontier = next;
  }
  return { width, height, rgba };
}

/** Weights of the four taps (at -1, 0, 1, 2 from the floor of the source position) of a Catmull-Rom cubic for a fractional offset `t`. */
const cubicWeights = (t: number): number[] => [
  ((-0.5 * t + 1) * t - 0.5) * t,
  (1.5 * t - 2.5) * t * t + 1,
  ((-1.5 * t + 2) * t + 0.5) * t,
  (0.5 * t - 0.5) * t * t,
];

/**
 * Plain x`scale` of every channel by separable bilinear or bicubic (Catmull-Rom) filtering, texel centres aligned (output texel o reads the input
 * at (o + 0.5) / scale - 0.5), edges clamped.
 */
export function resample(img: RgbaImage, scale: number, kernel: 'linear' | 'cubic'): RgbaImage {
  const taps = kernel === 'linear' ? 2 : 4, first = kernel === 'linear' ? 0 : -1;
  const pass = (src: Float32Array, w: number, h: number, horizontal: boolean): Float32Array => {
    const n = horizontal ? w : h, outN = n * scale;
    const out = new Float32Array(horizontal ? outN * h * 4 : w * outN * 4);
    for (let o = 0; o < outN; o++) {
      const f = (o + 0.5) / scale - 0.5, base = Math.floor(f), t = f - base;
      const weights = kernel === 'linear' ? [1 - t, t] : cubicWeights(t);
      for (let k = 0; k < (horizontal ? h : w); k++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let m = 0; m < taps; m++) {
            const at = Math.min(n - 1, Math.max(0, base + first + m));
            sum += weights[m]! * src[((horizontal ? k * w + at : at * w + k)) * 4 + c]!;
          }
          out[(horizontal ? k * outN + o : o * w + k) * 4 + c] = sum;
        }
      }
    }
    return out;
  };
  const wide = pass(Float32Array.from(img.rgba), img.width, img.height, true);
  const full = pass(wide, img.width * scale, img.height, false);
  const rgba = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i++) rgba[i] = Math.min(255, Math.max(0, Math.round(full[i]!)));
  return { width: img.width * scale, height: img.height * scale, rgba };
}

export interface UpscaleOptions {
  /** Texels of continuation added on every side before the model sees the picture (more than its reach, so the border is not a seam). */
  pad: number;
  /** Share of the model's output in the colour; the rest is plain bilinear. 1 is the model alone. */
  blend: number;
  /** Size of the result relative to the texture (the model's own factor). */
  scale: number;
}

export interface TextureFacts {
  edgeS: Edge;
  edgeT: Edge;
  alpha: AlphaKind;
  gray: boolean;
}

/** The padded, colour-bled opaque picture a model is asked to double. */
export function modelInput(img: RgbaImage, facts: TextureFacts, pad: number): RgbaImage {
  const padded = bleedColour(padImage(img, pad, facts.edgeS, facts.edgeT));
  const rgba = padded.rgba.slice();
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: padded.width, height: padded.height, rgba };
}

/**
 * The texture enlarged by `options.scale`. Colour comes from `modelOutput` (the model's enlargement of `modelInput(img, facts, pad)`) mixed with
 * plain bilinear enlargement of the same picture, cropped back to the texture's own area. Alpha never goes through the model: it is the padded
 * alpha enlarged by plain bicubic filtering and left as a gradient, so the game's alpha test (and the filter at the edge) meets the same
 * kind of ramp as with the original texture and a cut-out keeps its silhouette. Texels left transparent take the colour of their nearest
 * visible neighbour, so that no halo comes from them.
 */
export function upscaleTexture(img: RgbaImage, facts: TextureFacts, options: UpscaleOptions, modelOutput: RgbaImage): RgbaImage {
  const { pad, blend, scale } = options;
  const input = modelInput(img, facts, pad);
  if (modelOutput.width !== input.width * scale || modelOutput.height !== input.height * scale) throw new Error('the model output is not the input times the scale');
  const w = img.width * scale, h = img.height * scale;
  const model = crop(modelOutput, pad * scale, pad * scale, w, h);
  const plain = crop(resample(input, scale, 'linear'), pad * scale, pad * scale, w, h);
  const alpha = crop(resample(padImage(img, pad, facts.edgeS, facts.edgeT), scale, 'cubic'), pad * scale, pad * scale, w, h);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const mix = (c: number): number => Math.round(model.rgba[o + c]! * blend + plain.rgba[o + c]! * (1 - blend));
    let r = mix(0), g = mix(1), b = mix(2);
    if (facts.gray) r = g = b = Math.round((r + g + b) / 3);
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = alpha.rgba[o + 3]!;
  }
  return bleedColour({ width: w, height: h, rgba });
}

/**
 * How much more the picture changes across the wrap-around edge of an axis than between two neighbouring texels inside it: the mean absolute
 * difference (premultiplied colour and alpha, so what hides under transparent texels does not count) of the last and the first texel line divided
 * by the mean of all other neighbouring lines. About 1 means no seam.
 */
export function seamRatio(img: RgbaImage, axis: 'x' | 'y'): number {
  const n = axis === 'x' ? img.width : img.height, m = axis === 'x' ? img.height : img.width;
  const at = (i: number, j: number, c: number): number => {
    const o = (axis === 'x' ? j * img.width + i : i * img.width + j) * 4;
    return c === 3 ? img.rgba[o + 3]! : (img.rgba[o + c]! * img.rgba[o + 3]!) / 255;
  };
  const line = (a: number, b: number): number => {
    let sum = 0;
    for (let j = 0; j < m; j++) for (let c = 0; c < 4; c++) sum += Math.abs(at(a, j, c) - at(b, j, c));
    return sum / (m * 4);
  };
  let inside = 0;
  for (let i = 0; i + 1 < n; i++) inside += line(i, i + 1);
  inside /= Math.max(1, n - 1);
  return line(n - 1, 0) / Math.max(inside, 0.5);
}
