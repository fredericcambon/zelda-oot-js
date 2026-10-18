// The page's state that the panels show: the game loop writes it, the panels read it and re-draw when it changes.

export class Store<T extends object> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  get(): T {
    return this.value;
  }

  /** Merges `patch`; listeners run only when a field actually differs. */
  set(patch: Partial<T>): void {
    const changed = (Object.keys(patch) as (keyof T)[]).some((k) => !Object.is(this.value[k], patch[k]));
    if (!changed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
