import { describe, expect, it } from 'vitest';
import { decodeStereo, ResamplingQueue } from './audio-queue.ts';

/** A stereo ramp: the left channel counts up from `from`, the right counts down. */
function ramp(frames: number, from = 0): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = (from + i) / 100000;
    out[i * 2 + 1] = -(from + i) / 100000;
  }
  return out;
}

describe('decodeStereo', () => {
  it('reads big-endian 16-bit samples as floats', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x80, 0x00, 0x7f, 0xff]);
    expect(Array.from(decodeStereo(bytes))).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('honours the offset of a view into a larger buffer', () => {
    const backing = new Uint8Array([9, 9, 0x20, 0x00, 0x20, 0x00]);
    expect(Array.from(decodeStereo(backing.subarray(2)))).toEqual([0.25, 0.25]);
  });
});

describe('ResamplingQueue', () => {
  const pull = (q: ResamplingQueue, frames: number, hz: number) => {
    const left = new Float32Array(frames), right = new Float32Array(frames);
    q.pull(left, right, hz);
    return { left, right };
  };

  it('plays silence until a short lead has queued', () => {
    const q = new ResamplingQueue(8192, 0.1);
    q.push(ramp(100, 1), 32000);
    expect(Array.from(pull(q, 8, 32000).left)).toEqual(new Array(8).fill(0));
  });

  it('hands out the queued frames unchanged when the rates match and the queue is at its target', () => {
    const q = new ResamplingQueue(16384, 0.1);
    const input = ramp(3200, 0);
    q.push(input, 32000);
    const { left, right } = pull(q, 64, 32000);
    for (let i = 0; i < 64; i++) {
      expect(left[i]).toBeCloseTo(input[i * 2]!, 6);
      expect(right[i]).toBeCloseTo(input[i * 2 + 1]!, 6);
    }
  });

  it('interpolates when the device runs at another rate', () => {
    const q = new ResamplingQueue(16384, 0.1);
    q.push(ramp(3200, 0), 32000);
    // A device at twice the rate gets two outputs per input frame: the second lies halfway to the next.
    const { left } = pull(q, 8, 64000);
    expect(left[0]).toBeCloseTo(0, 6);
    expect(left[1]).toBeCloseTo(0.5 / 100000, 6);
    expect(left[2]).toBeCloseTo(1 / 100000, 6);
  });

  it('runs a little fast when the queue is over its target and a little slow when under', () => {
    const over = new ResamplingQueue(16384, 0.1);
    over.push(ramp(8000), 32000);
    const fast = pull(over, 1000, 32000).left;
    const under = new ResamplingQueue(16384, 0.1);
    under.push(ramp(2000), 32000);
    const slow = pull(under, 1000, 32000).left;
    expect(fast[999]! * 100000).toBeGreaterThan(999);
    expect(slow[999]! * 100000).toBeLessThan(999);
    expect(fast[999]! * 100000).toBeLessThan(999 * 1.06);
  });

  it('goes silent when it runs dry, and waits for a lead before playing again', () => {
    const q = new ResamplingQueue(16384, 0.1);
    q.push(ramp(3200, 1000), 32000);
    pull(q, 3198, 32000);
    const dry = pull(q, 16, 32000).left;
    expect(dry[15]).toBe(0);
    q.push(ramp(100, 0), 32000);
    expect(Array.from(pull(q, 4, 32000).left)).toEqual([0, 0, 0, 0]);
    q.push(ramp(3200, 5000), 32000);
    expect(pull(q, 4, 32000).left[0]).not.toBe(0);
  });

  it('keeps only the newest frames when more arrive than it holds', () => {
    const q = new ResamplingQueue(1000, 0.01);
    q.push(ramp(3000, 0), 32000);
    const first = pull(q, 1, 32000).left[0]!;
    expect(first * 100000).toBeGreaterThan(1999);
  });

  it('reports the time queued', () => {
    const q = new ResamplingQueue(16384, 0.1);
    q.push(ramp(3200), 32000);
    expect(q.queuedSeconds).toBeCloseTo(0.1, 6);
  });
});

describe('ResamplingQueue fed at 60 Hz', () => {
  /** Runs `seconds` of a page that makes one buffer per video frame, with the frames arriving unevenly, against a device at `outHz`. */
  function run(videoHz: number, seconds: number, outHz: number) {
    const srcHz = videoHz === 60 ? 32006 : 31995;
    const q = new ResamplingQueue();
    const left = new Float32Array(128), right = new Float32Array(128);
    let produced = 0, due = 0, silent = 0, started = false, peak = 0;
    const blocks = Math.floor((seconds * outHz) / 128);
    for (let b = 0; b < blocks; b++) {
      // The display delivers a frame late every seventh interval and two together the next time.
      const t = (b * 128) / outHz;
      due += (128 / outHz) * videoHz;
      let frames = Math.floor(due);
      due -= frames;
      if (Math.floor(t * videoHz) % 7 === 0) frames = 0;
      else if (Math.floor(t * videoHz) % 7 === 1) frames *= 2;
      for (let k = 0; k < frames; k++) {
        const n = Math.round(srcHz / videoHz);
        q.push(ramp(n, produced), srcHz);
        produced += n;
      }
      q.pull(left, right, outHz);
      if (started) silent += left.filter((x) => x === 0).length;
      else if (left.some((x) => x !== 0)) started = true;
      peak = Math.max(peak, q.queuedSeconds);
    }
    return { silent, peak, queued: q.queuedSeconds };
  }

  it.each([50, 60])('plays without running dry or overfilling at %i Hz', (hz) => {
    const { silent, peak, queued } = run(hz, 20, 48000);
    expect(silent).toBeLessThan(5);
    expect(peak).toBeLessThan(0.3);
    expect(queued).toBeGreaterThan(0.02);
  });
});
