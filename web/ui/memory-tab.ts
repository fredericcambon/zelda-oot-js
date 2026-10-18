import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { CHANGED_TICKS, formatValue, hexAddress, ROW_BYTES, VALUE_TYPES, WINDOW_BYTES, WINDOW_ROWS, type ValueType } from '../inspect/memory.ts';
import type { TabProps } from './types.ts';
import { Button, NumberEdit } from './widgets.ts';

type Grouping = 1 | 2 | 4;
const GROUPINGS: { size: Grouping; label: string }[] = [{ size: 1, label: 'Byte' }, { size: 2, label: 'Half' }, { size: 4, label: 'Word' }];
const EDIT_TYPES: ValueType[] = ['u8', 'u16', 'u32'];

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, '0');

// A text field takes keys while it has the focus; Enter submits it.
function Field(p: { id?: string; value: string; placeholder?: string; width?: number; onInput: (v: string) => void; onEnter?: () => void }): VNode {
  return html`<input id=${p.id} type="text" autocomplete="off" spellcheck=${false} placeholder=${p.placeholder}
    style=${p.width ? `width:${p.width}px;flex:none` : ''} value=${p.value}
    onInput=${(e: Event) => p.onInput((e.currentTarget as HTMLInputElement).value)}
    onKeyDown=${(e: KeyboardEvent) => {
      if (e.key === 'Enter') p.onEnter?.();
      else if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur();
    }} />` as VNode;
}

function TypeSelect(p: { id?: string; value: ValueType; types: readonly ValueType[]; onChange: (t: ValueType) => void }): VNode {
  return html`<select id=${p.id} tabIndex=${-1} value=${p.value} onChange=${(e: Event) => {
    const el = e.currentTarget as HTMLSelectElement;
    p.onChange(el.value as ValueType);
    el.blur();
  }}>${p.types.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}</select>` as VNode;
}

function HexView({ state: s, actions: a }: TabProps): VNode {
  const m = s.memory;
  const [goto, setGoto] = useState('');
  const [error, setError] = useState('');
  const [group, setGroup] = useState<Grouping>(1);
  const [picked, setPicked] = useState<number | null>(null);
  const [type, setType] = useState<ValueType>('u8');
  const [value, setValue] = useState('');
  const go = () => setError(a.gotoMemory(goto) ?? '');
  const cells = ROW_BYTES / group;
  const pickedAt = picked ?? m.start;
  const write = () => {
    a.writeMemory(pickedAt, type, value);
    setValue('');
  };

  const rows: VNode[] = [];
  for (let r = 0; r < WINDOW_ROWS; r++) {
    const base = r * ROW_BYTES;
    const row: VNode[] = [];
    for (let c = 0; c < cells; c++) {
      const at = base + c * group;
      let text = '';
      let changed = false;
      for (let i = 0; i < group; i++) {
        text += hex(m.bytes[at + i]!, 2);
        changed ||= m.age[at + i]! < CHANGED_TICKS;
      }
      const addr = m.start + at;
      const selected = pickedAt >= addr && pickedAt < addr + group;
      row.push(html`<span key=${c} class=${`cell${changed ? ' changed' : ''}${selected ? ' picked' : ''}`} onClick=${() => {
        setPicked(addr);
        setType(group === 1 ? 'u8' : group === 2 ? 'u16' : 'u32');
      }}>${text}</span>`);
    }
    rows.push(html`<div key=${r} class="hexrow"><span class="addr">${hex(m.start + base, 8)}</span>${row}</div>`);
  }

  return html`<section>
    <h3>Hex view</h3>
    <div class="row">
      <${Field} id="mem-goto" value=${goto} placeholder="0x80xxxxxx or offset" onInput=${setGoto} onEnter=${go} />
      <${Button} id="mem-go" onClick=${go}>Go<//>
    </div>
    ${error && html`<p id="mem-error" class="note">${error}</p>`}
    <div class="row">
      ${GROUPINGS.map((g) => html`<${Button} key=${g.size} class="group" pressed=${group === g.size} onClick=${() => setGroup(g.size)}>${g.label}<//>`)}
      <${Button} id="mem-prev" title="Previous ${WINDOW_BYTES} bytes" onClick=${() => a.pageMemory(-WINDOW_BYTES)}>◀<//>
      <${Button} id="mem-next" title="Next ${WINDOW_BYTES} bytes" onClick=${() => a.pageMemory(WINDOW_BYTES)}>▶<//>
    </div>
    ${!m.running
      ? html`<p id="mem-none" class="hint">No game is running.</p>`
      : html`<div id="hexview" class="hex">${rows}</div>
        <p class="hint">Click a value to pick it. Bytes that changed lately are lit.</p>
        <div class="row">
          <span class="addr" id="mem-picked">${hexAddress(pickedAt)}</span>
          <${TypeSelect} id="mem-type" value=${type} types=${EDIT_TYPES} onChange=${setType} />
          <${Field} id="mem-value" value=${value} placeholder="123 or 0x7B" width=${90} onInput=${setValue} onEnter=${write} />
          <${Button} id="mem-write" onClick=${write}>Write<//>
        </div>
        ${m.refusal && html`<p class="note">Writing is refused now: ${m.refusal}</p>`}`}
  </section>` as VNode;
}

function Watches({ state: s, actions: a }: TabProps): VNode {
  const [addr, setAddr] = useState('');
  const [type, setType] = useState<ValueType>('u16');
  const [error, setError] = useState('');
  const add = () => setError(a.addWatch(addr, type) ?? '');
  return html`<section>
    <h3>Watches</h3>
    <div class="row">
      <${Field} id="watch-addr" value=${addr} placeholder="0x80xxxxxx" width=${110} onInput=${setAddr} onEnter=${add} />
      <${TypeSelect} id="watch-type" value=${type} types=${VALUE_TYPES} onChange=${setType} />
      <${Button} id="watch-add" onClick=${add}>Pin<//>
    </div>
    ${error && html`<p id="watch-error" class="note">${error}</p>`}
    <table class="slots watches"><tbody>
      ${s.memory.watches.map((w) => html`<tr key=${w.id} class="watch">
        <td class="addr"><a href="#" tabIndex=${-1} onMouseDown=${(e: Event) => e.preventDefault()} onClick=${(e: Event) => { e.preventDefault(); a.gotoMemory(hexAddress(w.addr)); }}>${hex(w.addr, 8)}</a></td>
        <td class="note">${w.type}</td>
        <td><${NumberEdit} id=${`watch-${w.id}`} value=${formatValue(w.type, w.value)} width=${88} onApply=${(v: string) => a.writeWatch(w.id, v)} /></td>
        <td class="row">
          <${Button} class="hold" pressed=${w.frozen} title="Rewrite this value before every frame" onClick=${() => a.holdWatch(w.id)}>${w.frozen ? 'Held' : 'Hold'}<//>
          <${Button} class="unpin" title="Remove" onClick=${() => a.removeWatch(w.id)}>✕<//>
        </td>
      </tr>`)}
    </tbody></table>
  </section>` as VNode;
}

function Search({ state: s, actions: a }: TabProps): VNode {
  const [type, setType] = useState<ValueType>('u16');
  const [value, setValue] = useState('');
  const search = s.memory.search;
  return html`<section>
    <h3>Search</h3>
    <p class="hint">Find where the game keeps a value: start, change it in the game, then narrow.</p>
    <div class="row">
      <${TypeSelect} id="search-type" value=${search?.type ?? type} types=${VALUE_TYPES} onChange=${setType} />
      <${Button} id="search-start" onClick=${() => a.searchStart(type)}>${search ? 'Restart' : 'Start'}<//>
      ${search && html`<${Button} id="search-end" onClick=${a.searchEnd}>Clear<//>`}
    </div>
    ${search && html`<div class="row">
        <${Field} id="search-value" value=${value} placeholder="value" width=${90} onInput=${setValue} onEnter=${() => a.searchNarrow('equal', value)} />
        <${Button} id="search-equal" onClick=${() => a.searchNarrow('equal', value)}>Equal<//>
        <${Button} id="search-changed" onClick=${() => a.searchNarrow('changed')}>Changed<//>
        <${Button} id="search-unchanged" onClick=${() => a.searchNarrow('unchanged')}>Unchanged<//>
      </div>
      <p id="search-count" class="hint">${search.count === null ? 'Every address is possible.' : `${search.count} address${search.count === 1 ? '' : 'es'} left${search.count > search.hits.length ? `, first ${search.hits.length} shown` : ''}.`}</p>
      <table class="slots"><tbody>
        ${search.hits.map((h) => html`<tr key=${h.addr} class="hit">
          <td class="addr">${hex(h.addr, 8)}</td>
          <td>${formatValue(search.type, h.value)}</td>
          <td class="row">
            <${Button} class="hit-view" onClick=${() => a.gotoMemory(hexAddress(h.addr))}>View<//>
            <${Button} class="hit-pin" onClick=${() => a.addWatch(hexAddress(h.addr), search.type)}>Pin<//>
          </td>
        </tr>`)}
      </tbody></table>`}
  </section>` as VNode;
}

function Cheats({ state: s, actions: a }: TabProps): VNode {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const add = () => {
    const err = a.addCheat(name, code);
    setError(err ?? '');
    if (!err) {
      setName('');
      setCode('');
    }
  };
  return html`<section>
    <h3>Cheat codes</h3>
    <p class="hint">One code per line: 8 digits of address, a space, 4 digits of value. 80 and 81 write 8 and 16 bits; D0 and D1 run the next code only if equal (D2, D3: if not equal). A code is written before every frame while it is on, in a scene.</p>
    <${Field} id="cheat-name" value=${name} placeholder="name" onInput=${setName} />
    <textarea id="cheat-code" rows=${3} spellcheck=${false} placeholder="8011A5D0 0063" value=${code} onInput=${(e: Event) => setCode((e.currentTarget as HTMLTextAreaElement).value)} />
    <div class="row"><${Button} id="cheat-add" onClick=${add}>Add code<//></div>
    ${error && html`<p id="cheat-error" class="note">${error}</p>`}
    <table class="slots cheats"><tbody>
      ${s.cheats.map((c) => html`<tr key=${c.id} class="cheat">
        <td><${Button} class="cheat-toggle" pressed=${c.enabled} onClick=${() => a.toggleCheat(c.id)}>${c.enabled ? 'On' : 'Off'}<//></td>
        <td><div>${c.name || 'unnamed'}</div><div class="code">${c.code.trim().split(/\s*\n\s*/).join(' · ')}</div></td>
        <td><${Button} class="cheat-remove" title="Remove" onClick=${() => a.removeCheat(c.id)}>✕<//></td>
      </tr>`)}
    </tbody></table>
  </section>` as VNode;
}

export function MemoryTab(p: TabProps): VNode {
  return html`<div class="tab memory">
    <${HexView} ...${p} />
    <${Watches} ...${p} />
    <${Search} ...${p} />
    <${Cheats} ...${p} />
  </div>` as VNode;
}
