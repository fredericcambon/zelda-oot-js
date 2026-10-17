// Milestones of the page load, in milliseconds since the navigation started (performance.now() counts from there).
export const MILESTONES = ['manifest', 'cartridge', 'compiled', 'instantiated', 'firstFrame'] as const;
export type Milestone = (typeof MILESTONES)[number];

const marks: Partial<Record<Milestone, number>> = {};

// A page driven by a test reads the same numbers the overlay shows.
(globalThis as { ootTiming?: unknown }).ootTiming = marks;

export function mark(name: Milestone): void {
  marks[name] ??= performance.now();
}

/** The overlay lines: the time of each milestone reached, ending with the total to the first game frame. */
export function timingLines(): string[] {
  const parts = MILESTONES.filter((m) => marks[m] !== undefined).map((m) => `${m} ${marks[m]!.toFixed(0)}`);
  if (parts.length === 0) return [];
  const total = marks.firstFrame;
  return [`load (ms): ${parts.join('  ')}`, total === undefined ? 'load: in progress' : `first frame after ${total.toFixed(0)} ms`];
}
