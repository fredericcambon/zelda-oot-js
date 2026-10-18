// Values held in guest memory: written again before every game frame.
import type { GuestRam } from '../../tools/headless/load-save.ts';

export type FreezeSize = 1 | 2 | 4;

export interface Freeze {
  id: number;
  addr: number;
  size: FreezeSize;
  value: number;
}

/** Writes `value` big-endian, as the guest stores it. */
export function writeValue(mem: GuestRam, addr: number, size: FreezeSize, value: number): void {
  if (size === 4) mem.write32(addr, value);
  else if (size === 2) {
    mem.write8(addr, (value >>> 8) & 0xff);
    mem.write8(addr + 1, value & 0xff);
  } else mem.write8(addr, value & 0xff);
}

export class FreezeList {
  private items: Freeze[] = [];
  private nextId = 1;

  /** Holds `size` bytes at `addr` at `value`; holding the same bytes again replaces the earlier value. */
  add(addr: number, size: FreezeSize, value: number): Freeze {
    const kept = this.items.filter((f) => f.addr !== addr || f.size !== size);
    const freeze = { id: this.nextId++, addr, size, value };
    this.items = [...kept, freeze];
    return freeze;
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
    for (const f of this.items) writeValue(mem, f.addr, f.size, f.value);
  }
}
