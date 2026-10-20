// On-screen touch controls: a floating analog stick and the N64 buttons, feeding the same PadState as the keyboard.
import { Button, STICK_MAX, type PadState } from './input.ts';

/** Drag distance, in CSS pixels, at which the stick reaches full deflection; the drawn ring has a radius of 56, so full deflection comes before its edge. */
export const STICK_RADIUS_PX = 48;
const STICK_DEADZONE = 0.15;

/** Stick position for a drag of (dx, dy) screen pixels from the touch-down point. Screen y grows downwards; pad y grows upwards. */
export function stickFromOffset(dx: number, dy: number, radius = STICK_RADIUS_PX): { x: number; y: number } {
  const m = Math.hypot(dx, dy) / radius;
  if (m < STICK_DEADZONE) return { x: 0, y: 0 };
  const scaled = Math.min(1, (m - STICK_DEADZONE) / (1 - STICK_DEADZONE)) * STICK_MAX;
  const angle = Math.atan2(-dy, dx);
  // 0 + n: keeps an axis that rounds to zero at +0.
  return { x: 0 + Math.round(Math.cos(angle) * scaled), y: 0 + Math.round(Math.sin(angle) * scaled) };
}

export interface TouchButton {
  id: string;
  label: string;
  bit: number;
  /** Left, top and size in CSS pixels inside the button cluster. */
  x: number;
  y: number;
  size: number;
  /** Placed alone at the top centre of the screen instead of in the cluster. */
  top?: true;
  /** Placed alone at the left, above the stick zone, so the left thumb can hold it while the right thumb works the cluster. */
  left?: true;
}

export const CLUSTER_WIDTH = 308;
export const CLUSTER_HEIGHT = 240;

/**
 * Buttons of the right-hand cluster: A largest at the bottom right with B on its left, the C buttons as a diamond above A,
 * R (big) left of B, L (small) above it. Z (big) sits alone at the left above the stick zone and Start (small) alone at the top centre.
 * Every size is at least 48.
 */
export const TOUCH_BUTTONS: readonly TouchButton[] = [
  { id: 'cup', label: 'C▲', bit: Button.CUp, x: 212, y: 0, size: 48 },
  { id: 'cleft', label: 'C◀', bit: Button.CLeft, x: 164, y: 48, size: 48 },
  { id: 'cright', label: 'C▶', bit: Button.CRight, x: 260, y: 48, size: 48 },
  { id: 'cdown', label: 'C▼', bit: Button.CDown, x: 212, y: 96, size: 48 },
  { id: 'a', label: 'A', bit: Button.A, x: 236, y: 168, size: 72 },
  { id: 'b', label: 'B', bit: Button.B, x: 164, y: 184, size: 56 },
  { id: 'l', label: 'L', bit: Button.L, x: 36, y: 0, size: 48 },
  { id: 'r', label: 'R', bit: Button.R, x: 92, y: 184, size: 60 },
  { id: 'z', label: 'Z', bit: Button.Z, x: 0, y: 0, size: 64, left: true },
  { id: 'start', label: 'Start', bit: Button.Start, x: 0, y: 0, size: 48, top: true },
];

/** How far a held button's hit area reaches past its box, in CSS pixels. */
export const HELD_GROW_PX = 14;

export interface HitBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The button under (x, y); the held one also answers within `grow` pixels of its box, and wins over the others there. */
export function pickButton(boxes: readonly HitBox[], x: number, y: number, held: string | null, grow = HELD_GROW_PX): string | null {
  const inside = (b: HitBox, g: number) => x >= b.left - g && x <= b.right + g && y >= b.top - g && y <= b.bottom + g;
  const keep = boxes.find((b) => b.id === held && inside(b, grow));
  if (keep) return keep.id;
  return boxes.find((b) => inside(b, 0))?.id ?? null;
}

export interface TouchLook {
  /** Percent, 10 to 100. */
  opacity: number;
  /** Percent of the normal button size, 60 to 140. */
  size: number;
}

export const DEFAULT_LOOK: TouchLook = { opacity: 50, size: 100 };
const LOOK_KEY = 'oot.touch.look';

const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

export function normalizeLook(raw: Partial<TouchLook> | null | undefined): TouchLook {
  return { opacity: clamp(raw?.opacity, 10, 100, DEFAULT_LOOK.opacity), size: clamp(raw?.size, 60, 140, DEFAULT_LOOK.size) };
}

export function loadLook(): TouchLook {
  try {
    return normalizeLook(JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

export function saveLook(look: TouchLook): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // The choice then lasts until the page is closed.
  }
}

/** Applies the look to the page through the CSS variables the overlay reads. */
export function applyLook(look: TouchLook): void {
  const st = document.documentElement.style;
  st.setProperty('--touch-opacity', String(look.opacity / 100));
  st.setProperty('--touch-scale', String(look.size / 100));
}

/** Pointer bookkeeping for the stick and the buttons, independent of the DOM. */
export class TouchPad {
  private stickId: number | null = null;
  private originX = 0;
  private originY = 0;
  private dx = 0;
  private dy = 0;
  private readonly pressed = new Map<number, number>();

  stickDown(id: number, x: number, y: number): void {
    if (this.stickId !== null) return;
    this.stickId = id;
    this.originX = x;
    this.originY = y;
    this.dx = 0;
    this.dy = 0;
  }

  stickMove(id: number, x: number, y: number): void {
    if (id !== this.stickId) return;
    this.dx = x - this.originX;
    this.dy = y - this.originY;
  }

  buttonDown(id: number, bit: number): void {
    this.pressed.set(id, bit);
  }

  /** Releases whatever the pointer held. */
  up(id: number): void {
    this.pressed.delete(id);
    if (id === this.stickId) {
      this.stickId = null;
      this.dx = 0;
      this.dy = 0;
    }
  }

  reset(): void {
    this.pressed.clear();
    this.stickId = null;
    this.dx = 0;
    this.dy = 0;
  }

  /** Stick offset from its origin in pixels, for drawing the knob; null when no finger is on the stick. */
  get stick(): { originX: number; originY: number; dx: number; dy: number } | null {
    return this.stickId === null ? null : { originX: this.originX, originY: this.originY, dx: this.dx, dy: this.dy };
  }

  poll(): PadState {
    let buttons = 0;
    for (const bit of this.pressed.values()) buttons |= bit;
    return { buttons, ...stickFromOffset(this.dx, this.dy) };
  }
}

/** True when the device has a touch screen as primary pointer. */
export const hasCoarsePointer = (): boolean => matchMedia('(pointer: coarse)').matches;

/** Fullscreen and the landscape lock both need a user gesture, and for touch only the release counts as one; browsers without them (iOS Safari on a page) ignore the request. */
function enterLandscapeFullscreen(): void {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  root.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation.lock('landscape'))
    .catch(() => undefined);
}

/** Leaves fullscreen when in it, otherwise enters it (landscape where the browser allows). */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else enterLandscapeFullscreen();
}

/** Builds the overlay inside `layer` and shows it on touch devices (coarse pointer, or the first touchstart). */
export class TouchControls {
  readonly pad = new TouchPad();
  private hidden = false;

  constructor(private readonly layer: HTMLElement, toggle?: HTMLButtonElement) {
    const root = document.documentElement;
    const enable = () => root.classList.add('touch');
    if (hasCoarsePointer()) enable();
    else addEventListener('touchstart', enable, { once: true, passive: true });

    applyLook(loadLook());
    this.buildStick();
    this.buildButtons();
    this.buildFullscreenButton();
    toggle?.addEventListener('click', () => {
      this.toggleHidden();
      toggle.textContent = this.hidden ? 'Show controls' : 'Hide controls';
    });
    addEventListener('blur', () => this.release());
    layer.addEventListener('pointerup', enterLandscapeFullscreen, { once: true });
  }

  /** Shows the controls when hidden and hides them when shown; returns whether they are hidden now. */
  toggleHidden(): boolean {
    this.hidden = !this.hidden;
    document.documentElement.classList.toggle('touch-hidden', this.hidden);
    this.release();
    this.drawStick();
    return this.hidden;
  }

  /** Lets go of the stick and every button. */
  release(): void {
    this.pad.reset();
    this.releaseButtons();
  }

  private releaseButtons: () => void = () => {};

  poll(): PadState {
    return this.pad.poll();
  }

  private knob!: HTMLElement;
  private base!: HTMLElement;

  private buildStick(): void {
    const zone = document.createElement('div');
    zone.id = 'touch-stick';
    this.base = document.createElement('div');
    this.base.className = 'stick-base';
    this.knob = document.createElement('div');
    this.knob.className = 'stick-knob';
    this.base.hidden = true;
    this.base.append(this.knob);
    zone.append(this.base);
    this.layer.append(zone);
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      this.pad.stickDown(e.pointerId, e.clientX, e.clientY);
      this.base.style.left = `${e.clientX - r.left}px`;
      this.base.style.top = `${e.clientY - r.top}px`;
      this.drawStick();
    });
    zone.addEventListener('pointermove', (e) => {
      this.pad.stickMove(e.pointerId, e.clientX, e.clientY);
      this.drawStick();
    });
    const end = (e: PointerEvent) => {
      this.pad.up(e.pointerId);
      this.drawStick();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  private drawStick(): void {
    const s = this.pad.stick;
    this.base.hidden = !s;
    if (!s) return;
    const m = Math.hypot(s.dx, s.dy);
    const k = m > STICK_RADIUS_PX ? STICK_RADIUS_PX / m : 1;
    this.knob.style.transform = `translate(${s.dx * k}px, ${s.dy * k}px)`;
  }

  private buildButtons(): void {
    const cluster = document.createElement('div');
    cluster.id = 'touch-buttons';
    cluster.style.width = `${CLUSTER_WIDTH}px`;
    cluster.style.height = `${CLUSTER_HEIGHT}px`;
    const topBar = document.createElement('div');
    topBar.id = 'touch-top';
    const leftBar = document.createElement('div');
    leftBar.id = 'touch-left';
    const els = new Map<string, { el: HTMLElement; bit: number }>();
    for (const b of TOUCH_BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      el.id = `touch-${b.id}`;
      el.className = 'touch-button';
      el.textContent = b.label;
      el.dataset.bit = String(b.bit);
      const box = { width: `${b.size}px`, height: `${b.size}px` };
      Object.assign(el.style, b.top || b.left ? box : { left: `${b.x}px`, top: `${b.y}px`, ...box });
      els.set(b.id, { el, bit: b.bit });
      (b.top ? topBar : b.left ? leftBar : cluster).append(el);
    }
    this.layer.append(cluster, topBar, leftBar);

    // A finger owns a button from touch-down on; sliding onto another button moves it there without lifting.
    const held = new Map<number, string>();
    const boxes = (): HitBox[] => [...els].map(([id, { el }]) => {
      const r = el.getBoundingClientRect();
      return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    const hold = (pointer: number, id: string | null) => {
      const prev = held.get(pointer);
      if (id === (prev ?? null)) return;
      if (prev) els.get(prev)?.el.classList.remove('down');
      if (id) {
        const b = els.get(id)!;
        b.el.classList.add('down');
        this.pad.buttonDown(pointer, b.bit);
        held.set(pointer, id);
        navigator.vibrate?.(12);
      } else {
        this.pad.up(pointer);
        held.delete(pointer);
      }
    };
    this.layer.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement).closest('.touch-button')) return;
      e.preventDefault();
      this.layer.setPointerCapture(e.pointerId);
      hold(e.pointerId, pickButton(boxes(), e.clientX, e.clientY, null));
    });
    this.layer.addEventListener('pointermove', (e) => {
      const id = held.get(e.pointerId);
      if (id) hold(e.pointerId, pickButton(boxes(), e.clientX, e.clientY, id));
    });
    const end = (e: PointerEvent) => hold(e.pointerId, null);
    this.layer.addEventListener('pointerup', end);
    this.layer.addEventListener('pointercancel', end);
    this.releaseButtons = () => {
      for (const pointer of [...held.keys()]) hold(pointer, null);
    };
  }

  /** Enters fullscreen and locks landscape where the browser allows it; shown in landscape only. */
  private buildFullscreenButton(): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.id = 'touch-fullscreen';
    btn.textContent = '⛶';
    btn.setAttribute('aria-label', 'Fullscreen');
    btn.addEventListener('click', toggleFullscreen);
    this.layer.append(btn);
  }
}
