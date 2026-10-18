import { html } from 'htm/preact';
import type { VNode } from 'preact';
import type { Fields } from '../inspect/inventory.ts';
import type { TabProps } from './types.ts';
import { Button, NumberEdit } from './widgets.ts';

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const itemText = (id: number) => (id === 0xff ? 'none' : String(id));

export function InventoryTab({ state: s, actions: a }: TabProps): VNode {
  const { fields, frozen, refusal } = s.inventory;
  if (!fields) return html`<div class="tab"><p id="inv-none" class="hint">No game is running.</p></div>` as VNode;
  const f = fields as Fields & { items: number[]; counts8C: number[]; bytes68: number[]; nibbleGroups: Record<string, { word9C: number; word70: number }>; bitsA4: number[] };
  const held = (key: string) => frozen.includes(key);
  const edit = (key: string) => (value: string) => a.editSave([[key, value.trim() === '' ? 'none' : value.trim()]]);
  const Hold = (key: string): VNode => html`<${Button} class="hold" pressed=${held(key)} title="Rewrite this value before every frame" onClick=${() => a.toggleFreeze(key)}>${held(key) ? 'Held' : 'Hold'}<//>` as VNode;
  const numeric = (key: string, label: string, value: number | string, title?: string): VNode => html`<tr key=${key} title=${title}>
    <td>${label}</td>
    <td><${NumberEdit} id=${`inv-${key}`} value=${String(value)} width=${64} onApply=${edit(key)} /></td>
    <td>${Hold(key)}</td>
  </tr>` as VNode;

  return html`<div class="tab inventory">
    ${refusal && html`<p id="inv-refusal" class="note">Editing is refused now: ${refusal}</p>`}
    <section>
      <h3>Hearts</h3>
      <table class="slots"><tbody>
        ${numeric('hearts', 'hearts (capacity)', f.hearts as number, '1 to 20; also fills the health')}
        ${numeric('health', 'health (hearts)', f.health as number, 'Hearts, in sixteenths')}
      </tbody></table>
      <div class="row"><${Button} id="inv-refill" onClick=${() => a.editSave([['health', String(f.hearts)]])}>Refill health<//></div>
    </section>
    <section>
      <h3>Item slots</h3>
      <p class="hint">By item id (0-254), or none. The 24 slots are the bytes at +0x74 of the record.</p>
      <table class="slots"><tbody>
        ${f.items.map((id, i) => html`<tr key=${i} class="item-slot">
          <td>slot ${i}</td>
          <td><${NumberEdit} id=${`inv-items.${i}`} value=${itemText(id)} width=${64} onApply=${edit(`items.${i}`)} /></td>
          <td>${Hold(`items.${i}`)}</td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Counts</h3>
      <table class="slots"><tbody>
        ${numeric('count34', 'count34', f.count34 as number)}
        ${numeric('countD0', 'countD0', f.countD0 as number)}
        ${f.counts8C.map((v, i) => numeric(`counts8C.${i}`, `counts8C.${i}`, v))}
      </tbody></table>
    </section>
    <section>
      <h3>Other fields</h3>
      <table class="slots"><tbody>
        <tr><td>name</td><td>${f.name as string}</td></tr>
        <tr><td>level32</td><td>${String(f.level32)}</td></tr>
        <tr><td>byte33</td><td>${String(f.byte33)}</td></tr>
        <tr><td>flag3A</td><td>${String(f.flag3A)}</td></tr>
        <tr><td>flag3C</td><td>${String(f.flag3C)}</td></tr>
        <tr><td>limit34</td><td>${String(f.limit34)}</td></tr>
        <tr><td>scene</td><td>${hex(f.scene as number)}</td></tr>
        <tr><td>bytes68</td><td id="inv-bytes68">${f.bytes68.map(itemText).join(' ')}</td></tr>
        ${Object.entries(f.nibbleGroups).map(([n, g]) => html`<tr key=${n}><td>${n}</td><td>word9C ${g.word9C} · word70 ${g.word70}</td></tr>`)}
        <tr><td>bitsA4</td><td id="inv-bitsA4">${f.bitsA4.length ? f.bitsA4.join(', ') : 'none set'}</td></tr>
      </tbody></table>
    </section>
  </div>` as VNode;
}
