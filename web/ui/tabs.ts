import { html } from 'htm/preact';
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import type { TabProps } from './types.ts';
import { Button, Slider } from './widgets.ts';

export function GameTab({ state: s, actions: a }: TabProps): VNode {
  return html`<div class="tab">
    <section>
      <h3>Speed</h3>
      <${Button} id="hz-toggle" pressed=${s.wantedHz === 60} title="Run the game at 60 Hz (20 game frames per second) instead of the PAL 50 Hz (16.7)" onClick=${a.toggleHz}>60 Hz: ${s.wantedHz === 60 ? 'on' : 'off'}<//>
      <span id="hz-note" class="note" hidden=${s.wantedHz === s.bootHz}> applies the next time the page loads</span>
      <p class="hint">Hold Tab to fast-forward (no sound).</p>
    </section>
    <section>
      <h3>Smooth motion</h3>
      <${Button} id="smooth-toggle" pressed=${s.smooth} title="Draw pictures between game frames, so motion follows the display's refresh rate (adds up to one game frame of delay)" onClick=${() => a.setSmooth(!s.smooth)}>Smooth<//>
      <${Slider} id="smooth-strength" label="strength" title="How much of the motion between game frames is shown (less: nearer the game's own frames)" min=${0} max=${100} value=${s.strength} onInput=${a.setStrength} />
      <${Slider} id="smooth-span" label="catch-up" title="How much of a game frame the motion takes to catch up (less: less delay)" min=${25} max=${100} value=${s.span} onInput=${a.setSpan} />
    </section>
    <section>
      <h3>Picture and sound</h3>
      <div class="row">
        <${Button} id="native-toggle" pressed=${s.native} title="Native 320x240 with hard pixels (N)" onClick=${a.toggleNative}>Native resolution<//>
        <${Button} id="cull-cycle" title="Face culling: normal, swapped, off (C)" onClick=${a.cycleCull}>Culling: ${s.cull}<//>
        <${Button} id="mute-toggle" pressed=${s.muted} title="Mute (M)" onClick=${a.toggleMute}>${s.muted ? 'Muted' : 'Mute'}<//>
      </div>
    </section>
    <section class="touch-only">
      <h3>Touch</h3>
      <div class="row">
        <${Button} id="touch-toggle" onClick=${a.toggleControls}>${s.controlsHidden ? 'Show controls' : 'Hide controls'}<//>
        <${Button} id="fullscreen-toggle" onClick=${a.toggleFullscreen}>Fullscreen<//>
      </div>
    </section>
    <section class="keys">
      <h3>Keys</h3>
      <p class="help">Arrows: stick · Enter: Start · X: A · Z: B · Shift: Z · Q/E: L/R · IJKL: C buttons · WASD: D-pad · or a gamepad</p>
      <p class="help">C: face culling · N: native 320x240 · 5: save state · 6: load state · 7: next slot (1-4) · M: mute (sound starts at the first key press) · Tab: fast-forward</p>
    </section>
  </div>` as VNode;
}

const SLOT_NUMBERS = [1, 2, 3, 4];
const PLAY_SLOTS = [0, 1, 2];

export function SavesTab({ state: s, actions: a }: TabProps): VNode {
  useEffect(() => a.refreshSlots(), []);
  const available = s.slot !== null;
  const known = (n: number) => s.filled[n - 1];
  return html`<div class="tab">
    <section>
      <h3>Save states</h3>
      <p class="hint">Keys 5 saves, 6 loads and 7 moves to the next slot.</p>
      <table class="slots"><tbody>
        ${SLOT_NUMBERS.map((n) => html`<tr key=${n} class=${s.slot === n ? 'current' : ''}>
          <td><${Button} id=${`select-slot-${n}`} pressed=${s.slot === n} disabled=${!available} onClick=${() => a.selectSlot(n)}>Slot ${n}<//></td>
          <td class="note">${known(n) === undefined || known(n) === null ? '' : known(n) ? 'saved' : 'empty'}</td>
          <td class="row">
            <${Button} id=${`save-slot-${n}`} disabled=${!available} onClick=${() => a.saveSlot(n)}>Save<//>
            <${Button} id=${`load-slot-${n}`} disabled=${!available} onClick=${() => a.loadSlot(n)}>Load<//>
          </td>
        </tr>`)}
      </tbody></table>
    </section>
    <section>
      <h3>Saved games</h3>
      <div class="stack">
        <${Button} id="load-save-file" onClick=${a.loadSaveFile}>Load save file…<//>
        ${PLAY_SLOTS.map((i) => html`<${Button} key=${i} class="load-slot" onClick=${() => a.loadIntoPlay(i)}>Load slot ${i + 1} into play<//>`)}
        <${Button} id="back-to-file-select" onClick=${a.backToFileSelect}>Back to file select<//>
      </div>
    </section>
  </div>` as VNode;
}

export function DebugTab({ state: s, actions: a }: TabProps): VNode {
  return html`<div class="tab">
    <section>
      <${Button} id="debug-toggle" pressed=${s.overlayShown} title="Also draw this text over the picture" onClick=${() => a.setOverlay(!s.overlayShown)}>Show over the picture<//>
    </section>
    <pre id="debug-text">${s.debugText}</pre>
  </div>` as VNode;
}
