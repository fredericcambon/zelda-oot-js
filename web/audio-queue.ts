// Turns the game's audio buffers (stereo frames at about 32 kHz, arriving once per video frame) into the steady stream an
// audio device wants at its own rate. It runs inside the audio worklet, and is a plain class so it can be tested alone.

/** Converts 16-bit big-endian stereo frames, as the game leaves them in memory, to interleaved floats in -1..1. */
export function decodeStereo(bytes: Uint8Array): Float32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2) / 32768;
  return out;
}

export class ResamplingQueue {
  private ring: Float32Array;
  private written = 0;
  private read = 0;
  private srcHz = 32000;
  private playing = false;

  /**
   * @param capacityFrames frames the queue holds; older frames are dropped beyond that
   * @param targetSeconds queued audio the playback speed steers towards
   */
  constructor(private capacityFrames = 16384, private targetSeconds = 0.1) {
    this.ring = new Float32Array(capacityFrames * 2);
  }

  /** Seconds of audio waiting to be played. */
  get queuedSeconds(): number {
    return (this.written - this.read) / this.srcHz;
  }

  /** Adds interleaved stereo frames recorded at `hz`. */
  push(samples: Float32Array, hz: number): void {
    this.srcHz = hz;
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      const at = (this.written % this.capacityFrames) * 2;
      this.ring[at] = samples[i * 2]!;
      this.ring[at + 1] = samples[i * 2 + 1]!;
      this.written++;
    }
    if (this.written - this.read > this.capacityFrames) this.read = this.written - this.capacityFrames;
  }

  /**
   * Fills `left` and `right` for a device running at `outHz`. Playback starts once a short lead has queued, and runs
   * slightly fast or slow so that the queue stays near its target: the game produces audio in step with its own clock,
   * which is not the device's. Whatever the queue cannot supply is silence.
   */
  pull(left: Float32Array, right: Float32Array, outHz: number): void {
    const n = left.length;
    if (!this.playing && this.queuedSeconds >= this.targetSeconds / 2) this.playing = true;
    if (!this.playing) {
      left.fill(0);
      right.fill(0);
      return;
    }
    const error = this.queuedSeconds - this.targetSeconds;
    const speed = 1 + Math.max(-0.05, Math.min(0.05, error * 0.5));
    const step = (this.srcHz * speed) / outHz;
    for (let i = 0; i < n; i++) {
      const whole = Math.floor(this.read);
      if (whole + 1 >= this.written) {
        // Out of audio: wait for the lead to build up again.
        this.playing = false;
        left.fill(0, i);
        right.fill(0, i);
        return;
      }
      const f = this.read - whole;
      const a = (whole % this.capacityFrames) * 2, b = ((whole + 1) % this.capacityFrames) * 2;
      left[i] = this.ring[a]! * (1 - f) + this.ring[b]! * f;
      right[i] = this.ring[a + 1]! * (1 - f) + this.ring[b + 1]! * f;
      this.read += step;
    }
  }
}
