// Pictures between two game frames. The game module keeps a copy of RAM from the last graphics task; running its display
// list again with the camera's and the objects' matrices replaced by ones between the last two frames' draws the scene at
// another moment (see motion.ts). Everything here is display data: it is never part of a saved state.
import { readResult, type GfxGameCore } from './c-dl.ts';
import { interpolate, MotionTracker, writeOverrides, type MotionCore, type MotionPlan, type MotionStats } from './motion.ts';
import type { DisplayListResult } from './types.ts';

/** The game module's exports for smoothing (runtime/gfx/task.c, gfx.h). */
export interface SmoothCore extends GfxGameCore, MotionCore {
  _gfx_keep(): void;
  _gfx_run_kept(start: number): number;
  _gfx_forget_kept(): void;
}

/**
 * How far between two kept game frames the picture for time `now` is, with times counted in video frames: the frames ran at
 * `before` and `kept` (the video frame each graphics task ran in). At `kept` the picture is the previous game frame and it
 * reaches the kept one a game-frame interval later, so what is on screen is always one game-frame interval old: the latency
 * smoothing adds. A game frame that is late leaves the picture at the kept frame.
 */
export function smoothFraction(now: number, kept: number, before: number): number {
  const period = Math.max(1, kept - before);
  return Math.min(1, Math.max(0, (now - kept) / period));
}

export class SmoothFrames {
  private readonly tracker = new MotionTracker();
  private start = 0;
  private kept = false;

  constructor(private readonly core: SmoothCore) {}

  /** Whether a game frame is kept to draw pictures from. */
  get ready(): boolean {
    return this.kept;
  }

  /** Matches of the current frame against the previous one, or null while there is only one frame. */
  get plan(): MotionPlan | null {
    return this.tracker.plan;
  }

  get stats(): MotionStats | null {
    return this.tracker.plan?.stats ?? null;
  }

  /** Share of the current frame's vertices the game wrote itself rather than moved by a matrix. */
  get rewritten(): number {
    return this.tracker.rewritten;
  }

  /**
   * Keeps the graphics task whose display list starts at `start` (call it while the game is inside the task, when RAM holds
   * the task's data) and takes its matrices as the current frame. Nothing is drawn.
   */
  push(start: number): void {
    const core = this.core;
    core._gfx_keep();
    this.start = start >>> 0;
    this.kept = true;
    writeOverrides(core, []);
    core._gfx_motion_record(1);
    core._gfx_run_kept(this.start);
    core._gfx_motion_record(0);
    this.tracker.push(core);
  }

  /**
   * The kept frame as the display list gives it, with the matrices `t` of the way from the previous frame to it (t = 1: as it
   * is). `plan` replaces the one made from the last two frames, to try other motion on the same frame.
   */
  at(t: number, plan: MotionPlan | null = this.tracker.plan): DisplayListResult {
    if (!this.kept) throw new Error('no game frame is kept');
    const core = this.core;
    writeOverrides(core, plan ? interpolate(plan, t) : []);
    core._gfx_motion_record(0);
    core._gfx_run_kept(this.start);
    return readResult(core);
  }

  /** Drops the kept frames (a saved state was loaded or taken, or smoothing was switched off). */
  forget(): void {
    this.tracker.reset();
    this.kept = false;
    writeOverrides(this.core, []);
    this.core._gfx_forget_kept();
  }
}

/** The colour image a graphics task leaves finished: where its last draw went, not counting clears of the depth image. */
export function finalColorImage(result: DisplayListResult): number | null {
  for (let i = result.batches.length - 1; i >= 0; i--) {
    const state = result.batches[i]!.state;
    const address = state.colorImage.addr & 0x1fffffff;
    if (address !== (state.depthImage & 0x1fffffff)) return address;
  }
  return null;
}
