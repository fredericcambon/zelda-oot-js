// Cheat codes in the common N64 text format: 8 hex digits of address, 4 of value. The high byte of the address is the code
// type; the other 24 bits address RDRAM (the guest address is 0x80000000 | those bits).
//   80 / 81   write an 8-bit / 16-bit value, every frame
//   D0 / D1   run the next code only if the 8-bit / 16-bit value at the address is equal to the given value
//   D2 / D3   the same, if it is not equal
// A code is held by the freeze list, which writes it before every game frame.
import type { Condition, Freeze, FreezeList } from './freeze.ts';
import { RDRAM_END, hexAddress } from './memory.ts';

export interface Cheat {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
}

type Hold = Omit<Freeze, 'id' | 'owner'>;

const KINDS: Record<number, { size: 1 | 2; conditional: boolean; equal: boolean }> = {
  0x80: { size: 1, conditional: false, equal: true },
  0x81: { size: 2, conditional: false, equal: true },
  0xd0: { size: 1, conditional: true, equal: true },
  0xd1: { size: 2, conditional: true, equal: true },
  0xd2: { size: 1, conditional: true, equal: false },
  0xd3: { size: 2, conditional: true, equal: false },
};

/** The holds a code text stands for, or the reason it is not a valid code. */
export function parseCode(text: string): { holds: Hold[] } | { error: string } {
  const digits = text.replace(/\s+/g, '');
  if (digits === '') return { error: 'The code is empty' };
  if (!/^[0-9a-fA-F]+$/.test(digits)) return { error: 'A code is hexadecimal digits only (0-9, A-F)' };
  if (digits.length % 12 !== 0) return { error: 'Each line is 8 digits of address and 4 digits of value' };
  const holds: Hold[] = [];
  let pending: Condition[] = [];
  for (let i = 0; i < digits.length; i += 12) {
    const line = digits.slice(i, i + 12);
    const n = i / 12 + 1;
    const type = parseInt(line.slice(0, 2), 16);
    const kind = KINDS[type];
    if (!kind) return { error: `Line ${n}: code type ${line.slice(0, 2).toUpperCase()} is not supported (80, 81, D0-D3 are)` };
    const addr = (0x80000000 | parseInt(line.slice(2, 8), 16)) >>> 0;
    const value = parseInt(line.slice(8), 16);
    if (addr + kind.size > RDRAM_END) return { error: `Line ${n}: ${hexAddress(addr)} is outside the 8 MB of memory` };
    if (kind.size === 2 && addr % 2 !== 0) return { error: `Line ${n}: a 16-bit code needs an even address` };
    if (kind.size === 1 && value > 0xff) return { error: `Line ${n}: an 8-bit code has a value of 00 to FF (the digits are 00YY)` };
    if (kind.conditional) pending.push({ addr, size: kind.size, value, equal: kind.equal });
    else {
      holds.push({ addr, size: kind.size, value, ...(pending.length ? { when: pending } : {}) });
      pending = [];
    }
  }
  if (pending.length) return { error: 'A conditional code needs a code after it' };
  return { holds };
}

/** Makes the freeze list hold exactly what the enabled cheats say. */
export function applyCheats(freezes: FreezeList, cheats: readonly Cheat[]): void {
  for (const f of freezes.list()) if (f.owner?.startsWith('cheat:') && !cheats.some((c) => c.enabled && `cheat:${c.id}` === f.owner)) freezes.setOwned(f.owner, []);
  for (const c of cheats) {
    if (!c.enabled) continue;
    const parsed = parseCode(c.code);
    freezes.setOwned(`cheat:${c.id}`, 'holds' in parsed ? parsed.holds : []);
  }
}

const KEY = 'zelda-oot-js:cheats';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export function loadCheats(store: Store | null = defaultStore()): Cheat[] {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((c): Cheat[] => {
      const o = c as Partial<Cheat> | null;
      return o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.code === 'string' ? [{ id: o.id, name: o.name, code: o.code, enabled: o.enabled === true }] : [];
    });
  } catch {
    return [];
  }
}

export function saveCheats(cheats: readonly Cheat[], store: Store | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(cheats));
  } catch {
    // Storage is blocked or full: the cheats last until the page closes.
  }
}
