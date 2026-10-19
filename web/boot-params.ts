// URL parameters that set up the game at boot: `state` loads a save-state slot, `file` enters a save file of the cartridge's
// save memory, `warp` goes to an entrance (docs/web.md).
import { AutoStart, fileSelectReached, sceneRunning, type GuestRam } from '../tools/headless/load-save.ts';
import { ENTRANCE_COUNT } from '../tools/headless/state.ts';
import { Button, STICK_MAX, type PadState } from './input.ts';
import { SLOT_COUNT } from './savestate.ts';

export const FILE_COUNT = 3;

export interface BootParams {
  /** Save-state slot, 1-4. */
  state?: number;
  /** Save file, 1-3. */
  file?: number;
  /** Entrance table index. */
  warp?: number;
  /** One message per parameter that is present but unusable; those parameters are left out. */
  problems: string[];
}

function parseNumber(text: string): number {
  const t = text.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

export function parseBootParams(search: string): BootParams {
  const query = new URLSearchParams(search);
  const out: BootParams = { problems: [] };
  const read = (name: string, max: number, min: number, what: string): number | undefined => {
    const raw = query.get(name);
    if (raw === null) return undefined;
    const n = parseNumber(raw);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    out.problems.push(`${name}=${raw}: ${what}`);
    return undefined;
  };
  out.state = read('state', SLOT_COUNT, 1, `there are save-state slots 1 to ${SLOT_COUNT}`);
  out.file = read('file', FILE_COUNT, 1, `there are save files 1 to ${FILE_COUNT}`);
  out.warp = read('warp', ENTRANCE_COUNT - 1, 0, `there is no such entrance (0 to ${ENTRANCE_COUNT - 1}, decimal or 0x hex)`);
  return out;
}

/** Frames between the file select appearing and the first button: its screens ignore input while they fade in (the scripted boot waits 250 frames after Start, docs/re/input.md). */
const SETTLE = 200;
const MOVE_HOLD = 4;
const MOVE_GAP = 24;
const PRESS_HOLD = 6;
const PRESS_EVERY = 100;

export type EntryResult = 'running' | 'entered' | 'at-file-select' | 'gave-up';

/**
 * Takes a game that just started over through the title and the file select with the inputs a player gives: Start at the
 * title, the stick down to the file, A to open it and A on "Yes". With `slot` null it stops at the file select. One `step`
 * per frame, before the frame runs.
 */
export class FileEntry {
  private result: EntryResult = 'running';
  private waited = 0;
  private readonly title: AutoStart;

  /** `slot` is 0-2 or null; `ram` gives the guest memory as of now. It gives up `limit` frames after the file select appeared. */
  constructor(private readonly slot: number | null, private readonly ram: () => GuestRam, private readonly limit = 1800) {
    this.title = new AutoStart(() => fileSelectReached(ram()), 3000);
  }

  get outcome(): EntryResult {
    return this.result;
  }

  step(): PadState {
    const none: PadState = { buttons: 0, x: 0, y: 0 };
    if (this.result !== 'running') return none;
    if (this.waited === 0 && this.title.active) {
      const buttons = this.title.buttons();
      if (this.title.active) return { ...none, buttons };
      if (!fileSelectReached(this.ram())) {
        this.result = 'gave-up';
        return none;
      }
    }
    if (sceneRunning(this.ram())) {
      this.result = 'entered';
      return none;
    }
    if (this.slot === null) {
      this.result = 'at-file-select';
      return none;
    }
    const t = this.waited++ - SETTLE;
    if (t >= this.limit) {
      this.result = 'gave-up';
      return none;
    }
    if (t < 0) return none;
    const moves = this.slot;
    if (t < moves * (MOVE_HOLD + MOVE_GAP)) return { buttons: 0, x: 0, y: t % (MOVE_HOLD + MOVE_GAP) < MOVE_HOLD ? -STICK_MAX : 0 };
    const u = t - moves * (MOVE_HOLD + MOVE_GAP);
    return { buttons: u % PRESS_EVERY < PRESS_HOLD ? Button.A : 0, x: 0, y: 0 };
  }
}
