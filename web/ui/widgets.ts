import { html } from 'htm/preact';
import type { ComponentChildren, VNode } from 'preact';

// The page's buttons never take the focus from the game: a mouse press on them is cancelled before it moves the focus.
export const keepFocus = (e: Event): void => e.preventDefault();

export interface ButtonProps {
  id?: string;
  class?: string;
  pressed?: boolean;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children?: ComponentChildren;
}

export function Button(p: ButtonProps): VNode {
  return html`<button id=${p.id} class=${p.class} type="button" tabIndex=${-1} aria-pressed=${p.pressed} title=${p.title} disabled=${p.disabled} onMouseDown=${keepFocus} onClick=${p.onClick}>${p.children}</button>` as VNode;
}

export interface SliderProps {
  id: string;
  label: string;
  title: string;
  min: number;
  max: number;
  value: number;
  onInput: (value: number) => void;
}

export function Slider(p: SliderProps): VNode {
  // A slider that kept the focus would take the arrow keys from the game.
  return html`<label title=${p.title}>${p.label}
    <input id=${p.id} type="range" min=${p.min} max=${p.max} step=${5} value=${p.value} tabIndex=${-1}
      onInput=${(e: Event) => p.onInput(Number((e.currentTarget as HTMLInputElement).value))}
      onChange=${(e: Event) => (e.currentTarget as HTMLInputElement).blur()} />
    <output>${p.value}%</output></label>` as VNode;
}
