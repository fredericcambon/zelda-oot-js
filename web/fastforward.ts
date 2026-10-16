// Holding Tab runs the game as fast as the page can, without sound.

export interface KeyLike {
  key: string;
  preventDefault(): void;
}

export class FastForward {
  private held = false;

  get active(): boolean {
    return this.held;
  }

  /** Returns whether the key was Tab. Tab's own action (moving focus) is always suppressed. */
  keydown(e: KeyLike): boolean {
    if (e.key !== 'Tab') return false;
    e.preventDefault();
    this.held = true;
    return true;
  }

  keyup(e: KeyLike): boolean {
    if (e.key !== 'Tab') return false;
    e.preventDefault();
    this.held = false;
    return true;
  }

  /** The page lost focus: a key release will not arrive. */
  reset(): void {
    this.held = false;
  }
}
