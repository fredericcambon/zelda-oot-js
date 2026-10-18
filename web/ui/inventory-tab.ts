import { html } from 'htm/preact';
import type { VNode } from 'preact';
import type { Fields } from '../inspect/inventory.ts';
import { BUTTON_ITEMS, countName, EQUIP_ROWS, FIELD_NAMES, questBitName, slotName, type FieldName } from './inventory-names.ts';
import { Labelled } from './label-edit.ts';
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
  const name = (key: string, n: FieldName): VNode => html`<${Labelled} kind="field" id=${key} name=${n.name} hint=${n.hint} />` as VNode;
  const numeric = (key: string, n: FieldName, value: number | string): VNode => html`<tr key=${key}>
    <td>${name(key, n)}</td>
    <td><${NumberEdit} id=${`inv-${key}`} value=${String(value)} width=${64} onApply=${edit(key)} /></td>
    <td>${Hold(key)}</td>
  </tr>` as VNode;

  return html`<div class="tab inventory">
    ${refusal && html`<p id="inv-refusal" class="note">Editing is refused now: ${refusal}</p>`}
    <section>
      <h3>Hearts</h3>
      <table class="slots"><tbody>
        ${numeric('hearts', FIELD_NAMES.hearts, f.hearts as number)}
        ${numeric('health', FIELD_NAMES.health, f.health as number)}
      </tbody></table>
      <div class="row"><${Button} id="inv-refill" onClick=${() => a.editSave([['health', String(f.hearts)]])}>Refill health<//></div>
    </section>
    <section>
      <h3>Item slots</h3>
      <p class="hint">By item id (0-254), or none, one per cell of the pause menu item grid.</p>
      <table class="slots"><tbody>
        ${f.items.map((id, i) => html`<tr key=${i} class="item-slot">
          <td>${name(`items.${i}`, slotName(i))}</td>
          <td><${NumberEdit} id=${`inv-items.${i}`} value=${itemText(id)} width=${64} onApply=${edit(`items.${i}`)} /></td>
          <td>${Hold(`items.${i}`)}</td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Counts</h3>
      <table class="slots"><tbody>
        ${numeric('count34', FIELD_NAMES.count34, f.count34 as number)}
        ${numeric('countD0', FIELD_NAMES.countD0, f.countD0 as number)}
        ${f.counts8C.map((v, i) => numeric(`counts8C.${i}`, countName(i), v))}
      </tbody></table>
    </section>
    <section>
      <h3>Other fields</h3>
      <table class="slots"><tbody>
        <tr><td>${name('name', FIELD_NAMES.name)}</td><td>${f.name as string}</td></tr>
        <tr><td>${name('scene', FIELD_NAMES.scene)}</td><td>${hex(f.scene as number)}</td></tr>
        <tr><td>${name('limit34', FIELD_NAMES.limit34)}</td><td>${String(f.limit34)}</td></tr>
        <tr><td>${name('level32', FIELD_NAMES.level32)}</td><td>${String(f.level32)}</td></tr>
        <tr><td>${name('byte33', FIELD_NAMES.byte33)}</td><td>${String(f.byte33)}</td></tr>
        <tr><td>${name('flag3A', FIELD_NAMES.flag3A)}</td><td>${String(f.flag3A)}</td></tr>
        <tr><td>${name('flag3C', FIELD_NAMES.flag3C)}</td><td>${String(f.flag3C)}</td></tr>
        <tr><td>${name('bytes68', FIELD_NAMES.bytes68)}</td><td id="inv-bytes68">${f.bytes68.map((id, i) => `${BUTTON_ITEMS[i]} ${itemText(id)}`).join(' · ')}</td></tr>
        ${Object.entries(f.nibbleGroups).map(([n, g], i) => html`<tr key=${n}><td>${name(`equip.${n}`, { ...FIELD_NAMES.equip, name: EQUIP_ROWS[i]!, hint: 'One row of the equipment page: owned columns (bits) and the column worn (0 none, 1 to 3)' })}</td><td>owned bits ${g.word9C.toString(2).padStart(3, '0')} · worn ${g.word70}</td></tr>`)}
        <tr><td>${name('bitsA4', FIELD_NAMES.bitsA4)}</td><td id="inv-bitsA4">${f.bitsA4.length ? f.bitsA4.map((b) => `${b} ${questBitName(b)}`).join(', ') : 'none set'}</td></tr>
      </tbody></table>
    </section>
  </div>` as VNode;
}
