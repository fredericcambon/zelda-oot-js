// Runs the game's audio tasks through the mixer and keeps what the game queues to the audio interface, for the headless
// runner and its tests.
import type { AiBuffer, AudioTask } from '../headless/boot.ts';
import { Synth } from './synth.ts';

export class AudioCapture {
  private synth = new Synth();
  private chunks: Uint8Array[] = [];
  /** Sample rate of the last buffer the game queued; 0 before the first. */
  hz = 0;
  /** Set when the mixer rejected a command list. */
  error: Error | undefined;

  /** The options to pass to `bootGame`. */
  readonly hooks = {
    onAudioTask: (task: AudioTask) => {
      try {
        this.synth.run(task.ram, { list: task.data & 0x1fffffff, size: task.size, dataSegment: task.microcodeData & 0x1fffffff });
      } catch (err) {
        this.error ??= err instanceof Error ? err : new Error(String(err));
      }
    },
    onAiBuffer: (buffer: AiBuffer) => {
      this.hz = buffer.hz;
      const at = buffer.addr & 0x7fffff;
      this.chunks.push(buffer.ram.slice(at, at + buffer.length));
    },
  };

  /** Interleaved left and right samples queued so far. */
  samples(): Int16Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Int16Array(total / 2);
    let at = 0;
    for (const chunk of this.chunks) {
      const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let i = 0; i + 1 < chunk.length; i += 2) out[at++] = dv.getInt16(i);
    }
    return out;
  }
}
