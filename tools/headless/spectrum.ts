// Average magnitude spectrum of a mono signal, to compare the pitch content of two recordings.

/** In-place radix-2 FFT; `re` and `im` have the same power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const a = i + k, b = i + k + len / 2;
        const tr = re[b]! * wr - im[b]! * wi, ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** Mean magnitude of Hann-windowed blocks of `size` samples (half overlap); bin k lies at k * hz / size. Returns size / 2 bins. */
export function averageSpectrum(samples: ArrayLike<number>, size = 8192): Float64Array {
  const sum = new Float64Array(size / 2);
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  let blocks = 0;
  for (let at = 0; at + size <= samples.length; at += size / 2) {
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = samples[at + i]! * window[i]!;
    fft(re, im);
    for (let k = 0; k < size / 2; k++) sum[k]! += Math.hypot(re[k]!, im[k]!);
    blocks++;
  }
  return blocks ? sum.map((v) => v / blocks) : sum;
}

/** Cosine similarity of two spectra over the bins in [from, to), the second one read `stretch` times further up (1 compares them as they are). */
export function similarity(a: Float64Array, b: Float64Array, from: number, to: number, stretch = 1): number {
  let ab = 0, aa = 0, bb = 0;
  for (let k = from; k < to; k++) {
    const x = a[k]!, y = b[Math.round(k * stretch)] ?? 0;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return ab / Math.sqrt(aa * bb);
}

/** Root-mean-square level of each block of `block` samples. */
export function envelope(samples: ArrayLike<number>, block: number): Float64Array {
  const out = new Float64Array(Math.floor(samples.length / block));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < block; k++) s += samples[i * block + k]! ** 2;
    out[i] = Math.sqrt(s / block);
  }
  return out;
}

/**
 * How much faster `b` plays than `a`: the factor s (searched in [lo, hi]) for which b(t) best matches a(s * t + offset) over
 * the points `from` to `to` of `b`, with its correlation. Both are envelopes at the same sampling interval.
 */
export function playbackSpeed(a: ArrayLike<number>, b: ArrayLike<number>, from: number, to: number, lo = 0.8, hi = 1.4): { speed: number; correlation: number } {
  const at = (t: number): number => {
    const i = Math.floor(t);
    if (i < 0 || i + 1 >= a.length) return NaN;
    return a[i]! * (1 - (t - i)) + a[i + 1]! * (t - i);
  };
  let best = { speed: 0, correlation: -2 };
  for (let s = lo; s <= hi; s += 0.002) {
    for (let o = -3000; o <= 3000; o += 2) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
      for (let t = from; t < to; t += 3) {
        const x = b[t]!, y = at(s * (t - from) + from + o);
        if (Number.isNaN(y)) { n = 0; break; }
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
      }
      if (!n) continue;
      const c = (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
      if (c > best.correlation) best = { speed: s, correlation: c };
    }
  }
  return best;
}
