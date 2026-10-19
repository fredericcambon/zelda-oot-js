import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LABEL_KINDS, labels as shared, MAX_LABEL, type LabelKind, type Labels } from './labels.ts';
import { Button } from './widgets.ts';

/** Re-draws the caller when a label changes. */
export function useLabels(labels: Labels = shared): Labels {
  const [, tick] = useState(0);
  useEffect(() => labels.subscribe(() => tick((n) => n + 1)), [labels]);
  return labels;
}

const text = (e: Event) => (e.currentTarget as HTMLInputElement).value;

/** One label of the list: its text is a field that applies on Enter or when it loses the focus. */
function LabelRow({ kind, id, label, labels }: { kind: LabelKind; id: string; label: string; labels: Labels }): VNode {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => {
    if (draft !== null) labels.set(kind, id, draft);
    setDraft(null);
  };
  return html`<tr class="label-row">
    <td class="note">${kind}</td>
    <td>${id}</td>
    <td><input class="label-text" type="text" autocomplete="off" spellcheck=${false} maxlength=${MAX_LABEL} value=${draft ?? label}
      onInput=${(e: Event) => setDraft(text(e))}
      onKeyDown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        else if (e.key === 'Escape') setDraft(null);
      }}
      onBlur=${apply} /></td>
    <td><${Button} class="label-remove" onClick=${() => labels.set(kind, id, '')}>Remove<//></td>
  </tr>` as VNode;
}

/** Names the user gave to scenes, entrances, actors and fields: add, change and remove them, and move them as JSON. */
export function LabelsSection({ labels = shared }: { labels?: Labels }): VNode {
  useLabels(labels);
  const [kind, setKind] = useState<LabelKind>('scene');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [message, setMessage] = useState('');
  const add = () => {
    if (!id.trim() || !name.trim()) return setMessage('Give an id and a name');
    labels.set(kind, id.trim(), name);
    setId('');
    setName('');
    setMessage('');
  };
  const importText = () => {
    try {
      setMessage(`Imported ${labels.importJson(json)} labels`);
    } catch (err) {
      setMessage(`Import refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const all = labels.list();
  return html`<section class="labels">
    <h3>Labels</h3>
    <p class="hint">Your own names for scenes, entrances, actors and fields, kept in this browser. They show as tooltips where the game gives no name.</p>
    <div class="row labels-add">
      <select id="label-kind" style="background:#111;color:#ddd;border:1px solid #444;border-radius:3px;font:inherit;font-size:12px;padding:4px" value=${kind} onChange=${(e: Event) => setKind((e.currentTarget as HTMLSelectElement).value as LabelKind)}>
        ${LABEL_KINDS.map((k) => html`<option key=${k} value=${k}>${k}</option>`)}
      </select>
      <input id="label-id" type="text" autocomplete="off" placeholder="id" style="width:70px;flex:none" value=${id} onInput=${(e: Event) => setId(text(e))} />
      <input id="label-name" type="text" autocomplete="off" placeholder="name" maxlength=${MAX_LABEL} value=${name} onInput=${(e: Event) => setName(text(e))}
        onKeyDown=${(e: KeyboardEvent) => e.key === 'Enter' && add()} />
      <${Button} id="label-add" onClick=${add}>Add<//>
    </div>
    ${all.length > 0 && html`<table class="slots" id="label-list"><tbody>
      ${all.map((l) => html`<${LabelRow} key=${`${l.kind}:${l.id}`} kind=${l.kind} id=${l.id} label=${l.text} labels=${labels} />`)}
    </tbody></table>`}
    <div class="row">
      <${Button} id="labels-export" disabled=${all.length === 0} onClick=${() => { setJson(labels.exportJson()); setMessage('Copy the JSON below to keep it'); }}>Export<//>
      <${Button} id="labels-import" disabled=${json.trim() === ''} onClick=${importText}>Import<//>
    </div>
    <textarea id="labels-json" rows="4" spellcheck=${false} placeholder="Export fills this with JSON; paste JSON here and press Import" value=${json}
      style="width:100%;box-sizing:border-box;margin-top:6px;font:11px ui-monospace,monospace;background:#111;color:#ddd;border:1px solid #444;border-radius:3px"
      onInput=${(e: Event) => setJson((e.currentTarget as HTMLTextAreaElement).value)} />
    <p id="labels-message" class="note">${message}</p>
  </section>` as VNode;
}
