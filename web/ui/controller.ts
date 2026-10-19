import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PadView } from '../input.ts';
import type { UiActions } from './types.ts';

/** Standard-mapping button indices and what they do in the game (see GAMEPAD_BUTTONS in input.ts). */
export const PAD_MAPPING: ReadonlyArray<{ index: number; pad: string; game: string }> = [
  { index: 0, pad: 'A (south)', game: 'A' },
  { index: 2, pad: 'X (west)', game: 'B' },
  { index: 1, pad: 'B (east)', game: 'C-down' },
  { index: 3, pad: 'Y (north)', game: 'C-up' },
  { index: 6, pad: 'LT', game: 'Z' },
  { index: 7, pad: 'RT', game: 'Z' },
  { index: 4, pad: 'LB', game: 'L' },
  { index: 5, pad: 'RB', game: 'R' },
  { index: 9, pad: 'Start', game: 'Start' },
  { index: 12, pad: 'D-pad', game: 'D-pad' },
];

/** Names of the pressed buttons of `view` that the mapping knows. */
export function pressedNames(view: PadView): string[] {
  return PAD_MAPPING.filter((m) => view.buttons[m.index] || (m.index === 12 && [12, 13, 14, 15].some((i) => view.buttons[i]))).map((m) => m.pad);
}

const axis = (v: PadView, i: number) => (v.axes[i] ?? 0).toFixed(2);

export function ControllerSection({ actions: a }: { actions: Pick<UiActions, 'padView'> }): VNode {
  const [view, setView] = useState<PadView | null>(() => a.padView());
  useEffect(() => {
    const timer = setInterval(() => setView(a.padView()), 100);
    return () => clearInterval(timer);
  }, [a]);
  return html`<section id="controller">
    <h3>Controller</h3>
    ${view === null
      ? html`<p class="hint" id="controller-hint">No controller seen. Press any button on your controller.</p>`
      : html`<p id="controller-id">${view.id}</p>
        ${view.mapping === 'standard' ? '' : html`<p class="hint">Non-standard mapping: the standard button numbers are used, some buttons may differ.</p>`}
        <p class="note" id="controller-live">
          Pressed: ${pressedNames(view).join(', ') || 'none'} · Left stick ${axis(view, 0)}, ${axis(view, 1)} · Right stick (C) ${axis(view, 2)}, ${axis(view, 3)}
        </p>`}
    <table class="slots"><tbody>
      ${PAD_MAPPING.map((m) => html`<tr key=${m.index} class=${view?.buttons[m.index] ? 'current' : ''}><td>${m.pad}</td><td>${m.game}</td></tr>`)}
      <tr><td>Left stick</td><td>Stick</td></tr>
      <tr><td>Right stick</td><td>C buttons</td></tr>
    </tbody></table>
  </section>` as VNode;
}
