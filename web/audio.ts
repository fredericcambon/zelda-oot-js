// Sound output: an audio context with a worklet that plays the buffers the game queues. Browsers keep a context
// suspended until the page has seen a user gesture, so `resume` is called from the first key or click.
import workletUrl from './audio-worklet.ts?worker&url';
import { decodeStereo } from './audio-queue.ts';

export interface AudioSink {
  /** Queues 16-bit big-endian stereo frames recorded at `hz`. */
  push(bytes: Uint8Array, hz: number): void;
}

/** A tenth of a second of 8-bit mono silence as a WAV data URI. */
function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples).fill(0x80);
  const dv = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, 'RIFF'); dv.setUint32(4, 36 + samples, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  tag(36, 'data'); dv.setUint32(40, samples, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

export class AudioOutput implements AudioSink {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levels = new Float32Array(1024);
  private muted = false;
  private starting: Promise<AudioContext> | null = null;
  private keepAlive: HTMLAudioElement | null = null;
  private module = 'not loaded';
  private error = '';
  private pushed = 0;
  private worklet: { blocks: number; received: number; underruns: number; queued: number } | null = null;

  /** Creates the context and loads the worklet, once. A failure is forgotten so that the next gesture tries again. */
  private start(): Promise<AudioContext> {
    this.starting ??= (async () => {
      let context: AudioContext;
      try {
        context = new AudioContext({ latencyHint: 'interactive' });
      } catch (err) {
        this.error = `new AudioContext: ${String(err)}`;
        throw err;
      }
      // iOS Safari lets a context start only from a call made inside the gesture handler, not after the awaits below.
      this.context = context;
      void context.resume().catch(() => undefined);
      try {
        await context.audioWorklet.addModule(workletUrl);
        this.module = 'loaded';
      } catch (err) {
        this.module = `failed: ${String(err)}`;
        this.error = `addModule: ${String(err)}`;
        void context.close();
        throw err;
      }
      const node = new AudioWorkletNode(context, 'game-audio', { numberOfInputs: 0, outputChannelCount: [2] });
      const gain = context.createGain();
      gain.gain.value = this.muted ? 0 : 1;
      const analyser = context.createAnalyser();
      node.connect(gain).connect(context.destination);
      gain.connect(analyser);
      node.port.onmessage = (e: MessageEvent<NonNullable<AudioOutput['worklet']>>) => (this.worklet = e.data);
      this.node = node;
      this.gain = gain;
      this.analyser = analyser;
      return context;
    })().catch((err: unknown) => {
      this.starting = null;
      this.context = null;
      this.error ||= String(err);
      throw err;
    });
    return this.starting;
  }

  /** Starts playing; call from a user gesture. */
  async resume(): Promise<void> {
    // `audioSession` (iOS 17) makes web audio ignore the ringer switch.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    // Older iOS ignores `audioSession`; a playing media element moves the page to the playback category, which the
    // ringer switch does not mute.
    if (!this.keepAlive) {
      const el = new Audio(silentWav());
      el.loop = true;
      el.setAttribute('playsinline', '');
      this.keepAlive = el;
    }
    void this.keepAlive.play().catch(() => undefined);
    if (this.context && this.context.state !== 'running') void this.context.resume().catch(() => undefined);
    const context = await this.start();
    if (context.state !== 'running') await context.resume();
  }

  /** Lines for the debug overlay: everything needed to tell why there is no sound. */
  status(): string[] {
    const c = this.context;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const w = this.worklet;
    return [
      `audio context ${c?.state ?? 'not created'}  rate ${c ? `${c.sampleRate} Hz (requested: device default)` : '-'}  base latency ${c ? c.baseLatency.toFixed(3) : '-'} s`,
      `audio worklet ${this.module}  ${workletUrl}`,
      `audio frames pushed ${this.pushed}${w ? `  played ${w.blocks * 128} received ${w.received} queued ${w.queued.toFixed(3)} s underruns ${w.underruns}` : '  (no worklet report yet)'}`,
      this.error ? `audio error: ${this.error}` : '',
      ios ? 'iOS: the ring/silent switch mutes web audio' : '',
    ].filter(Boolean);
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
    this.pushed += samples.length >> 1;
    this.node.port.postMessage({ samples, hz }, [samples.buffer]);
  }
}
