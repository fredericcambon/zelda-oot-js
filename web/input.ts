// Maps the keyboard and the Gamepad API to the state of controller 1 as the game reads it (OSContPad).

import { isTyping } from './ui/typing.ts';

/** Button bits of an OSContPad halfword. */
export const Button = {
  A: 0x8000, B: 0x4000, Z: 0x2000, Start: 0x1000,
  DUp: 0x0800, DDown: 0x0400, DLeft: 0x0200, DRight: 0x0100,
  L: 0x0020, R: 0x0010,
  CUp: 0x0008, CDown: 0x0004, CLeft: 0x0002, CRight: 0x0001,
} as const;

export interface PadState {
  buttons: number;
  /** Stick position, -128..127; the console's stick reaches about +-80. */
  x: number;
  y: number;
}

export const STICK_MAX = 80;
const STICK_DEADZONE = 0.2;
const C_STICK_THRESHOLD = 0.5;

/** `KeyboardEvent.code` to button. The arrows are the stick; N, C and M stay free for the page's own shortcuts. */
export const KEY_BUTTONS: Readonly<Record<string, number>> = {
  KeyX: Button.A, KeyZ: Button.B, ShiftLeft: Button.Z, ShiftRight: Button.Z, Enter: Button.Start,
  KeyQ: Button.L, KeyE: Button.R,
  KeyI: Button.CUp, KeyK: Button.CDown, KeyJ: Button.CLeft, KeyL: Button.CRight,
  KeyW: Button.DUp, KeyS: Button.DDown, KeyA: Button.DLeft, KeyD: Button.DRight,
};

/** Pad state for the set of `KeyboardEvent.code`s currently held. Up is positive y, as on the console. */
export function padFromKeys(held: ReadonlySet<string>): PadState {
  let buttons = 0;
  for (const code of held) buttons |= KEY_BUTTONS[code] ?? 0;
  const axis = (neg: string, pos: string) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
  return { buttons, x: axis('ArrowLeft', 'ArrowRight') * STICK_MAX, y: axis('ArrowDown', 'ArrowUp') * STICK_MAX };
}

/** The part of a browser Gamepad this module reads. */
export interface PadSnapshot {
  buttons: ReadonlyArray<{ pressed: boolean }>;
  axes: ReadonlyArray<number>;
}

/** Standard-mapping button index to N64 button: south A, west B, triggers Z, bumpers L and R, start, d-pad. */
const GAMEPAD_BUTTONS: ReadonlyArray<readonly [number, number]> = [
  [0, Button.A], [2, Button.B], [6, Button.Z], [7, Button.Z], [4, Button.L], [5, Button.R],
  [9, Button.Start], [12, Button.DUp], [13, Button.DDown], [14, Button.DLeft], [15, Button.DRight],
];

function stick(v: number): number {
  const m = Math.abs(v);
  if (m < STICK_DEADZONE) return 0;
  const scaled = Math.min(1, (m - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return Math.round(Math.sign(v) * scaled * STICK_MAX);
}

/** Pad state for a gamepad with the standard mapping: the left stick moves, the right stick gives the C buttons. */
export function padFromGamepad(gp: PadSnapshot): PadState {
  let buttons = 0;
  for (const [index, bit] of GAMEPAD_BUTTONS) if (gp.buttons[index]?.pressed) buttons |= bit;
  // East and north face buttons double as C-down and C-up for pads whose right stick is unavailable.
  if (gp.buttons[1]?.pressed) buttons |= Button.CDown;
  if (gp.buttons[3]?.pressed) buttons |= Button.CUp;
  const rx = gp.axes[2] ?? 0;
  const ry = gp.axes[3] ?? 0;
  if (rx < -C_STICK_THRESHOLD) buttons |= Button.CLeft;
  if (rx > C_STICK_THRESHOLD) buttons |= Button.CRight;
  if (ry < -C_STICK_THRESHOLD) buttons |= Button.CUp;
  if (ry > C_STICK_THRESHOLD) buttons |= Button.CDown;
  // 0 - n, not -n: a centred stick must give +0.
  return { buttons, x: stick(gp.axes[0] ?? 0), y: 0 - stick(gp.axes[1] ?? 0) };
}

/** Buttons are OR-ed; the stick with the larger deflection wins. */
export function mergePads(a: PadState, b: PadState): PadState {
  const pick = (p: number, q: number) => (Math.abs(q) > Math.abs(p) ? q : p);
  return { buttons: a.buttons | b.buttons, x: pick(a.x, b.x), y: pick(a.y, b.y) };
}

/** What the Controller section shows of a pad. */
export interface PadView {
  id: string;
  mapping: string;
  buttons: boolean[];
  axes: number[];
}

/** The browser Gamepad fields the tracker reads. */
export interface PadInfo extends PadSnapshot {
  index: number;
  id: string;
  mapping: string;
  connected: boolean;
}

/** The notice for a pad the browser just reported. */
export function connectNotice(pad: { id: string; mapping: string }): string {
  const base = `Controller connected: ${pad.id}`;
  return pad.mapping === 'standard' ? base : `${base} (non-standard mapping: standard button numbers assumed, some buttons may differ)`;
}

/**
 * Which pad drives the game: the one the last gamepadconnected event named, else the first connected one.
 * A pad whose mapping is not 'standard' is still read with the standard indices.
 */
export class GamepadTracker {
  private active: number | null = null;

  constructor(private readonly notify: (text: string) => void = () => {}) {}

  connected(pad: PadInfo): void {
    this.active = pad.index;
    this.notify(connectNotice(pad));
  }

  disconnected(index: number): void {
    if (this.active === index) this.active = null;
    this.notify('Controller disconnected');
  }

  /** The pad to read among `list` (as `navigator.getGamepads()` gives it). */
  pick(list: ReadonlyArray<PadInfo | null>): PadInfo | null {
    const live = list.filter((g): g is PadInfo => !!g?.connected);
    const chosen = live.find((g) => g.index === this.active)
      ?? live.find((g) => g.mapping === 'standard')
      ?? live[0]
      ?? null;
    this.active = chosen?.index ?? null;
    return chosen;
  }
}

export function viewOf(pad: PadInfo): PadView {
  return { id: pad.id, mapping: pad.mapping, buttons: pad.buttons.map((b) => b.pressed), axes: [...pad.axes] };
}

/** Collects keyboard events and polls the active gamepad; both work together, whatever element has the focus. */
export class Input {
  private readonly held = new Set<string>();
  private readonly pads: GamepadTracker;
  private readonly getPads: () => ReadonlyArray<PadInfo | null>;

  constructor(target: Window = window, notify: (text: string) => void = () => {}) {
    this.pads = new GamepadTracker(notify);
    this.getPads = () => Array.from(navigator.getGamepads?.() ?? []) as ReadonlyArray<PadInfo | null>;
    target.addEventListener('keydown', this.onKey);
    target.addEventListener('keyup', this.onKey);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('gamepadconnected', (e) => this.pads.connected((e as GamepadEvent).gamepad));
    target.addEventListener('gamepaddisconnected', (e) => this.pads.disconnected((e as GamepadEvent).gamepad.index));
  }

  /** The pad as it is right now. */
  poll(): PadState {
    const keys = padFromKeys(this.held);
    const gp = this.pads.pick(this.getPads());
    return gp ? mergePads(keys, padFromGamepad(gp)) : keys;
  }

  /** Whether a gamepad is connected right now. */
  hasGamepad(): boolean {
    return this.pads.pick(this.getPads()) !== null;
  }

  /** The active pad's raw state for display, or null while none is seen. */
  view(): PadView | null {
    const gp = this.pads.pick(this.getPads());
    return gp ? viewOf(gp) : null;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // A key already held still gets its release, so that it cannot stick.
    if (e.type === 'keydown' && isTyping(e)) return;
    if (!(e.code in KEY_BUTTONS) && !e.code.startsWith('Arrow')) return;
    e.preventDefault();
    if (e.type === 'keydown') this.held.add(e.code);
    else this.held.delete(e.code);
  };

  private readonly onBlur = (): void => this.held.clear();
}
