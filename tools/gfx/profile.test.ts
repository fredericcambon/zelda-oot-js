import { describe, expect, it } from 'vitest';
import type { DisplayListResult } from './types.ts';
import { drawCallsOf, formatBreakdown, FrameProfiler, RollingMean } from './profile.ts';

describe('RollingMean', () => {
  it('is 0 with no sample and averages the samples held', () => {
    const m = new RollingMean(4);
    expect(m.mean).toBe(0);
    m.push(2);
    m.push(4);
    expect(m.count).toBe(2);
    expect(m.mean).toBe(3);
  });

  it('forgets the oldest sample once the window is full', () => {
    const m = new RollingMean(3);
    for (const v of [100, 1, 2, 3]) m.push(v);
    expect(m.count).toBe(3);
    expect(m.mean).toBe(2);
  });
});

/** A clock that advances only when told to. */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('FrameProfiler', () => {
  it('leaves the hooks out of the game code time and sums the phases of a frame', async () => {
    const clock = fakeClock();
    const p = new FrameProfiler(clock.now, 60);
    await p.frame(() => {
      clock.advance(1);
      p.hook(() => {
        clock.advance(3);
        p.addDisplayList(2);
        p.addSubmit(1, 7);
        p.taskDone();
      });
      clock.advance(0.5);
    });
    p.addSubmit(0.25);
    const b = p.breakdown();
    expect(b.frames).toBe(1);
    expect(b.game).toBeCloseTo(1.5);
    expect(b.displayList).toBe(2);
    expect(b.submit).toBe(1);
    expect(b.drawCalls).toBe(7);
    expect(b.gpu).toBeNull();
  });

  it('adds the retraces without a graphics task to the game frame that follows them', async () => {
    const clock = fakeClock();
    const p = new FrameProfiler(clock.now, 60);
    await p.frame(() => clock.advance(1));
    await p.frame(() => clock.advance(1));
    expect(p.breakdown().frames).toBe(0);
    await p.frame(() => {
      clock.advance(1);
      p.hook(() => p.taskDone());
    });
    const b = p.breakdown();
    expect(b.frames).toBe(1);
    expect(b.game).toBeCloseTo(3);
  });

  it('averages over the window only', async () => {
    const clock = fakeClock();
    const p = new FrameProfiler(clock.now, 2);
    for (const ms of [100, 2, 4]) {
      await p.frame(() => {
        clock.advance(ms);
        p.hook(() => p.taskDone());
      });
    }
    expect(p.breakdown().game).toBe(3);
  });

  it('reports the GPU mean once samples arrived and prints n/a before', () => {
    const p = new FrameProfiler(() => 0);
    expect(formatBreakdown(p.breakdown()).join('\n')).toMatch(/GPU\s+n\/a/);
    p.addGpu(1);
    p.addGpu(3);
    expect(p.breakdown().gpu).toBe(2);
    expect(formatBreakdown(p.breakdown()).join('\n')).toMatch(/GPU\s+2\.000 ms/);
  });

  it('has no submit time without a renderer', () => {
    const p = new FrameProfiler(() => 0);
    p.addDrawCalls(3);
    expect(p.breakdown().submit).toBeNull();
    expect(formatBreakdown(p.breakdown()).join('\n')).toMatch(/submit\s+n\/a/);
  });

  it('does not lose the hook time when a hook throws', async () => {
    const clock = fakeClock();
    const p = new FrameProfiler(clock.now);
    await p.frame(() => {
      expect(() => p.hook(() => { clock.advance(2); throw new Error('x'); })).toThrow('x');
      clock.advance(1);
      p.taskDone();
    });
    expect(p.breakdown().game).toBe(1);
  });
});

describe('drawCallsOf', () => {
  it('counts non-empty triangle batches and rectangles that are not fills', () => {
    const state = (cycle: number) => ({ otherModeH: cycle << 20 });
    const result = {
      batches: [
        { kind: 'triangles', positions: new Float32Array(12) },
        { kind: 'triangles', positions: new Float32Array(0) },
        { kind: 'fillrect', state: state(3) },
        { kind: 'fillrect', state: state(0) },
        { kind: 'texrect', state: state(2) },
      ],
    } as unknown as DisplayListResult;
    expect(drawCallsOf(result)).toBe(3);
  });
});
