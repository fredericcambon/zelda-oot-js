import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { CARD_NAMES } from '../inspect/card-names.ts';
import { buildPlaces, searchPlaces, type Arrival, type PlaceGroup, type Places } from '../inspect/places.ts';
import { CONDITIONAL_CARD_SCENES, scenesWithCard } from '../inspect/title-cards.ts';
import { loadBookmarks, loadSceneLabels, saveBookmarks, saveSceneLabels, thumbUrl, type Bookmark } from '../inspect/warp.ts';
import { useSceneExits, useTitleCards, type CardImages } from './icons.ts';
import { useLabels } from './label-edit.ts';
import { labels } from './labels.ts';
import type { TabProps } from './types.ts';
import { Button } from './widgets.ts';
import './warp.css';

interface TextProps {
  id?: string;
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
  onEnter?: () => void;
  onBlur?: () => void;
}

// A text field takes keys while it has the focus; Enter and Escape give the focus back to the game.
function Text(p: TextProps): VNode {
  const done = (e: KeyboardEvent) => {
    if (e.key === 'Enter') p.onEnter?.();
    if (e.key === 'Enter' || e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
  };
  return html`<input id=${p.id} type="text" value=${p.value} placeholder=${p.placeholder} autocomplete="off" spellcheck=${false}
    onInput=${(e: Event) => p.onInput((e.currentTarget as HTMLInputElement).value)} onKeyDown=${done} onBlur=${p.onBlur} />` as VNode;
}

const hex = (n: number, width: number) => `0x${n.toString(16).toUpperCase().padStart(width, '0')}`;

// Labels the Warp tab kept of its own before the shared store existed move there once.
let migrated = false;
function migrateSceneLabels(): void {
  if (migrated) return;
  migrated = true;
  const old = loadSceneLabels();
  for (const [scene, text] of Object.entries(old)) if (labels.get('scene', scene) === undefined) labels.set('scene', scene, text);
  if (Object.keys(old).length > 0) saveSceneLabels({});
}

// The label applies when the field loses the focus, so that a space typed between words is not trimmed away.
function LabelField({ id, kind, target }: { id: string; kind: 'scene' | 'entrance'; target: number }): VNode {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft !== null) labels.set(kind, target, draft);
    setDraft(null);
  };
  return html`<${Text} id=${id} value=${draft ?? labels.get(kind, target) ?? ''} placeholder="label" onInput=${setDraft} onBlur=${apply} />` as VNode;
}

const NAME_NOTE: Record<PlaceGroup['kind'], string> = {
  card: 'Named by its title card',
  derived: 'Named after the scenes its exits connect it to',
  none: 'No name known',
};

const sceneLabel = (scene: number): string | undefined => labels.get('scene', scene);
const arrivalLabel = (arrival: Pick<Arrival, 'entries'>): string | undefined => arrival.entries.map((e) => labels.get('entrance', e)).find((l) => l !== undefined);

/** The first picture of the entries that has one: the sweep could not take every entry's. */
function Thumb({ entries }: { entries: readonly number[] }): VNode {
  const [at, setAt] = useState(0);
  if (at >= entries.length) return html`<span class="thumb none"></span>` as VNode;
  return html`<img class="thumb" src=${thumbUrl(entries[at]!)} alt="" width="96" height="72" loading="lazy" onError=${() => setAt(at + 1)} />` as VNode;
}

interface CardProps {
  scene: number;
  url: string | null;
}

function Card({ scene, url }: CardProps): VNode | null {
  if (!url) return null;
  const title = CONDITIONAL_CARD_SCENES.includes(scene) ? 'The game draws this card only while one of its save flags is set' : 'The area name the game shows on entering';
  return html`<img class="card" src=${url} alt="" width="144" height="24" title=${title} />` as VNode;
}

interface RowProps {
  group: PlaceGroup;
  arrival: Arrival;
  warp: (entry: number) => void;
}

// One arrival point: its text name, where it is, and a button per record of the entrance table that leads there.
function ArrivalRow({ group, arrival, warp }: RowProps): VNode {
  const mine = arrivalLabel(arrival);
  const first = arrival.entries[0]!;
  const ids = arrival.entries.length === 1 ? `entry ${first}` : `entries ${first}-${arrival.entries[arrival.entries.length - 1]}`;
  return html`<div class="arrival">
    <${Thumb} entries=${[...arrival.variants.map((v) => v.entry), ...arrival.entries]} />
    <div class="names">
      <div class="title">${mine ? html`<span class="yours">${mine}</span>` : arrival.name}</div>
      ${mine && html`<div class="ids">${arrival.name}</div>`}
      <div class="ids">scene ${hex(group.scene, 2)} · spawn ${arrival.spawn} · ${ids}</div>
      <div class="row variants">
        ${arrival.variants.map((v) => html`<${Button} key=${v.entry} class="variant-go" title=${`${v.hint} (entry ${v.entry})`} onClick=${() => warp(v.entry)}>${v.label}<//>`)}
      </div>
      ${arrival.others.length > 0 && html`<details class="more"><summary>${arrival.others.length} more entries</summary><div class="row variants">
        ${arrival.others.map((v) => html`<${Button} key=${v.entry} class="variant-go" title=${`${v.hint}`} onClick=${() => warp(v.entry)}>${v.entry} ${v.label}<//>`)}
      </div></details>`}
    </div>
  </div>` as VNode;
}

function GroupView({ group, card, warp }: { group: PlaceGroup; card: string | null; warp: (entry: number) => void }): VNode {
  const mine = sceneLabel(group.scene);
  return html`<section class="scene">
    <h4>${mine ? html`<span class="yours">${mine}</span>` : group.name}<span class="ids" title=${NAME_NOTE[group.kind]}> · scene ${hex(group.scene, 2)}${group.kind === 'derived' ? ' · named from its exits' : ''}</span></h4>
    <${Card} scene=${group.scene} url=${card} />
    ${group.arrivals.map((arrival) => html`<${ArrivalRow} key=${arrival.entries[0]} group=${group} arrival=${arrival} warp=${warp} />`)}
  </section>` as VNode;
}

const fixed = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');

function nowName(places: Places, scene: number, entry: number | null): { name: string; note: string } {
  const hit = entry === null ? undefined : places.byEntry.get(entry);
  const group = hit?.group ?? places.groups.find((g) => g.scene === scene);
  const name = hit ? (arrivalLabel(hit.arrival) ?? hit.arrival.name) : (group?.name ?? `Scene ${hex(scene, 2)}`);
  return { name: sceneLabel(scene) && !hit ? sceneLabel(scene)! : name, note: group ? NAME_NOTE[group.kind] : '' };
}

export function WarpTab({ state: s, actions: a }: TabProps): VNode {
  const { live, refusal } = s.warp;
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarks());
  const all = useLabels();
  migrateSceneLabels();
  const cards = useTitleCards();
  const exits = useSceneExits();
  const rows = useMemo(() => a.entrances() ?? [], [live !== null]);
  const places = useMemo(
    () => buildPlaces(rows, exits ?? new Map(), (scene) => {
      const file = cards?.file(scene);
      return file === null || file === undefined ? undefined : CARD_NAMES[file];
    }),
    [rows, exits, cards],
  );
  const language = live?.language ?? 0;
  const shown = useMemo(() => (cards ? scenesWithCard(cards, rows) : new Set<number>()), [cards, rows]);
  const cardOf = (scene: number, images: CardImages | null = cards): string | null => (images && shown.has(scene) ? images.url(scene, language) : null);
  const labelsKey = all.exportJson();
  // The list is the long part of the tab: it is made again only when what it shows changes, not at each position update.
  const list = useMemo(() => {
    const found = searchPlaces(places, query, (scene, entries) => [sceneLabel(scene), arrivalLabel({ entries: [...entries] })].filter(Boolean).join(' '));
    return html`<div id="warp-list">${found.map((g) => html`<${GroupView} key=${g.scene} group=${g} card=${cardOf(g.scene)} warp=${a.warp} />`)}
      ${found.length === 0 && rows.length > 0 && html`<p class="hint">Nothing matches.</p>`}</div>`;
  }, [places, query, labelsKey, shown, language, cards]);

  const storeBookmarks = (next: Bookmark[]) => {
    setBookmarks(next);
    saveBookmarks(next);
  };
  const canBookmark = live !== null && live.entry !== null;
  const addBookmark = () => {
    if (!live || live.entry === null) return;
    storeBookmarks([...bookmarks, { label: name.trim() || nowName(places, live.scene, live.entry).name, entry: live.entry, scene: live.scene }]);
    setName('');
  };
  const here = live ? nowName(places, live.scene, live.entry) : null;
  return html`<div class="tab warp">
    <section>
      <h3>Now</h3>
      ${live && here
        ? html`<div id="warp-now">
            <div id="warp-scene" class="arrival">
              <${Thumb} entries=${live.entry === null ? [] : [live.entry]} />
              <div class="names">
                <${Card} scene=${live.scene} url=${cardOf(live.scene)} />
                <div class="title" title=${here.note}>${here.name}</div>
                <div class="ids">scene ${hex(live.scene, 2)} (${live.scene})${live.entry === null ? '' : ` · entry ${live.entry}`}</div>
              </div>
            </div>
            <div id="warp-entrance">${live.entry === null ? 'entrance: not one of the table\'s for this scene (redirected)' : `entrance ${hex(live.entry, 3)} (${live.entry})`}</div>
            <div id="warp-position">${live.position ? `position x ${fixed(live.position.x)}  y ${fixed(live.position.y)}  z ${fixed(live.position.z)}` : 'position: Link is not in the scene'}</div>
          </div>`
        : html`<p id="warp-now" class="hint">No scene is loaded.</p>`}
      ${refusal && html`<p id="warp-refusal" class="note">Warping is refused now: ${refusal}</p>`}
    </section>
    <section>
      <h3>Bookmarks</h3>
      <div class="row">
        <${Text} id="bookmark-name" value=${name} placeholder="label (optional)" onInput=${setName} onEnter=${addBookmark} />
        <${Button} id="bookmark-add" disabled=${!canBookmark} title=${canBookmark ? 'Save the current entrance' : 'The current entrance is not known'} onClick=${addBookmark}>Save here<//>
      </div>
      <table class="slots"><tbody>
        ${bookmarks.map((b, i) => html`<tr key=${i} class="bookmark">
          <td>${b.label}<div class="ids">${nowName(places, b.scene, b.entry).name} · entry ${b.entry}</div></td>
          <td class="row">
            <${Button} class="bookmark-go" onClick=${() => a.warp(b.entry)}>Warp<//>
            <${Button} class="bookmark-delete" title="Remove" onClick=${() => storeBookmarks(bookmarks.filter((_, j) => j !== i))}>✕<//>
          </td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Places</h3>
      <p class="hint">${places.rows} arrival points in ${places.groups.length} scenes. Each button warps through one record of the entrance table.</p>
      <${Text} id="warp-search" value=${query} placeholder="search by name, scene or entry number (85 or 0x55)" onInput=${setQuery} />
      ${list}
      ${rows.length === 0 && html`<p class="hint">The table is read once a game runs.</p>`}
    </section>
    ${live && html`<section>
      <h3>Name this scene</h3>
      <p class="hint">Your own label for scene ${live.scene}, kept in this browser only. It replaces the name above.</p>
      <${LabelField} key=${live.scene} id="scene-label" kind="scene" target=${live.scene} />
      ${live.entry !== null && html`<h3>Name this arrival</h3>
      <p class="hint">Your own label for entry ${live.entry}; it shows instead of the scene's name on that arrival.</p>
      <${LabelField} key=${live.entry} id="entrance-label" kind="entrance" target=${live.entry} />`}
    </section>`}
  </div>` as VNode;
}
