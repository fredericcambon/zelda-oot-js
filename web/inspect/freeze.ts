// Values held in guest memory: written again before every game frame.
import type { GuestRam } from '../../tools/headless/load-save.ts';

export type FreezeSize = 1 | 2 | 4;

/** A condition on the bytes at `addr`: they are (or are not) equal to `value`. */
export interface Condition {
  addr: number;
  size: 1 | 2;
  value: number;
  equal: boolean;
}

export interface Freeze {
  id: number;
  addr: number;
  size: FreezeSize;
  value: number;
  /** Set on holds that belong to a group (a cheat code); `add` never replaces those. */
  owner?: string;
  /** Every condition must hold for the write to happen. */
  when?: readonly Condition[];
}

/** Writes `value` big-endian, as the guest stores it. */
export function writeValue(mem: GuestRam, addr: number, size: FreezeSize, value: number): void {
  if (size === 4) mem.write32(addr, value);
  else if (size === 2) {
    mem.write8(addr, (value >>> 8) & 0xff);
    mem.write8(addr + 1, value & 0xff);
  } else mem.write8(addr, value & 0xff);
}

function holds(mem: GuestRam, c: Condition): boolean {
  const now = c.size === 2 ? (mem.rd8(c.addr) << 8) | mem.rd8(c.addr + 1) : mem.rd8(c.addr);
  return (now === c.value) === c.equal;
}

export class FreezeList {
  private items: Freeze[] = [];
  private nextId = 1;

  /** Holds `size` bytes at `addr` at `value`; holding the same bytes again replaces the earlier value. */
  add(addr: number, size: FreezeSize, value: number): Freeze {
    const kept = this.items.filter((f) => f.owner !== undefined || f.addr !== addr || f.size !== size);
    const freeze = { id: this.nextId++, addr, size, value };
    this.items = [...kept, freeze];
    return freeze;
  }

  /** Replaces everything `owner` holds with `held`, in order. */
  setOwned(owner: string, held: readonly Omit<Freeze, 'id' | 'owner'>[]): void {
    this.items = [...this.items.filter((f) => f.owner !== owner), ...held.map((h) => ({ ...h, id: this.nextId++, owner }))];
  }

  remove(id: number): void {
    this.items = this.items.filter((f) => f.id !== id);
  }

  clear(): void {
    this.items = [];
  }

  list(): readonly Freeze[] {
    return this.items;
  }

  apply(mem: GuestRam): void {
    for (const f of this.items) if (!f.when || f.when.every((c) => holds(mem, c))) writeValue(mem, f.addr, f.size, f.value);
  }
}
