// Per-phase frame timing shared by the browser and the headless CLI. A game frame is one graphics task; the samples are
// averaged over the last WINDOW of them.
import type { DisplayListResult } from './dl.ts';

export const WINDOW = 60;

/** Fixed-size ring of the last `size` samples with a running sum, so reading the mean costs nothing. */
export class RollingMean {
  private readonly values: Float64Array;
  private next = 0;
  private filled = 0;
  private total = 0;

  constructor(readonly size = WINDOW) {
    this.values = new Float64Array(size);
  }

  push(v: number): void {
    this.total += v - this.values[this.next]!;
    this.values[this.next] = v;
    this.next = (this.next + 1) % this.size;
    if (this.filled < this.size) this.filled++;
  }

  get count(): number {
    return this.filled;
  }

  /** Mean of the samples held, or 0 when there are none. */
  get mean(): number {
    return this.filled === 0 ? 0 : this.total / this.filled;
  }
}

export interface FrameBreakdown {
  /** Game frames the means cover. */
  frames: number;
  /** Milliseconds per game frame running the game code: the frame call minus the time in the hooks. */
  game: number;
  /** Milliseconds per game frame interpreting display lists. */
  displayList: number;
  /** Milliseconds per game frame submitting to the renderer (drawing the task, presenting), or null when no renderer is attached. */
  submit: number | null;
  /** Milliseconds of GPU time per game frame, or null when the browser cannot measure it. */
  gpu: number | null;
  drawCalls: number;
}

type Clock = () => number;

/**
 * Splits the time of each game frame into game code, display-list processing and renderer submission. The hooks the game
 * calls from inside its frame (graphics, audio) are timed with `hook`; whatever is left of the frame call is game code.
 */
export class FrameProfiler {
  private readonly game: RollingMean;
  private readonly dl: RollingMean;
  private readonly submit: RollingMean;
  private readonly draws: RollingMean;
  private readonly gpu: RollingMean;
  private hookMs = 0;
  private pending = { game: 0, dl: 0, submit: 0, draws: 0 };
  private tasks = 0;
  private submitted = false;

  constructor(private readonly now: Clock = () => performance.now(), window = WINDOW) {
    this.game = new RollingMean(window);
    this.dl = new RollingMean(window);
    this.submit = new RollingMean(window);
    this.draws = new RollingMean(window);
    this.gpu = new RollingMean(window);
  }

  /** Runs `fn`, a hook called from inside the frame, and returns its result. Its time is excluded from the game code's. */
  hook<T>(fn: () => T): T {
    const t0 = this.now();
    try {
      return fn();
    } finally {
      this.hookMs += this.now() - t0;
    }
  }

  /** Display-list time of the graphics task being handled, measured by the caller inside a `hook`. */
  addDisplayList(ms: number): void {
    this.pending.dl += ms;
  }

  /** Renderer submission time (drawing a task, presenting) and the draw calls it made. */
  addSubmit(ms: number, draws = 0): void {
    this.submitted = true;
    this.pending.submit += ms;
    this.pending.draws += draws;
  }

  /** Draw calls of the task being handled, when no renderer is attached to count them. */
  addDrawCalls(n: number): void {
    this.pending.draws += n;
  }

  /** Marks that a graphics task was handled during the current frame call. */
  taskDone(): void {
    this.tasks++;
  }

  addGpu(ms: number): void {
    this.gpu.push(ms);
  }

  /** Times one call of the game's frame function, `fn`, and closes a game frame when it handled a graphics task. */
  async frame<T>(fn: () => Promise<T> | T): Promise<T> {
    const hooks0 = this.hookMs;
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.pending.game += Math.max(0, this.now() - t0 - (this.hookMs - hooks0));
      if (this.tasks > 0) this.close();
    }
  }

  private close(): void {
    const p = this.pending;
    this.game.push(p.game);
    this.dl.push(p.dl);
    this.submit.push(p.submit);
    this.draws.push(p.draws);
    this.pending = { game: 0, dl: 0, submit: 0, draws: 0 };
    this.tasks = 0;
  }

  /** Means over the last frames; `gpu` is null until a GPU sample arrived. */
  breakdown(): FrameBreakdown {
    return {
      frames: this.game.count,
      game: this.game.mean,
      displayList: this.dl.mean,
      submit: this.submitted ? this.submit.mean : null,
      gpu: this.gpu.count > 0 ? this.gpu.mean : null,
      drawCalls: this.draws.mean,
    };
  }
}

/** The WebGL draw calls the renderer makes for a task: one per non-empty triangle batch and per rectangle that is not a fill. */
export function drawCallsOf(result: DisplayListResult): number {
  let n = 0;
  for (const b of result.batches) {
    if (b.kind === 'triangles') {
      if (b.positions.length > 0) n++;
    } else if (b.kind !== 'fillrect' || ((b.state.otherModeH >>> 20) & 3) !== 3) n++;
  }
  return n;
}

const ms = (v: number) => v.toFixed(3);

/** The breakdown as lines of text; a null GPU time reads "n/a". */
export function formatBreakdown(b: FrameBreakdown): string[] {
  const total = b.game + b.displayList + (b.submit ?? 0);
  return [
    `per game frame, mean of ${b.frames}:`,
    `  game code     ${ms(b.game)} ms`,
    `  display lists ${ms(b.displayList)} ms`,
    `  submit        ${b.submit === null ? 'n/a' : `${ms(b.submit)} ms`}`,
    `  GPU           ${b.gpu === null ? 'n/a' : `${ms(b.gpu)} ms`}`,
    `  total (CPU)   ${ms(total)} ms`,
    `  draw calls    ${b.drawCalls.toFixed(1)}`,
  ];
}
