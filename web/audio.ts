// Sound output: an audio context with a worklet that plays the buffers the game queues. Browsers keep a context
// suspended until the page has seen a user gesture, so `resume` is called from the first key or click.
import workletUrl from './audio-worklet.ts?worker&url';
import { decodeStereo } from './audio-queue.ts';

export interface AudioSink {
  /** Queues 16-bit big-endian stereo frames recorded at `hz`. */
  push(bytes: Uint8Array, hz: number): void;
}

export class AudioOutput implements AudioSink {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levels = new Float32Array(1024);
  private muted = false;
  private starting: Promise<AudioContext> | null = null;

  /** Creates the context and loads the worklet, once. A failure is forgotten so that the next gesture tries again. */
  private start(): Promise<AudioContext> {
    this.starting ??= (async () => {
      const context = new AudioContext({ latencyHint: 'interactive' });
      try {
        await context.audioWorklet.addModule(workletUrl);
      } catch (err) {
        void context.close();
        throw err;
      }
      const node = new AudioWorkletNode(context, 'game-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      const gain = context.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      const analyser = context.createAnalyser();
      node.connect(gain).connect(context.destination);
      gain.connect(analyser);
      this.context = context;
      this.node = node;
      this.gain = gain;
      this.analyser = analyser;
      return context;
    })().catch((err: unknown) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  /** Starts playing; call from a user gesture. */
  async resume(): Promise<void> {
    const context = await this.start();
    if (context.state === 'suspended') await context.resume();
  }

  get state(): string {
    return this.context?.state ?? 'off';
  }

  /** Root mean square of the last few milliseconds of output, 0 to 1. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levels);
    let sum = 0;
    for (const x of this.levels) sum += x * x;
    return Math.sqrt(sum / this.levels.length);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : 1;
    return this.muted;
  }

  push(bytes: Uint8Array, hz: number): void {
    if (!this.node || this.context?.state !== 'running') return;
    const samples = decodeStereo(bytes);
    this.node.port.postMessage({ samples, hz }, [samples.buffer]);
  }
}
