// URL parameters that set up the game at boot: `state` loads a save-state slot, `file` enters a save file of the cartridge's
// save memory, `warp` goes to an entrance (docs/web.md).
import { ENTRANCE_COUNT } from '../tools/headless/state.ts';
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
