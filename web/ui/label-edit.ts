import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { labels as shared, MAX_LABEL, type LabelKind, type Labels } from './labels.ts';
import { Button, keepFocus } from './widgets.ts';

const YOURS = 'color:#8cf;font-style:italic';
const MARK = 'font-size:10px;color:#8cf;border:1px solid #8cf;border-radius:3px;padding:0 3px;margin-left:4px;font-style:normal';

/** Re-draws the caller when a label changes. */
export function useLabels(labels: Labels = shared): Labels {
  const [, tick] = useState(0);
  useEffect(() => labels.subscribe(() => tick((n) => n + 1)), [labels]);
  return labels;
}

export interface LabelledProps {
  kind: LabelKind;
  id: string | number;
  /** The proven or neutral name: shown when the user has no label, and beside the label as a note when they do. */
  name: string;
  hint?: string;
  labels?: Labels;
}

/** A name the user can replace with a label of their own; the label is drawn in its own style with a "your label" marker. */
export function Labelled({ kind, id, name, hint, labels = shared }: LabelledProps): VNode {
  useLabels(labels);
  const [text, setText] = useState<string | null>(null);
  const mine = labels.get(kind, id);
  const done = (el: HTMLInputElement, apply: boolean) => {
    if (apply && text !== null) labels.set(kind, id, text);
    setText(null);
    el.blur();
  };
  if (text !== null) {
    return html`<span class="label-edit"><input class="label-input" type="text" autocomplete="off" spellcheck=${false} maxlength=${MAX_LABEL}
      placeholder=${name} value=${text} style="width:120px"
      onInput=${(e: Event) => setText((e.currentTarget as HTMLInputElement).value)}
      onKeyDown=${(e: KeyboardEvent) => {
        if (e.key === 'Enter') done(e.currentTarget as HTMLInputElement, true);
        else if (e.key === 'Escape') done(e.currentTarget as HTMLInputElement, false);
      }}
      onBlur=${() => setText(null)} /></span>` as VNode;
  }
  return html`<span class="labelled" title=${hint}>
    ${mine === undefined
      ? html`<span class="proven">${name}</span>`
      : html`<span class="your-label" style=${YOURS}>${mine}</span><span class="your-mark" style=${MARK} title="Typed by you, not established from the game">your label</span> <span class="note">${name}</span>`}
    <button type="button" class="label-button" tabIndex=${-1} title="Give this a name of your own (empty clears it)" onMouseDown=${keepFocus}
      onClick=${() => setText(mine ?? '')} style="margin-left:4px;padding:0 4px">✎</button>
  </span>` as VNode;
}

/** Export to a JSON file and import from one, for every label of every tab. */
export function LabelsSection({ labels = shared }: { labels?: Labels }): VNode {
  useLabels(labels);
  const [message, setMessage] = useState('');
  const exportFile = () => {
    try {
      const url = URL.createObjectURL(new Blob([labels.exportJson()], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zelda-oot-js-labels.json';
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${labels.count()} labels`);
    } catch (err) {
      setMessage(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        setMessage(`Imported ${labels.importJson(await file.text())} labels`);
      } catch (err) {
        setMessage(`Import refused: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    input.click();
  };
  return html`<section class="labels">
    <h3>Your labels</h3>
    <p class="hint">Names you typed with ✎ for scenes, entrances, actors and fields. They are kept in this browser and marked "your label": nothing here is proven from the game.</p>
    <div class="row">
      <${Button} id="labels-export" disabled=${labels.count() === 0} onClick=${exportFile}>Export JSON<//>
      <${Button} id="labels-import" onClick=${importFile}>Import JSON�<//>
    </div>
    <p id="labels-message" class="note">${message || `${labels.count()} label${labels.count() === 1 ? '' : 's'} stored`}</p>
  </section>` as VNode;
}
