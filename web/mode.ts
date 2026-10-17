// The video rate the game runs at: 50 Hz is the PAL cartridge as it is, 60 Hz boots it as an NTSC one (docs/re/tv-type.md).
// The choice is read when the game boots, so a change made on the page takes effect at the next page load.

export type Hz = 50 | 60;

const KEY = 'zelda-oot-js:60hz';

/** The part of `Storage` the preference needs. */
export interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): PreferenceStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The remembered rate; 60 when nothing is stored or the browser does not let the page read it. */
export function loadHz(store: PreferenceStore | null = defaultStore()): Hz {
  try {
    return store?.getItem(KEY) === '0' ? 50 : 60;
  } catch {
    return 60;
  }
}

/** Remembers the rate for the next page load; returns whether the browser kept it. */
export function saveHz(hz: Hz, store: PreferenceStore | null = defaultStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(KEY, hz === 60 ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds of real time one video frame lasts. */
export const frameMs = (hz: Hz): number => 1000 / hz;

/** Frames run at once to catch up after a stall. */
export const MAX_CATCH_UP_FRAMES = 3;

/** Turns elapsed real time into whole video frames to run, one per 1/hz s. */
export class FramePacer {
  private owed = 0;

  constructor(readonly hz: Hz) {}

  /** Adds `elapsedMs` and returns how many frames are due now; the debt is capped so that a stalled tab does not trigger a burst. */
  advance(elapsedMs: number): number {
    const period = frameMs(this.hz);
    this.owed = Math.min(this.owed + elapsedMs, period * MAX_CATCH_UP_FRAMES);
    const due = Math.floor(this.owed / period);
    this.owed -= due * period;
    return due;
  }

  /** How far into the next video frame real time is, from 0 to 1. */
  fraction(): number {
    return this.owed / frameMs(this.hz);
  }

  /** Forgets the time owed (fast-forward runs without pacing). */
  reset(): void {
    this.owed = 0;
  }
}
