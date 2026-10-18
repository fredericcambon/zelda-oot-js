// Finds output that has stopped being music and repeats a short stretch exactly: the sign of a broken mixer or a sequence
// that restarts every frame. The mixer is deterministic, so a real stuck loop repeats bit for bit; music does not, even
// when a note holds, because the resampler's position and the envelopes keep moving.

/** The tail of the output that is compared with the same stretch one period earlier, in samples. */
const WINDOW = 8192;
/** Periods tried, in samples: a quarter of a buffer's worth up to a second at 32 kHz. */
const MIN_PERIOD = 64;
const MAX_PERIOD = 32000;
/** Fraction of the window that may differ before the period is rejected. */
const TOLERANCE = 0.002;
/** Peak-to-peak range below which the output counts as silence. */
const AUDIBLE = 512;

export interface ShortLoop {
  /** Samples after which the tail repeats. */
  period: number;
}

/** Mono samples of the whole run; returns the shortest period at which the last stretch repeats exactly, if any. */
export function findShortLoop(pcm: Int16Array): ShortLoop | undefined {
  if (pcm.length < WINDOW + MAX_PERIOD) return undefined;
  const end = pcm.length;
  let lo = 32767, hi = -32768;
  for (let i = end - WINDOW; i < end; i++) {
    const x = pcm[i]!;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (hi - lo < AUDIBLE) return undefined;
  const allowed = Math.floor(WINDOW * TOLERANCE);
  for (let period = MIN_PERIOD; period <= MAX_PERIOD; period++) {
    let misses = 0;
    for (let i = end - WINDOW; i < end && misses <= allowed; i++) if (pcm[i] !== pcm[i - period]) misses++;
    if (misses <= allowed) return { period };
  }
  return undefined;
}
