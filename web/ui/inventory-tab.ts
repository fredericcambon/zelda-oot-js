import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { ITEM_SLOT_OF_ID } from '../../tools/saves/record.ts';
import { itemIconIndex, questIconIndex } from '../inspect/icons.ts';
import type { Fields } from '../inspect/inventory.ts';
import { useIcons, type Icons } from './icons.ts';
import { BUTTON_ITEMS, countName, EQUIP_ROWS, FIELD_NAMES, questBitName, slotName } from './inventory-names.ts';
import { useLabels } from './label-edit.ts';
import type { TabProps } from './types.ts';
import { Button, NumberEdit } from './widgets.ts';
import './inventory.css';

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
const itemText = (id: number) => (id === 0xff ? 'none' : String(id));

const PAGES = ['Items', 'Equipment', 'Quest'] as const;
type Page = (typeof PAGES)[number];
let shownPage: Page = 'Items';

/** Item slots that show a count under their picture in the pause menu (docs/re/saves.md). */
const AMMO_SLOTS = new Set([0, 1, 2, 3, 6]);
const WALLETS = [99, 200, 500];
const MAGIC_FULL = [0, 0x30, 0x60];
const MAGIC_STEP = 8;
/** Picture of upgrade level `n` is `base + n`, for each of the four rows of the equipment page's left column. */
const UPGRADE_BASE = [70, 76, 79, 82];
/** First item id of the equipment ids 59-70: four rows of three columns. */
const EQUIP_FIRST_ID = 59;
const NOTE_COLORS = ['#5c5', '#e55', '#58f', '#f93', '#b5d', '#ee5', '#aaa', '#aaa', '#aaa', '#aaa', '#aaa', '#aaa'];

const HEART_PATH = 'M10 17 L2 9 C-1 5 3 0 7 2 C8.5 2.7 9.5 4 10 5 C10.5 4 11.5 2.7 13 2 C17 0 21 5 18 9 Z';
const heartSvg = (cls: string): VNode => html`<svg viewBox="0 0 20 18" class=${cls}><path d=${HEART_PATH} /></svg>` as VNode;
const NOTE_PATH = 'M9 3 L17 1 L17 13 A3 3 0 1 1 15 10.2 L15 4.6 L11 5.4 L11 15 A3 3 0 1 1 9 12.2 Z';

const IDS_OF_SLOT: number[][] = Array.from({ length: 24 }, (_, slot) => ITEM_SLOT_OF_ID.flatMap((s, id) => (s === slot ? [id] : [])));

/** The next thing a click puts in a slot: empty, then each item that belongs there, then empty again. */
export function nextItem(slot: number, id: number): number {
  const options = [0xff, ...IDS_OF_SLOT[slot]!];
  return options[(options.indexOf(id) + 1) % options.length]!;
}

type Edit = (key: string, value: string) => void;
type EditMany = (edits: readonly (readonly [string, string])[]) => void;

const noFocus = (e: Event) => e.preventDefault();

function Heart({ fill, onClick }: { fill: number; onClick: () => void }): VNode {
  return html`<button type="button" class="heart" tabIndex=${-1} onMouseDown=${noFocus} onClick=${onClick}>${heartSvg('back')}<span class="clip" style=${`width:${Math.round(fill * 100)}%`}>${heartSvg('front')}</span></button>` as VNode;
}

function Stepper({ id, label, value, min, max, onSet }: { id: string; label: string; value: number; min: number; max: number; onSet: (v: number) => void }): VNode {
  const to = (v: number) => onSet(Math.min(max, Math.max(min, v)));
  return html`<span class="stepper" title=${label}>
    <${Button} id=${`${id}-minus`} disabled=${value <= min} onClick=${() => to(value - 1)}>−<//>
    <${NumberEdit} id=${id} value=${String(value)} onApply=${(t: string) => to(Number(t))} />
    <${Button} id=${`${id}-plus`} disabled=${value >= max} onClick=${() => to(value + 1)}>+<//>
  </span>` as VNode;
}

function Picture({ src }: { src: string | null }): VNode {
  return src ? (html`<img src=${src} alt="" draggable=${false} />` as VNode) : (html`<span class="tile" />` as VNode);
}

/** A small number over a picture; a click turns it into a field. */
function Count({ id, value, onSet }: { id: string; value: number; onSet: (v: number) => void }): VNode {
  const [text, setText] = useState<string | null>(null);
  if (text === null) return html`<span id=${id} class="count" title="Click to change the count" onClick=${() => setText(String(value))}>${value}</span>` as VNode;
  const done = (apply: boolean) => {
    if (apply && /^\d+$/.test(text)) onSet(Number(text));
    setText(null);
  };
  return html`<input id=${id} class="count" type="text" inputmode="numeric" autocomplete="off" value=${text} ref=${(el: HTMLInputElement | null) => el?.focus()}
    onInput=${(e: Event) => setText((e.currentTarget as HTMLInputElement).value)}
    onKeyDown=${(e: KeyboardEvent) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    }}
    onBlur=${() => setText(null)} />` as VNode;
}

interface PanelProps {
  f: Fields & { items: number[]; counts8C: number[]; upgrades: number[]; nibbleGroups: Record<string, { word9C: number; word70: number }>; bitsA4: number[] };
  edit: Edit;
  editMany: EditMany;
  icons: Icons;
  tip: (id: string, hint: string) => string;
}

function ItemsPage({ f, edit, icons, tip }: PanelProps): VNode {
  return html`<div class="page"><div class="grid six" id="inv-items">
    ${f.items.map((id, slot) => {
      const index = id === 0xff ? null : itemIconIndex(id);
      return html`<div key=${slot} class=${`cell item-slot ${id === 0xff ? 'empty' : ''}`}>
        <button type="button" class="pick" id=${`inv-items.${slot}`} tabIndex=${-1} onMouseDown=${noFocus}
          title=${tip(`items.${slot}`, `${slotName(slot).name}: ${id === 0xff ? 'empty' : `item ${id}`}. Click for the next item.`)}
          onClick=${() => edit(`items.${slot}`, itemText(nextItem(slot, id)))}>
          ${id !== 0xff && html`<${Picture} src=${index === null ? null : icons.item(index)} />`}
        </button>
        ${id !== 0xff && AMMO_SLOTS.has(slot) && html`<${Count} id=${`inv-counts8C.${slot}`} value=${f.counts8C[slot]!} onSet=${(v: number) => edit(`counts8C.${slot}`, String(v))} />`}
      </div>`;
    })}
  </div></div>` as VNode;
}

function EquipmentPage({ f, edit, editMany, icons, tip }: PanelProps): VNode {
  const groups = Object.values(f.nibbleGroups);
  return html`<div class="page"><div class="equip">
    <div class="stack4" id="inv-upgrades">
      ${f.upgrades.map((level, row) => html`<div key=${row} class=${`cell ${level === 0 ? 'empty' : ''}`}>
        <button type="button" class="pick" id=${`inv-upgrade.${row}`} tabIndex=${-1} onMouseDown=${noFocus}
          title=${tip(`upgrade.${row}`, `Upgrade ${row + 1}: level ${level}. Click to raise it (0 to 3).`)}
          onClick=${() => edit(`upgrade.${row}`, String((level + 1) % 4))}>${level > 0 && html`<${Picture} src=${icons.item(UPGRADE_BASE[row]! + level)} />`}</button>
      </div>`)}
    </div>
    <div class="grid three" id="inv-equipment">
      ${groups.flatMap((g, row) => [0, 1, 2].map((col) => {
        const worn = g.word70 === col + 1;
        const owned = (g.word9C & (1 << col)) !== 0;
        // Not owned, then owned, then worn, then not owned again.
        const click = worn ? () => editMany([[`equip${row}`, '0'], [`own.${row}.${col}`, '0']]) : owned ? () => edit(`equip${row}`, String(col + 1)) : () => edit(`own.${row}.${col}`, '1');
        const what = worn ? 'worn; click to give it up' : owned ? 'owned; click to wear it' : 'not owned; click to own it';
        return html`<div key=${`${row}.${col}`} class=${`cell ${worn ? 'worn' : owned ? '' : 'dim'}`}>
          <button type="button" class="pick" id=${`inv-equip.${row}.${col}`} tabIndex=${-1} onMouseDown=${noFocus}
            title=${tip(`equip.${row}.${col}`, `${EQUIP_ROWS[row]}, column ${col + 1}: ${what}`)}
            onClick=${click}><${Picture} src=${icons.item(EQUIP_FIRST_ID + row * 3 + col)} /></button>
        </div>`;
      }))}
    </div>
  </div></div>` as VNode;
}

function QuestPage({ f, edit, icons, tip }: PanelProps): VNode {
  const set = new Set(f.bitsA4);
  const cell = (bit: number, inner: VNode): VNode => html`<div key=${bit} class=${`cell ${set.has(bit) ? '' : 'dim'}`}>
    <button type="button" class="pick" id=${`inv-bitsA4.${bit}`} tabIndex=${-1} onMouseDown=${noFocus} onClick=${() => edit(`bitsA4.${bit}`, set.has(bit) ? '0' : '1')}
      title=${tip(`bitsA4.${bit}`, `${questBitName(bit)}: ${set.has(bit) ? 'lit' : 'off'}. Click to switch it.`)}>${inner}</button>
  </div>` as VNode;
  const note = (bit: number): VNode => html`<span class="tile note" style=${`--c:${NOTE_COLORS[bit - 6]}`}><svg viewBox="0 0 20 18"><path d=${NOTE_PATH} /></svg></span>` as VNode;
  const picture = (bit: number): VNode => {
    const index = questIconIndex(bit);
    return html`<${Picture} src=${index === null ? null : icons.quest(index)} />` as VNode;
  };
  return html`<div class="page quest">
    <div class="grid six" id="inv-medallions">${[0, 1, 2, 3, 4, 5].map((b) => cell(b, picture(b)))}</div>
    <div class="grid six" id="inv-stones">${[18, 19, 20, 21, 22, 23].map((b) => cell(b, picture(b)))}</div>
    <div class="grid six" id="inv-songs">${[6, 7, 8, 9, 10, 11].map((b) => cell(b, note(b)))}</div>
    <div class="grid six">${[12, 13, 14, 15, 16, 17].map((b) => cell(b, note(b)))}</div>
  </div>` as VNode;
}

type Context = PanelProps['f'] & {
  name: string;
  hearts: number;
  health: number;
  heartPieces: number;
  level32: number;
  byte33: number;
  flag3A: number;
  flag3C: number;
  count34: number;
  countD0: number;
  limit34: number;
  bytes68: number[];
  scene: number;
};

export function InventoryTab({ state: s, actions: a }: TabProps): VNode {
  const { fields, frozen, refusal } = s.inventory;
  const icons = useIcons();
  const labels = useLabels();
  const [page, setPage] = useState<Page>(shownPage);
  if (!fields) return html`<div class="tab"><p id="inv-none" class="hint">No game is running.</p></div>` as VNode;
  const f = fields as Context;
  const edit: Edit = (key, value) => a.editSave([[key, value]]);
  // A label of the user's own shows as a tooltip, marked as theirs.
  const tip = (id: string, hint: string): string => {
    const mine = labels.get('field', id);
    return mine ? `${mine} (your label)\n${hint}` : hint;
  };
  const props: PanelProps = { f, edit, editMany: a.editSave, icons, tip };

  const size = Math.min(2, f.level32);
  const full = MAGIC_FULL[size]!;
  const wallet = WALLETS[f.limit34] ?? WALLETS[2]!;
  // A count above the wallet's capacity is refused, so the wallet grows to fit it.
  const setRupees = (v: number) => {
    const need = v > 200 ? 2 : v > 99 ? 1 : 0;
    a.editSave(need > f.limit34 ? [['limit34', String(need)], ['count34', String(v)]] : [['count34', String(v)]]);
  };
  const tokens = f.bitsA4.includes(23);
  const tokenIcon = icons.quest(questIconIndex(23)!);
  const held = (key: string) => frozen.includes(key);
  const raw = (key: string, value: number | string, hint: string): VNode => html`<tr key=${key} title=${tip(key, hint)}>
    <td>${key}</td>
    <td><${NumberEdit} id=${`inv-raw-${key}`} value=${String(value)} width=${64} onApply=${(t: string) => edit(key, t.trim() === '' ? 'none' : t.trim())} /></td>
    <td><${Button} class="hold" pressed=${held(key)} title="Rewrite this value before every frame" onClick=${() => a.toggleFreeze(key)}>${held(key) ? 'Held' : 'Hold'}<//></td>
  </tr>` as VNode;
  const choose = (p: Page) => {
    shownPage = p;
    setPage(p);
  };

  return html`<div class="tab inv">
    ${refusal && html`<p id="inv-refusal" class="note">Editing is refused now: ${refusal}</p>`}
    <section class="inv-bar">
      <div class="hearts" id="inv-hearts">
        ${Array.from({ length: f.hearts }, (_, i) => html`<${Heart} key=${i} fill=${Math.max(0, Math.min(1, f.health - i))} onClick=${() => edit('health', String(f.health >= i + 1 ? i : i + 1))} />`)}
      </div>
      <div class="inv-line">
        <${Stepper} id="inv-hearts-count" label="Heart containers" value=${f.hearts} min=${1} max=${20} onSet=${(v: number) => edit('hearts', String(v))} />
        <span class="tag">pieces</span>
        <${Stepper} id="inv-heart-pieces" label="Heart pieces toward the next container (0 to 3)" value=${f.heartPieces} min=${0} max=${3} onSet=${(v: number) => edit('heartPieces', String(v))} />
        <${Button} id="inv-refill" onClick=${() => edit('health', String(f.hearts))}>Refill<//>
      </div>
      <div class="magic">
        <span class="tag">magic</span>
        <div class="magic-track" title=${FIELD_NAMES.byte33.hint}>
          ${size === 0
            ? html`<div class="magic-bar off" id="inv-magic-bar" />`
            : html`<div class="magic-bar" id="inv-magic-bar" style=${`width:${size === 1 ? 50 : 100}%`} onClick=${(e: MouseEvent) => {
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                edit('magic', String(Math.round(((e.clientX - box.left) / box.width) * full)));
              }}><i style=${`width:${(100 * f.byte33) / full}%`} /></div>`}
        </div>
        <${Button} id="inv-magic-minus" disabled=${size === 0} onClick=${() => edit('magic', String(Math.max(0, f.byte33 - MAGIC_STEP)))}>−<//>
        <${Button} id="inv-magic-plus" disabled=${size === 0} onClick=${() => edit('magic', String(Math.min(full, f.byte33 + MAGIC_STEP)))}>+<//>
        <span class="seg" id="inv-magic-size">
          ${['none', 'single', 'double'].map((label, n) => html`<${Button} key=${n} pressed=${size === n} title=${FIELD_NAMES.level32.hint} onClick=${() => edit('magicSize', String(n))}>${label}<//>`)}
        </span>
      </div>
      <div class="inv-line">
        <span class="coin" title=${FIELD_NAMES.count34.hint}>
          <svg class="rupee" viewBox="0 0 14 18"><path d="M7 0 L13 5 L13 13 L7 18 L1 13 L1 5 Z" fill="#4c4" stroke="#8e8" /></svg>
          <${NumberEdit} id="inv-count34" value=${String(f.count34)} onApply=${(t: string) => setRupees(Number(t))} />
          <${Button} id="inv-wallet" title=${FIELD_NAMES.limit34.hint} onClick=${() => edit('limit34', String((f.limit34 + 1) % 3))}>max ${wallet}<//>
        </span>
        <span class="coin" title=${FIELD_NAMES.countD0.hint}>
          <button type="button" class="icon" id="inv-token-toggle" tabIndex=${-1} onMouseDown=${noFocus} title="The spider token counter of the Quest Status page: click to show or hide it" onClick=${() => edit('bitsA4.23', tokens ? '0' : '1')}>
            ${tokenIcon ? html`<img class=${tokens ? '' : 'off'} src=${tokenIcon} alt="" />` : html`<span class="blank tile" />`}
          </button>
          <${NumberEdit} id="inv-countD0" value=${String(f.countD0)} onApply=${(t: string) => edit('countD0', t.trim())} />
        </span>
      </div>
    </section>

    <nav class="pages" role="tablist">
      ${PAGES.map((p) => html`<${Button} key=${p} id=${`inv-page-${p.toLowerCase()}`} pressed=${page === p} onClick=${() => choose(p)}>${p}<//>`)}
    </nav>
    ${page === 'Items' && html`<${ItemsPage} ...${props} />`}
    ${page === 'Equipment' && html`<${EquipmentPage} ...${props} />`}
    ${page === 'Quest' && html`<${QuestPage} ...${props} />`}
    ${icons.error && html`<p class="note" id="inv-icon-error">The pictures could not be read: ${icons.error}</p>`}

    <details class="raw" id="inv-advanced">
      <summary>Advanced: raw fields</summary>
      <table class="slots"><tbody>
        ${raw('hearts', f.hearts, FIELD_NAMES.hearts.hint)}
        ${raw('health', f.health, FIELD_NAMES.health.hint)}
        ${raw('count34', f.count34, FIELD_NAMES.count34.hint)}
        ${raw('limit34', f.limit34, FIELD_NAMES.limit34.hint)}
        ${raw('countD0', f.countD0, FIELD_NAMES.countD0.hint)}
        ${raw('heartPieces', f.heartPieces, 'Bits 28 to 31 of the quest word')}
        ${f.items.map((id, i) => raw(`items.${i}`, itemText(id), slotName(i).hint))}
        ${f.counts8C.map((v, i) => raw(`counts8C.${i}`, v, countName(i).hint))}
        <tr><td>name</td><td colspan="2">${f.name}</td></tr>
        <tr><td>scene</td><td colspan="2" title=${tip('scene', FIELD_NAMES.scene.hint)}>${hex(f.scene)}</td></tr>
        <tr><td>magic</td><td colspan="2" title=${FIELD_NAMES.byte33.hint}>size ${f.level32}, fill ${f.byte33}, flags ${f.flag3A} ${f.flag3C}</td></tr>
        <tr><td>buttons</td><td colspan="2" id="inv-bytes68">${f.bytes68.map((id, i) => `${BUTTON_ITEMS[i]} ${itemText(id)}`).join(' · ')}</td></tr>
        <tr><td>quest bits</td><td colspan="2" id="inv-bitsA4">${f.bitsA4.length ? f.bitsA4.join(', ') : 'none set'}</td></tr>
      </tbody></table>
    </details>
  </div>` as VNode;
}
