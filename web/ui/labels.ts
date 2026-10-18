// Names the user typed for scenes, entrances, actors and fields. They are user data, kept apart from the names the notes prove.
import { defaultStore, type PrefStore } from './prefs.ts';

export const LABEL_KINDS = ['scene', 'entrance', 'actor', 'field'] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

const KEY = 'zelda-oot-js:labels';
export const MAX_LABEL = 80;

/** Kind, then id (a number in decimal, or a field key such as `items.3`), then the label. */
export type LabelData = Record<LabelKind, Record<string, string>>;

const empty = (): LabelData => ({ scene: {}, entrance: {}, actor: {}, field: {} });

const isKind = (k: string): k is LabelKind => (LABEL_KINDS as readonly string[]).includes(k);

/** Reads `{ kind: { id: label } }`; throws a message the user can read when the text is not that. */
export function parseLabels(text: string): LabelData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected an object of kinds');
  const data = empty();
  for (const [kind, ids] of Object.entries(raw)) {
    if (!isKind(kind)) throw new Error(`unknown kind "${kind}" (expected ${LABEL_KINDS.join(', ')})`);
    if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) throw new Error(`"${kind}" must map ids to labels`);
    for (const [id, label] of Object.entries(ids)) {
      if (typeof label !== 'string') throw new Error(`the label of ${kind} ${id} is not text`);
      const clean = label.trim().slice(0, MAX_LABEL);
      if (clean) data[kind][id] = clean;
    }
  }
  return data;
}

export class Labels {
  private data = empty();
  private listeners = new Set<() => void>();

  constructor(private readonly store: PrefStore | null = defaultStore()) {
    try {
      const text = store?.getItem(KEY);
      if (text) this.data = parseLabels(text);
    } catch {
      // Unreadable storage or a damaged value: start without labels.
    }
  }

  get(kind: LabelKind, id: string | number): string | undefined {
    return this.data[kind][String(id)];
  }

  /** An empty text removes the label. */
  set(kind: LabelKind, id: string | number, text: string): void {
    const clean = text.trim().slice(0, MAX_LABEL);
    const ids = { ...this.data[kind] };
    if (clean) ids[String(id)] = clean;
    else delete ids[String(id)];
    this.data = { ...this.data, [kind]: ids };
    this.changed();
  }

  count(): number {
    return LABEL_KINDS.reduce((n, k) => n + Object.keys(this.data[k]).length, 0);
  }

  exportJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /** Adds the labels of `text` to the stored ones (the imported label wins); returns how many were read. */
  importJson(text: string): number {
    const incoming = parseLabels(text);
    let n = 0;
    for (const kind of LABEL_KINDS) {
      n += Object.keys(incoming[kind]).length;
      this.data = { ...this.data, [kind]: { ...this.data[kind], ...incoming[kind] } };
    }
    this.changed();
    return n;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    try {
      this.store?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // Storage may be blocked; the labels then last until the page is closed.
    }
    for (const listener of [...this.listeners]) listener();
  }
}

/** The labels of the page, shared by every tab. */
export const labels = new Labels();
