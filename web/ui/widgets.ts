import { html } from 'htm/preact';
import type { ComponentChildren, VNode } from 'preact';
import { useState } from 'preact/hooks';

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

// A number field takes keys while it has the focus; Enter applies it and gives the focus back to the game.
export function NumberEdit(p: { id: string; value: string; width?: number; onApply: (value: string) => void }): VNode {
  const [text, setText] = useState<string | null>(null);
  const apply = (el: HTMLInputElement) => {
    if (text !== null) p.onApply(text);
    setText(null);
    el.blur();
  };
  return html`<input id=${p.id} class="num" type="text" inputmode="numeric" autocomplete="off" spellcheck=${false}
    style=${p.width ? `width:${p.width}px` : ''} value=${text ?? p.value}
    onInput=${(e: Event) => setText((e.currentTarget as HTMLInputElement).value)}
    onKeyDown=${(e: KeyboardEvent) => {
      if (e.key === 'Enter') apply(e.currentTarget as HTMLInputElement);
      else if (e.key === 'Escape') {
        setText(null);
        (e.currentTarget as HTMLInputElement).blur();
      }
    }}
    onBlur=${() => setText(null)} />` as VNode;
}
