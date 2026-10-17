// The audio worklet: plays what the page posts to it. The page sends `{ samples, hz }` messages with interleaved stereo
// floats; the processor resamples them to the device's rate.
import { ResamplingQueue } from './audio-queue.ts';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

class GameAudioProcessor extends AudioWorkletProcessor {
  private queue = new ResamplingQueue();
  private received = 0;
  private blocks = 0;
  private underruns = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ samples: Float32Array; hz: number }>) => {
      this.received += e.data.samples.length >> 1;
      this.queue.push(e.data.samples, e.data.hz);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (left && right) {
      if (this.received > 0 && this.queue.queuedSeconds <= 0) this.underruns++;
      this.queue.pull(left, right, sampleRate);
    }
    // Progress report for the page's debug overlay, about four times a second.
    if (++this.blocks % 128 === 0) this.port.postMessage({ blocks: this.blocks, received: this.received, underruns: this.underruns, queued: this.queue.queuedSeconds });
    return true;
  }
}

registerProcessor('game-audio', GameAudioProcessor);
