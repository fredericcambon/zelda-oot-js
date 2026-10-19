// The Warp list as places: the entrance table folded into one row per arrival point (a scene and a spawn), grouped by scene,
// with text names (docs/re/entrances.md). A scene named by its title card has a proven name; the other scenes are named after
// the scenes their exit lists connect them to; whatever stays unnamed shows its numbers.

/** The part of an entrance table record this needs. */
export interface TableEntry {
  entry: number;
  scene: number;
  spawn: number;
  valid: boolean;
}

/** Records an entrance index reaches by adding the variant: 0 to 3, then 4 and up for cutscene set-ups (docs/re/entrances.md). */
export const VARIANT_LABELS = ['day', 'night', 'variant 2', 'variant 3'] as const;
const VARIANT_HINTS = [
  'The record used by day while the save word at 0x801183D4 is not 0',
  'The record used by night while the save word at 0x801183D4 is not 0',
  'The record used by day while the save word at 0x801183D4 is 0',
  'The record used by night while the save word at 0x801183D4 is 0',
];

export interface Variant {
  entry: number;
  label: string;
  hint: string;
}

export type NameKind = 'card' | 'derived' | 'none';

export interface Arrival {
  scene: number;
  spawn: number;
  /** Every table entry that lands here. */
  entries: number[];
  /** The records of the first group of entries, by variant. */
  variants: Variant[];
  /** The other entries, each as a variant of its own group. */
  others: Variant[];
  /** Scenes whose exit list leads here, other than the scene itself. */
  sources: number[];
  name: string;
}

export interface PlaceGroup {
  scene: number;
  name: string;
  kind: NameKind;
  arrivals: Arrival[];
}

export interface Places {
  groups: PlaceGroup[];
  /** The group and arrival that hold a table entry. */
  byEntry: Map<number, { group: PlaceGroup; arrival: Arrival }>;
  rows: number;
  /** Rows by how their scene is named. */
  named: Record<NameKind, number>;
}

interface Run {
  start: number;
  length: number;
}

const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

export function variantLabel(offset: number): string {
  return offset < VARIANT_LABELS.length ? VARIANT_LABELS[offset]! : `cutscene ${offset - VARIANT_LABELS.length}`;
}

function variantHint(offset: number): string {
  return offset < VARIANT_HINTS.length ? VARIANT_HINTS[offset]! : 'The record used while a cutscene set-up runs (4 + the cutscene index)';
}

/**
 * Runs of consecutive entries of one scene and spawn make a group, split where an exit list names an entry. A group holds the
 * records an entrance index reaches by adding the variant: 0 to 3, then 4 and up for cutscene set-ups.
 */
function groupsOf(entries: readonly TableEntry[], referenced: ReadonlySet<number>): Run[] {
  const groups: Run[] = [];
  for (const e of entries) {
    if (!e.valid) continue;
    const prev = entries[e.entry - 1];
    const continues = prev?.valid && prev.scene === e.scene && prev.spawn === e.spawn && !referenced.has(e.entry);
    if (continues) groups[groups.length - 1]!.length++;
    else groups.push({ start: e.entry, length: 1 });
  }
  return groups;
}

/** Names scenes: the card's own for scenes that have one, otherwise "Off" and the proven names reached through the exit lists. */
function nameScenes(scenes: readonly number[], cardName: (scene: number) => string | undefined, neighbours: ReadonlyMap<number, ReadonlySet<number>>) {
  const names = new Map<number, { text: string; kind: NameKind }>();
  const roots = new Map<number, string[]>();
  for (const s of scenes) {
    const text = cardName(s);
    if (text !== undefined) {
      names.set(s, { text, kind: 'card' });
      roots.set(s, [text]);
    }
  }
  // Breadth first from the named scenes: a scene takes the roots of its neighbours named one step earlier.
  for (let level = roots; ; ) {
    const found = new Map<number, string[]>();
    for (const s of scenes) {
      if (names.has(s)) continue;
      const near = [...(neighbours.get(s) ?? [])].filter((n) => level.has(n));
      const rootNames = [...new Set(near.flatMap((n) => level.get(n)!))].sort((a, b) => a.localeCompare(b));
      if (rootNames.length > 0) found.set(s, rootNames);
    }
    if (found.size === 0) break;
    for (const [s, rootNames] of found) {
      const shown = rootNames.slice(0, 2).join(' / ') + (rootNames.length > 2 ? ` +${rootNames.length - 2}` : '');
      names.set(s, { text: `Off ${shown}`, kind: 'derived' });
      roots.set(s, rootNames);
    }
    level = found;
  }
  for (const s of scenes) if (!names.has(s)) names.set(s, { text: `Scene ${hex(s, 2)}`, kind: 'none' });
  return names;
}

export function buildPlaces(entries: readonly TableEntry[], exits: ReadonlyMap<number, readonly number[]>, cardName: (scene: number) => string | undefined): Places {
  const sceneOf = (entry: number) => (entries[entry]?.valid ? entries[entry]!.scene : undefined);
  const referenced = new Set<number>();
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  /** Scenes that name an entry in their exit list. */
  const referrers = new Map<number, Set<number>>();
  for (const [from, list] of exits) {
    for (const entry of list) {
      const to = sceneOf(entry);
      if (to === undefined) continue;
      referenced.add(entry);
      if (!referrers.has(entry)) referrers.set(entry, new Set());
      referrers.get(entry)!.add(from);
      if (to !== from) {
        link(from, to);
        link(to, from);
      }
    }
  }

  const scenes = [...new Set(entries.filter((e) => e.valid).map((e) => e.scene))].sort((a, b) => a - b);
  const names = nameScenes(scenes, cardName, neighbours);
  // Scenes that share a name (several scenes show one card) are told apart by a count, in scene order.
  const count = new Map<string, number>();
  for (const scene of scenes) {
    const entry = names.get(scene)!;
    const n = (count.get(entry.text) ?? 0) + 1;
    count.set(entry.text, n);
    if (n > 1) entry.text = `${entry.text} (${n})`;
  }
  const sceneName = (s: number) => names.get(s)!.text;

  // One arrival per scene and spawn, over all groups that land there.
  const arrivalRuns = new Map<string, { scene: number; spawn: number; runs: Run[] }>();
  for (const run of groupsOf(entries, referenced)) {
    const e = entries[run.start]!;
    const key = `${e.scene}:${e.spawn}`;
    if (!arrivalRuns.has(key)) arrivalRuns.set(key, { scene: e.scene, spawn: e.spawn, runs: [] });
    arrivalRuns.get(key)!.runs.push(run);
  }

  const byScene = new Map<number, Arrival[]>();
  for (const { scene, spawn, runs } of arrivalRuns.values()) {
    // The group an exit list names comes first; it is the arrival the game itself uses.
    const ordered = [...runs].sort((a, b) => Number(referenced.has(b.start)) - Number(referenced.has(a.start)) || a.start - b.start);
    const [first, ...rest] = ordered;
    const record = (g: Run, offset: number): Variant => ({ entry: g.start + offset, label: variantLabel(offset), hint: variantHint(offset) });
    const variants = Array.from({ length: Math.min(first!.length, VARIANT_LABELS.length) }, (_, o) => record(first!, o));
    const others: Variant[] = [];
    for (let o = VARIANT_LABELS.length; o < first!.length; o++) others.push(record(first!, o));
    for (const g of rest) for (let o = 0; o < g.length; o++) others.push(record(g, o));
    const all = ordered.flatMap((g) => Array.from({ length: g.length }, (_, o) => g.start + o)).sort((a, b) => a - b);
    const sources = [...new Set(all.flatMap((e) => [...(referrers.get(e) ?? [])]).filter((s) => s !== scene))].sort((a, b) => a - b);
    const arrival: Arrival = { scene, spawn, entries: all, variants, others, sources, name: '' };
    byScene.set(scene, [...(byScene.get(scene) ?? []), arrival]);
  }

  const groups: PlaceGroup[] = [];
  for (const [scene, arrivals] of byScene) {
    arrivals.sort((a, b) => a.entries[0]! - b.entries[0]!);
    const { text, kind } = names.get(scene)!;
    for (const a of arrivals) {
      const from = a.sources.map(sceneName);
      const shown = from.slice(0, 2).join(' / ') + (from.length > 2 ? ` +${from.length - 2}` : '');
      if (arrivals.length === 1) a.name = text;
      else a.name = `${text} - ${from.length > 0 ? `from ${shown}` : `spawn ${a.spawn}`}`;
    }
    // Two arrivals of a scene that read the same must still be told apart.
    const seen = new Map<string, number>();
    for (const a of arrivals) {
      const n = (seen.get(a.name) ?? 0) + 1;
      seen.set(a.name, n);
      if (n > 1) a.name = `${a.name} (spawn ${a.spawn})`;
    }
    groups.push({ scene, name: text, kind, arrivals });
  }
  groups.sort((a, b) => Number(a.kind === 'none') - Number(b.kind === 'none') || a.name.localeCompare(b.name) || a.scene - b.scene);

  const byEntry = new Map<number, { group: PlaceGroup; arrival: Arrival }>();
  const named: Record<NameKind, number> = { card: 0, derived: 0, none: 0 };
  let rows = 0;
  for (const group of groups) {
    for (const arrival of group.arrivals) {
      rows++;
      named[group.kind]++;
      for (const e of arrival.entries) byEntry.set(e, { group, arrival });
    }
  }
  return { groups, byEntry, rows, named };
}

/** The groups with the arrivals that match a query: text over the names, or a number that is a scene or an entry (decimal, or hex with 0x). */
export function searchPlaces(places: Places, query: string, label: (scene: number, entries: readonly number[]) => string | undefined = () => undefined): PlaceGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return places.groups;
  const n = /^0x[0-9a-f]+$/.test(q) ? parseInt(q, 16) : /^\d+$/.test(q) ? parseInt(q, 10) : NaN;
  const out: PlaceGroup[] = [];
  for (const group of places.groups) {
    const arrivals = group.arrivals.filter((a) => {
      if (!Number.isNaN(n) && (a.scene === n || a.entries.includes(n))) return true;
      const mine = label(a.scene, a.entries) ?? '';
      return `${group.name} ${a.name} ${mine}`.toLowerCase().includes(q);
    });
    if (arrivals.length > 0) out.push({ ...group, arrivals });
  }
  return out;
}
