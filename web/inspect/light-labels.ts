// Actors the user marked as point-light sources, by id, kept in the browser's storage (never shipped).
import { defaultStore, type PrefStore } from '../ui/prefs.ts';

const KEY = 'zelda-oot-js:light-actors';

export function loadLightIds(store: PrefStore | null = defaultStore()): number[] {
  try {
    const raw: unknown = JSON.parse(store?.getItem(KEY) ?? 'null');
    return Array.isArray(raw) ? [...new Set(raw.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 0xffff))] : [];
  } catch {
    return [];
  }
}

export function saveLightIds(ids: readonly number[], store: PrefStore | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked: the marks last for this page only.
  }
}

/** The ids with `id` added, or removed when it is there. */
export const toggleId = (ids: readonly number[], id: number): number[] => (ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]);
