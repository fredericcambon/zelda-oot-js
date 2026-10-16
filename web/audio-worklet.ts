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

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ samples: Float32Array; hz: number }>) => this.queue.push(e.data.samples, e.data.hz);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0] ?? [];
    if (left && right) this.queue.pull(left, right, sampleRate);
    return true;
  }
}

registerProcessor('game-audio', GameAudioProcessor);
