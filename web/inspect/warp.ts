// Jumping between scenes: the entrance table read from guest memory, the scene the game is in now, and the user's own
// bookmarks and scene labels (kept in the browser's storage, never shipped).
import type { GuestRam } from '../../tools/headless/load-save.ts';
import { ENTRANCE_COUNT, ENTRANCE_INDEX, ENTRANCE_TABLE, linkPosition, playState, requestEntrance, SETUP_VARIANT, type Vec3 } from '../../tools/headless/state.ts';
import { defaultStore, type PrefStore } from '../ui/prefs.ts';
import type { Bridge } from './bridge.ts';
import { Refused } from './queue.ts';

/** The scene table has 101 records: the record after them has start 0 and end `0xDB060020` (docs/re/title-cards.md; docs/re/gaps.md, "37 entries name a scene past the scene table (101 records)"). An entry naming a scene past it cannot be entered. */
export const SCENE_COUNT = 101;

export interface Entrance {
  /** Index in the entrance table. */
  entry: number;
  /** Byte 0 of the record; byte 1 is the spawn. */
  scene: number;
  spawn: number;
  /** The low halfword of the record; bit 0x4000 lets the scene's title card be drawn (docs/re/title-cards.md). */
  flags: number;
  /** False when the scene is past the scene table. */
  valid: boolean;
}

export function readEntrances(mem: GuestRam): Entrance[] {
  const rows: Entrance[] = [];
  for (let entry = 0; entry < ENTRANCE_COUNT; entry++) {
    const word = mem.rd32(ENTRANCE_TABLE + entry * 4);
    const scene = word >>> 24;
    rows.push({ entry, scene, spawn: (word >>> 16) & 0xff, flags: word & 0xffff, valid: scene < SCENE_COUNT });
  }
  return rows;
}

export interface Live {
  scene: number;
  /**
   * The table entry the scene was loaded from (entrance index plus setup variant, the sum the play state's init indexes the
   * table with); null when that entry does not name this scene, which is the case when the game redirected the entrance.
   */
  entry: number | null;
  position: Vec3 | null;
  /** The language byte of the save header (0 to 2), which picks the language of a title card. */
  language: number;
}

export interface WarpSnapshot {
  live: Live | null;
  /** Why a warp is refused now; undefined when it is allowed. */
  refusal: string | undefined;
}

/** The word holding the language byte (0x801197D9, docs/re/saves.md: save header offset 0x1409 from the entrance index word). */
const LANGUAGE_WORD = (ENTRANCE_INDEX + 0x1408) >>> 0;

export function readLive(mem: GuestRam): Live | null {
  const rd32 = (a: number) => mem.rd32(a);
  const play = playState(rd32);
  if (!play) return null;
  const entry = (rd32(ENTRANCE_INDEX) + rd32(SETUP_VARIANT)) >>> 0;
  const named = entry < ENTRANCE_COUNT && rd32(ENTRANCE_TABLE + entry * 4) >>> 24 === play.scene;
  return { scene: play.scene, entry: named ? entry : null, position: linkPosition(rd32, play) ?? null, language: (rd32(LANGUAGE_WORD) >>> 16) & 0xff };
}

export function snapshot(bridge: Bridge): WarpSnapshot {
  const mem = bridge.ram();
  return { live: mem ? readLive(mem) : null, refusal: bridge.unsafeReason() };
}

export function sameSnapshot(a: WarpSnapshot, b: WarpSnapshot): boolean {
  const p = (v: Vec3 | null) => (v ? `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}` : '');
  return a.refusal === b.refusal && a.live?.scene === b.live?.scene && a.live?.entry === b.live?.entry && p(a.live?.position ?? null) === p(b.live?.position ?? null) && a.live?.language === b.live?.language && !a.live === !b.live;
}

const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

/** The only name an entrance has: its numbers. */
export const entranceName = (scene: number, entry: number): string => `scene ${hex(scene, 2)} / entrance ${hex(entry, 3)}`;

/** Ends the running scene into table entry `entry`; call between frames. Throws a refusal that says why when it cannot. */
export function warpTo(bridge: Bridge, entry: number): string {
  if (!Number.isInteger(entry) || entry < 0 || entry >= ENTRANCE_COUNT) throw new Refused(`There is no entrance ${entry}`);
  const mem = bridge.writable();
  const scene = mem.rd32(ENTRANCE_TABLE + entry * 4) >>> 24;
  if (scene >= SCENE_COUNT) throw new Refused(`Entrance ${hex(entry, 3)} names scene ${hex(scene, 2)}, which the game does not have`);
  const play = playState((a) => mem.rd32(a));
  if (!play) throw new Refused('Not now: the game is not in a scene yet');
  requestEntrance((a) => mem.rd32(a), (a, v) => mem.write32(a, v), play, entry);
  return `Warping to ${entranceName(scene, entry)}`;
}

/** Entries matching a search: a number (decimal, or hex with 0x) is a scene or an entrance; empty matches all. */
export function search(rows: readonly Entrance[], query: string): Entrance[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const n = /^0x[0-9a-f]+$/.test(q) ? parseInt(q, 16) : /^\d+$/.test(q) ? parseInt(q, 10) : NaN;
  if (Number.isNaN(n)) return [];
  return rows.filter((r) => r.scene === n || r.entry === n);
}

export interface Bookmark {
  label: string;
  entry: number;
  scene: number;
}

const BOOKMARKS_KEY = 'zelda-oot-js:bookmarks';
const SCENE_LABELS_KEY = 'zelda-oot-js:scene-labels';

function readJson(key: string, store: PrefStore | null): unknown {
  try {
    return JSON.parse(store?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, store: PrefStore | null): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be blocked; the list then lasts until the page is closed.
  }
}

export function loadBookmarks(store: PrefStore | null = defaultStore()): Bookmark[] {
  const raw = readJson(BOOKMARKS_KEY, store);
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is Bookmark => typeof b?.label === 'string' && Number.isInteger(b.entry) && b.entry >= 0 && b.entry < ENTRANCE_COUNT && Number.isInteger(b.scene));
}

export const saveBookmarks = (list: readonly Bookmark[], store: PrefStore | null = defaultStore()): void => writeJson(BOOKMARKS_KEY, list, store);

export function loadSceneLabels(store: PrefStore | null = defaultStore()): Record<number, string> {
  const raw = readJson(SCENE_LABELS_KEY, store);
  const labels: Record<number, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && /^\d+$/.test(k)) labels[Number(k)] = v;
  }
  return labels;
}

export const saveSceneLabels = (labels: Record<number, string>, store: PrefStore | null = defaultStore()): void => writeJson(SCENE_LABELS_KEY, labels, store);
