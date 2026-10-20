// On-screen touch controls: a floating analog stick and the N64 buttons, feeding the same PadState as the keyboard.
import { Button, STICK_MAX, type PadState } from './input.ts';

/** Drag distance, in CSS pixels, at which the stick reaches full deflection. */
export const STICK_RADIUS_PX = 56;
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

/** A button's rectangle in reference CSS pixels: left, top, width and height inside a view of `VIEW` size. */
export interface Box { x: number; y: number; w: number; h: number }

export type Orientation = 'landscape' | 'portrait';

/** Reference viewport per orientation; positions are scaled to the real viewport by percentage, sizes stay in pixels. */
export const VIEW: Record<Orientation, { w: number; h: number }> = { landscape: { w: 844, h: 390 }, portrait: { w: 390, h: 844 } };

export interface TouchButton {
  id: string;
  label: string;
  bit: number;
  shape: 'circle' | 'shoulder-left' | 'shoulder-right';
  landscape: Box;
  portrait: Box;
}

const circle = (cx: number, cy: number, r: number): Box => ({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });

/** Outline buttons laid out like a classic N64 emulator: L over Z at the left, R at the right, Start at the top (left of centre in landscape, clear of the HUD button icons), the C diamond at the right middle, B and A on a diagonal at the bottom right. */
export const TOUCH_BUTTONS: readonly TouchButton[] = [
  { id: 'l', label: 'L', bit: Button.L, shape: 'shoulder-left', landscape: { x: 14, y: 14, w: 136, h: 38 }, portrait: { x: 14, y: 310, w: 116, h: 34 } },
  { id: 'z', label: 'Z', bit: Button.Z, shape: 'shoulder-left', landscape: { x: 14, y: 64, w: 136, h: 38 }, portrait: { x: 14, y: 354, w: 116, h: 34 } },
  { id: 'r', label: 'R', bit: Button.R, shape: 'shoulder-right', landscape: { x: 694, y: 14, w: 136, h: 38 }, portrait: { x: 260, y: 310, w: 116, h: 34 } },
  { id: 'start', label: 'Start', bit: Button.Start, shape: 'circle', landscape: circle(395, 30, 18), portrait: circle(195, 327, 18) },
  { id: 'cup', label: '▲', bit: Button.CUp, shape: 'circle', landscape: circle(760, 128, 22), portrait: circle(318, 454, 23) },
  { id: 'cleft', label: '◀', bit: Button.CLeft, shape: 'circle', landscape: circle(716, 172, 22), portrait: circle(272, 500, 23) },
  { id: 'cright', label: '▶', bit: Button.CRight, shape: 'circle', landscape: circle(804, 172, 22), portrait: circle(364, 500, 23) },
  { id: 'cdown', label: '▼', bit: Button.CDown, shape: 'circle', landscape: circle(760, 216, 22), portrait: circle(318, 546, 23) },
  { id: 'b', label: 'B', bit: Button.B, shape: 'circle', landscape: circle(718, 300, 30), portrait: circle(262, 672, 32) },
  { id: 'a', label: 'A', bit: Button.A, shape: 'circle', landscape: circle(788, 346, 32), portrait: circle(334, 734, 36) },
];

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

    this.buildStick();
    this.buildButtons();
    toggle?.addEventListener('click', () => {
      this.toggleHidden();
      toggle.textContent = this.hidden ? 'Show controls' : 'Hide controls';
    });
    addEventListener('blur', () => this.pad.reset());
    layer.addEventListener('pointerup', enterLandscapeFullscreen, { once: true });
  }

  /** Shows the controls when hidden and hides them when shown; returns whether they are hidden now. */
  toggleHidden(): boolean {
    this.hidden = !this.hidden;
    document.documentElement.classList.toggle('touch-hidden', this.hidden);
    this.pad.reset();
    this.drawStick();
    return this.hidden;
  }

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
    const els: Array<[TouchButton, HTMLElement]> = [];
    for (const b of TOUCH_BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      el.id = `touch-${b.id}`;
      el.className = `touch-button ${b.shape}`;
      el.textContent = b.label;
      el.dataset.bit = String(b.bit);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.pad.buttonDown(e.pointerId, b.bit);
        el.classList.add('down');
      });
      const end = (e: PointerEvent) => {
        this.pad.up(e.pointerId);
        el.classList.remove('down');
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      cluster.append(el);
      els.push([b, el]);
    }
    const portrait = matchMedia('(orientation: portrait)');
    const place = () => {
      const o: Orientation = portrait.matches ? 'portrait' : 'landscape';
      const v = VIEW[o];
      for (const [b, el] of els) {
        const r = b[o];
        Object.assign(el.style, { left: `${(r.x / v.w) * 100}%`, top: `${(r.y / v.h) * 100}%`, width: `${r.w}px`, height: `${r.h}px` });
      }
    };
    place();
    portrait.addEventListener('change', place);
    this.layer.append(cluster);
  }
}
