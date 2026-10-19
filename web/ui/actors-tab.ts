import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import type { TabProps } from './types.ts';
import { Button } from './widgets.ts';
import { useLabels } from './label-edit.ts';
import { labels, MAX_LABEL } from './labels.ts';
import { isLink, type ActorRow } from '../inspect/actors.ts';

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, '0');
const fixed = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '?');

/** Link's list is the only category whose meaning the notes prove (docs/re/newgame.md); the others are the game's list numbers. */
const categoryHint = (category: number): string =>
  category === 2 ? "Link's own list" : 'The game keeps its actors in twelve numbered lists; its names for them are not known';

// The label applies when the field loses the focus, so that a space typed between words is not trimmed away.
function LabelField({ id }: { id: number }): VNode {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft !== null) labels.set('actor', id, draft);
    setDraft(null);
  };
  const done = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
  };
  return html`<input class="actor-label" type="text" value=${draft ?? labels.get('actor', id) ?? ''} placeholder="label this actor" maxlength=${MAX_LABEL}
    title="Your name for every actor with this id; kept in this browser" autocomplete="off" spellcheck=${false}
    onInput=${(e: Event) => setDraft((e.currentTarget as HTMLInputElement).value)} onKeyDown=${done} onBlur=${apply} />` as VNode;
}

function Details({ r }: { r: ActorRow }): VNode {
  return html`<div class="actor-details note">
    <div>Position ${fixed(r.position.x)}, ${fixed(r.position.y)}, ${fixed(r.position.z)}</div>
    ${r.distance !== null && html`<div title="Straight line to Link">${fixed(r.distance)} from Link, ${fixed(r.flat ?? NaN)} across x and z only</div>`}
    <div>Room ${r.room}</div>
    <div title="Three 16-bit values copied from the spawn rotation; their unit is not known here">Rotation ${r.rotation.map((n) => `0x${hex(n & 0xffff, 4)}`).join(', ')}</div>
    <div title="The game's object table slot holding this actor's data">Object slot ${r.objectSlot}, parameter 0x${hex(r.param, 4)}</div>
  </div>` as VNode;
}

export function ActorsTab({ state: s, actions: a }: TabProps): VNode {
  useLabels();
  const { groups, count, link, scene, refusal } = s.actors;
  return html`<div class="tab actors">
    <section>
      <h3>Alive in the scene</h3>
      ${scene === null
        ? html`<p id="actors-none" class="hint">No scene is loaded.</p>`
        : html`<p id="actors-count" class="hint">${count} actor${count === 1 ? '' : 's'} in scene 0x${hex(scene, 2)}, listed by game list and nearest to Link first. Name an actor id to see your name on every actor with it.</p>`}
      ${scene !== null && html`<p class="hint">Go to puts Link 50 units from the actor; the game moves him back when the spot has no floor.</p>`}
      ${scene !== null && refusal && html`<p class="note">Go to is refused now: ${refusal}</p>`}
    </section>
    ${groups.map((g) => html`<section key=${g.category} class="actor-group">
      <h3 title=${categoryHint(g.category)}>List ${g.category} <span class="note">${g.rows.length} · ${categoryHint(g.category)}</span></h3>
      <table class="slots actor-table"><tbody>
        ${g.rows.map((r) => {
          const own = labels.get('actor', r.id);
          return html`<tr key=${r.addr} class="actor">
          <td class="actor-id">
            <div class="actor-name">${own ?? `Actor 0x${hex(r.id, 4)}`}${own && html` <span class="note">(yours)</span>`}</div>
            <div class="note">${own ? `id 0x${hex(r.id, 4)} · ` : ''}record ${hex(r.addr, 8)}</div>
            <${LabelField} id=${r.id} />
          </td>
          <td class="actor-pos"><${Details} r=${r} /></td>
          <td class="row">
            <${Button} class="actor-go" disabled=${!link || isLink(r)} title=${isLink(r) ? 'This is Link' : 'Put Link next to this actor'} onClick=${() => a.goToActor(r.addr)}>Go to<//>
            <${Button} class="actor-view" title="Show the record in the Memory tab" onClick=${() => a.viewRecord(r.addr)}>Record<//>
          </td>
        </tr>`;
        })}
      </tbody></table>
    </section>`)}
  </div>` as VNode;
}
