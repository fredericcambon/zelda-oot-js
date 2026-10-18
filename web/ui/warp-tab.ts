import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { entranceName, loadBookmarks, loadSceneLabels, saveBookmarks, saveSceneLabels, search, type Bookmark } from '../inspect/warp.ts';
import type { TabProps } from './types.ts';
import { Button } from './widgets.ts';

const MAX_ROWS = 100;

interface TextProps {
  id?: string;
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
  onEnter?: () => void;
}

// A text field takes keys while it has the focus; Enter and Escape give the focus back to the game.
function Text(p: TextProps): VNode {
  const done = (e: KeyboardEvent) => {
    if (e.key === 'Enter') p.onEnter?.();
    if (e.key === 'Enter' || e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
  };
  return html`<input id=${p.id} type="text" value=${p.value} placeholder=${p.placeholder} autocomplete="off" spellcheck=${false}
    onInput=${(e: Event) => p.onInput((e.currentTarget as HTMLInputElement).value)} onKeyDown=${done} />` as VNode;
}

const fixed = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?');

export function WarpTab({ state: s, actions: a }: TabProps): VNode {
  const { live, refusal } = s.warp;
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarks());
  const [sceneLabels, setSceneLabels] = useState<Record<number, string>>(() => loadSceneLabels());
  const rows = useMemo(() => a.entrances() ?? [], [live !== null]);
  const found = useMemo(() => search(rows, query), [rows, query]);
  const label = (scene: number) => sceneLabels[scene];

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
  const setSceneLabel = (scene: number, text: string) => {
    const next = { ...sceneLabels };
    if (text) next[scene] = text;
    else delete next[scene];
    setSceneLabels(next);
    saveSceneLabels(next);
  };

  return html`<div class="tab warp">
    <section>
      <h3>Now</h3>
      ${live
        ? html`<div id="warp-now">
            <div id="warp-scene">scene ${`0x${live.scene.toString(16).toUpperCase().padStart(2, '0')}`} (${live.scene})${label(live.scene) ? ` · ${label(live.scene)}` : ''}</div>
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
          <td>${b.label}<div class="note">${entranceName(b.scene, b.entry)}</div></td>
          <td class="row">
            <${Button} class="bookmark-go" onClick=${() => a.warp(b.entry)}>Warp<//>
            <${Button} class="bookmark-delete" title="Remove" onClick=${() => storeBookmarks(bookmarks.filter((_, j) => j !== i))}>✕<//>
          </td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Entrances</h3>
      <${Text} id="warp-search" value=${query} placeholder="search by scene or entrance number (85 or 0x55)" onInput=${setQuery} />
      <table class="slots"><tbody>
        ${found.slice(0, MAX_ROWS).map((r) => html`<tr key=${r.entry} class="entrance">
          <td>${entranceName(r.scene, r.entry)}${label(r.scene) && html`<div class="note">${label(r.scene)}</div>`}</td>
          <td><${Button} class="entrance-go" disabled=${!r.valid} title=${r.valid ? '' : 'This entrance names a scene the game does not have'} onClick=${() => a.warp(r.entry)}>Warp<//></td>
        </tr>`)}
      </tbody></table>
      ${found.length > MAX_ROWS && html`<p class="hint">${found.length - MAX_ROWS} more: narrow the search.</p>`}
      ${rows.length === 0 && html`<p class="hint">The table is read once a game runs.</p>`}
    </section>
    ${live && html`<section>
      <h3>Name this scene</h3>
      <p class="hint">Your own label for scene ${live.scene}, kept in this browser only.</p>
      <${Text} id="scene-label" value=${label(live.scene) ?? ''} placeholder="label" onInput=${(t: string) => setSceneLabel(live.scene, t)} />
    </section>`}
  </div>` as VNode;
}
