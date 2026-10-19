// Where the panel was left: width and open tab. It is folded to the icon rail on every load.

export const MIN_WIDTH = 280;
export const MAX_WIDTH = 600;
export const DEFAULT_WIDTH = 360;

const KEY = 'zelda-oot-js:panel';

export interface PanelPrefs {
  width: number;
  tab: string;
  collapsed: boolean;
}

/** The part of `Storage` the preferences need. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultStore(): PrefStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const clampWidth = (width: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

/** The stored preferences; anything missing or unreadable falls back to the default, and a tab that does not exist is dropped. */
export function loadPrefs(tabs: readonly string[], store: PrefStore | null = defaultStore()): PanelPrefs {
  const prefs: PanelPrefs = { width: DEFAULT_WIDTH, tab: tabs[0]!, collapsed: true };
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<PanelPrefs> | null;
    if (typeof raw?.width === 'number' && Number.isFinite(raw.width)) prefs.width = clampWidth(raw.width);
    if (typeof raw?.tab === 'string' && tabs.includes(raw.tab)) prefs.tab = raw.tab;
  } catch {
    // Unreadable storage or a damaged value: the defaults stay.
  }
  return prefs;
}

export function savePrefs(prefs: PanelPrefs, store: PrefStore | null = defaultStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be blocked; the layout then lasts until the page is closed.
  }
}
