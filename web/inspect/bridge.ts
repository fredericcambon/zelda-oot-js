// What the page's tools use to look at and change the running game: guest memory, the check that says whether it may be
// changed now, the queue that runs changes between frames, and the values held across frames.
import { guestRam, unsafeReason, type GuestRam } from '../../tools/headless/load-save.ts';
import { FreezeList } from './freeze.ts';
import { ActionQueue, Refused } from './queue.ts';

export class Bridge {
  readonly queue = new ActionQueue();
  readonly freezes = new FreezeList();

  /** `ramOf` gives the 8 MB RDRAM view of the game that runs, or null while there is none; `check` is the safe-state check. */
  constructor(private readonly ramOf: () => Uint8Array | null, private readonly check: (mem: GuestRam) => string | undefined = unsafeReason) {}

  /** The guest memory, or null while no game runs. The view is valid until the next frame. */
  ram(): GuestRam | null {
    const bytes = this.ramOf();
    return bytes ? guestRam(bytes) : null;
  }

  /** The raw RDRAM bytes, or null while no game runs. The view is valid until the next frame. */
  bytes(): Uint8Array | null {
    return this.ramOf();
  }

  /** Why the game must not be changed now, or undefined when it may be. */
  unsafeReason(): string | undefined {
    const mem = this.ram();
    return mem ? this.check(mem) : 'no game is running';
  }

  /** The memory for a change; throws a refusal that says why when the game is not in a state that takes one. */
  writable(): GuestRam {
    const reason = this.unsafeReason();
    if (reason) throw new Refused(`Not now: ${reason}`);
    return this.ram()!;
  }

  /** Writes the held values; call between two frames. Nothing is written while the game is in a state that does not take changes. */
  applyFreezes(): void {
    if (this.freezes.list().length === 0) return;
    const mem = this.ram();
    if (mem && !this.check(mem)) this.freezes.apply(mem);
  }
}
