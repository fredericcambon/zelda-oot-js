import { html } from 'htm/preact';
import type { VNode } from 'preact';
import type { TabProps } from './types.ts';
import { Button } from './widgets.ts';
import { isLink } from '../inspect/actors.ts';

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, '0');
const fixed = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '?');

export function ActorsTab({ state: s, actions: a }: TabProps): VNode {
  const { groups, count, link, scene, refusal } = s.actors;
  return html`<div class="tab actors">
    <section>
      <h3>Alive in the scene</h3>
      ${scene === null
        ? html`<p id="actors-none" class="hint">No scene is loaded.</p>`
        : html`<p id="actors-count" class="hint">${count} actor${count === 1 ? '' : 's'} in scene 0x${hex(scene, 2)}, listed by category number and nearest to Link first.</p>`}
      ${scene !== null && html`<p class="hint">Go to puts Link 50 units from the actor; the game moves him back when the spot has no floor.</p>`}
      ${scene !== null && refusal && html`<p class="note">Go to is refused now: ${refusal}</p>`}
    </section>
    ${groups.map((g) => html`<section key=${g.category} class="actor-group">
      <h3>Category ${g.category} <span class="note">${g.rows.length}</span></h3>
      <table class="slots actor-table"><tbody>
        ${g.rows.map((r) => html`<tr key=${r.addr} class="actor">
          <td class="actor-id"><div>id 0x${hex(r.id, 4)}</div><div class="note">${hex(r.addr, 8)}</div></td>
          <td class="actor-pos note">${fixed(r.position.x)}, ${fixed(r.position.y)}, ${fixed(r.position.z)}<div>${r.distance === null ? '' : `${fixed(r.distance)} from Link`}</div></td>
          <td class="row">
            <${Button} class="actor-go" disabled=${!link || isLink(r)} title=${isLink(r) ? 'This is Link' : 'Put Link next to this actor'} onClick=${() => a.goToActor(r.addr)}>Go to<//>
            <${Button} class="actor-view" title="Show the record in the Memory tab" onClick=${() => a.viewRecord(r.addr)}>Record<//>
          </td>
        </tr>`)}
      </tbody></table>
    </section>`)}
  </div>` as VNode;
}
