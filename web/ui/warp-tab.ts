import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { entranceName, loadBookmarks, thumbUrl, loadSceneLabels, saveBookmarks, saveSceneLabels, search, type Bookmark } from '../inspect/warp.ts';
import { CONDITIONAL_CARD_SCENES, scenesWithCard } from '../inspect/title-cards.ts';
import { useTitleCards } from './icons.ts';
import { useLabels } from './label-edit.ts';
import { labels } from './labels.ts';
import type { TabProps } from './types.ts';
import { Button } from './widgets.ts';
import './warp.css';

/** Entrances listed at first, and added by each press of "Show more"; their pictures load as they scroll into view. */
const PAGE_ROWS = 100;

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

interface PlaceProps {
  scene: number;
  /** The entrance, when the line names one. */
  entry?: number;
  card: string | null;
}

// A picture the page does not have (a site without the sweep's pictures) is left out.
const hideBroken = (e: Event) => ((e.currentTarget as HTMLImageElement).style.display = 'none');

// Where a scene is: its title card when the game shows one, the user's label when there is one, and the numbers in small print.
function Place({ scene, entry, card }: PlaceProps): VNode {
  const mine = (entry !== undefined && labels.get('entrance', entry)) || labels.get('scene', scene);
  const ids = entry === undefined ? `scene ${hex(scene, 2)} (${scene})` : entranceName(scene, entry);
  return html`<div class="place">
    ${entry !== undefined && html`<img class="thumb" src=${thumbUrl(entry)} alt="" width="96" height="72" loading="lazy" onError=${hideBroken} />`}
    <div class="names">
    ${card && html`<img class="card" src=${card} alt="" width="144" height="24" title=${CONDITIONAL_CARD_SCENES.includes(scene) ? 'The game draws this card only while one of its save flags is set' : 'The area name the game shows on entering'} />`}
    ${mine && html`<div class="yours">${mine}</div>`}<div class="ids">${ids}</div></div>
  </div>` as VNode;
}

const fixed = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');

export function WarpTab({ state: s, actions: a }: TabProps): VNode {
  const { live, refusal } = s.warp;
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [shownRows, setShownRows] = useState(PAGE_ROWS);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarks());
  useLabels();
  migrateSceneLabels();
  const cards = useTitleCards();
  const rows = useMemo(() => a.entrances() ?? [], [live !== null]);
  const found = useMemo(() => search(rows, query), [rows, query]);
  const language = live?.language ?? 0;
  const shown = useMemo(() => (cards ? scenesWithCard(cards, rows) : new Set<number>()), [cards, rows]);
  const cardOf = (scene: number): string | null => (cards && shown.has(scene) ? cards.url(scene, language) : null);

  const storeBookmarks = (next: Bookmark[]) => {
    setBookmarks(next);
    saveBookmarks(next);
  };
  const canBookmark = live !== null && live.entry !== null;
  const addBookmark = () => {
    if (!live || live.entry === null) return;
    storeBookmarks([...bookmarks, { label: name.trim() || entranceName(live.scene, live.entry), entry: live.entry, scene: live.scene }]);
    setName('');
  };
  return html`<div class="tab warp">
    <section>
      <h3>Now</h3>
      ${live
        ? html`<div id="warp-now">
            <div id="warp-scene"><${Place} scene=${live.scene} entry=${live.entry ?? undefined} card=${cardOf(live.scene)} /></div>
            <div id="warp-entrance">${live.entry === null ? 'entrance: not one of the table\'s for this scene (redirected)' : `entrance 0x${live.entry.toString(16).toUpperCase().padStart(3, '0')} (${live.entry})`}</div>
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
          <td>${b.label}<${Place} scene=${b.scene} entry=${b.entry} card=${cardOf(b.scene)} /></td>
          <td class="row">
            <${Button} class="bookmark-go" onClick=${() => a.warp(b.entry)}>Warp<//>
            <${Button} class="bookmark-delete" title="Remove" onClick=${() => storeBookmarks(bookmarks.filter((_, j) => j !== i))}>✕<//>
          </td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Entrances</h3>
      <${Text} id="warp-search" value=${query} placeholder="search by scene or entrance number (85 or 0x55)" onInput=${(q: string) => {
        setQuery(q);
        setShownRows(PAGE_ROWS);
      }} />
      <table class="slots"><tbody>
        ${found.slice(0, shownRows).map((r) => html`<tr key=${r.entry} class="entrance">
          <td><${Place} scene=${r.scene} entry=${r.entry} card=${cardOf(r.scene)} /></td>
          <td><${Button} class="entrance-go" disabled=${!r.valid} title=${r.valid ? '' : 'This entrance names a scene the game does not have'} onClick=${() => a.warp(r.entry)}>Warp<//></td>
        </tr>`)}
      </tbody></table>
      ${found.length > shownRows && html`<div class="row"><${Button} id="warp-more" onClick=${() => setShownRows(shownRows + PAGE_ROWS)}>Show ${Math.min(PAGE_ROWS, found.length - shownRows)} more<//><span class="hint">${found.length - shownRows} left, or narrow the search.</span></div>`}
      ${rows.length === 0 && html`<p class="hint">The table is read once a game runs.</p>`}
    </section>
    ${live && html`<section>
      <h3>Name this scene</h3>
      <p class="hint">Your own label for scene ${live.scene}, kept in this browser only.</p>
      <${LabelField} key=${live.scene} id="scene-label" kind="scene" target=${live.scene} />
      ${live.entry !== null && html`<h3>Name this entrance</h3>
      <p class="hint">Your own label for entrance ${live.entry}; it shows instead of the scene's label on that entrance.</p>
      <${LabelField} key=${live.entry} id="entrance-label" kind="entrance" target=${live.entry} />`}
    </section>`}
  </div>` as VNode;
}
