import { describe, expect, it } from 'vitest';
import { Button, STICK_MAX } from './input.ts';
import { STICK_RADIUS_PX, stickFromOffset, TOUCH_BUTTONS, TouchPad, VIEW, type Box } from './touch.ts';

describe('stickFromOffset', () => {
  it('is neutral inside the dead zone', () => {
    expect(stickFromOffset(0, 0)).toEqual({ x: 0, y: 0 });
    expect(stickFromOffset(3, -3)).toEqual({ x: 0, y: 0 });
  });
  it('gives up as positive y and right as positive x', () => {
    expect(stickFromOffset(STICK_RADIUS_PX, 0)).toEqual({ x: STICK_MAX, y: 0 });
    expect(stickFromOffset(0, -STICK_RADIUS_PX)).toEqual({ x: 0, y: STICK_MAX });
    expect(stickFromOffset(-STICK_RADIUS_PX, 0).x).toBe(-STICK_MAX);
    expect(stickFromOffset(0, STICK_RADIUS_PX).y).toBe(-STICK_MAX);
  });
  it('clamps the magnitude to the console range at any distance', () => {
    for (const a of [0, 0.5, 1, 2, 3.5, 5]) {
      const { x, y } = stickFromOffset(Math.cos(a) * 1000, Math.sin(a) * 1000);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(STICK_MAX + 1);
      expect(Math.hypot(x, y)).toBeGreaterThan(STICK_MAX - 1);
    }
  });
  it('keeps the drag angle', () => {
    const { x, y } = stickFromOffset(100, -100);
    expect(Math.atan2(y, x)).toBeCloseTo(Math.PI / 4, 1);
  });
  it('scales linearly past the dead zone', () => {
    const half = stickFromOffset(STICK_RADIUS_PX / 2, 0).x;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(STICK_MAX);
  });
});

describe('TouchPad', () => {
  it('is neutral with no touch', () => {
    expect(new TouchPad().poll()).toEqual({ buttons: 0, x: 0, y: 0 });
  });
  it('measures the stick from the touch-down point and releases it', () => {
    const p = new TouchPad();
    p.stickDown(1, 100, 300);
    p.stickMove(1, 100 + STICK_RADIUS_PX, 300);
    expect(p.poll().x).toBe(STICK_MAX);
    p.up(1);
    expect(p.poll()).toEqual({ buttons: 0, x: 0, y: 0 });
  });
  it('ignores moves of other pointers on the stick', () => {
    const p = new TouchPad();
    p.stickDown(1, 0, 0);
    p.stickMove(2, 500, 0);
    expect(p.poll().x).toBe(0);
  });
  it('moves and presses buttons at the same time, each released on its own', () => {
    const p = new TouchPad();
    p.stickDown(1, 0, 0);
    p.stickMove(1, 0, -STICK_RADIUS_PX);
    p.buttonDown(2, Button.A);
    p.buttonDown(3, Button.CUp);
    expect(p.poll()).toEqual({ buttons: Button.A | Button.CUp, x: 0, y: STICK_MAX });
    p.up(2);
    expect(p.poll().buttons).toBe(Button.CUp);
  });
  it('reset drops everything', () => {
    const p = new TouchPad();
    p.stickDown(1, 0, 0);
    p.stickMove(1, 90, 0);
    p.buttonDown(2, Button.Z);
    p.reset();
    expect(p.poll()).toEqual({ buttons: 0, x: 0, y: 0 });
  });
});

describe('TOUCH_BUTTONS', () => {
  const find = (id: string) => TOUCH_BUTTONS.find((b) => b.id === id)!;
  const cx = (r: Box) => r.x + r.w / 2;
  const cy = (r: Box) => r.y + r.h / 2;

  it('covers A, B, L, Z, R, Start and the four C buttons, each with its own bit', () => {
    const need = Button.A | Button.B | Button.L | Button.Z | Button.R | Button.Start | Button.CUp | Button.CDown | Button.CLeft | Button.CRight;
    expect(TOUCH_BUTTONS.reduce((m, b) => m | b.bit, 0) & need).toBe(need);
    expect(find('l').bit).toBe(Button.L);
    expect(find('r').bit).toBe(Button.R);
    expect(find('z').bit).toBe(Button.Z);
  });
  it('labels the C buttons with arrows', () => {
    expect(['cup', 'cleft', 'cright', 'cdown'].map((id) => find(id).label)).toEqual(['▲', '◀', '▶', '▼']);
  });
  it.each(['landscape', 'portrait'] as const)('puts the controls where the layout wants them in %s', (o) => {
    const [l, z, r, a, b, up, left, right, down] = ['l', 'z', 'r', 'a', 'b', 'cup', 'cleft', 'cright', 'cdown'].map((id) => find(id)[o]);
    const v = VIEW[o];
    expect(l!.x + l!.w).toBeLessThanOrEqual(r!.x);
    expect(l!.y + l!.h).toBeLessThanOrEqual(z!.y);
    expect(z!.x).toBe(l!.x);
    expect(r!.y).toBe(l!.y);
    expect(cx(r!)).toBeGreaterThan(v.w / 2);
    expect(cx(a!)).toBeGreaterThan(cx(b!));
    expect(cy(a!)).toBeGreaterThan(cy(b!));
    for (const c of [up!, left!, right!, down!]) expect(cx(c)).toBeGreaterThan(v.w / 2);
    expect(cy(up!)).toBeLessThan(cy(left!));
    expect(cy(left!)).toBe(cy(right!));
    expect(cx(left!)).toBeLessThan(cx(right!));
    expect(cy(down!)).toBeGreaterThan(cy(left!));
  });
  it.each(['landscape', 'portrait'] as const)('keeps every box inside the view and apart from the others in %s', (o) => {
    const v = VIEW[o];
    for (const [i, a] of TOUCH_BUTTONS.entries()) {
      const ar = a[o];
      expect(ar.x).toBeGreaterThanOrEqual(0);
      expect(ar.y).toBeGreaterThanOrEqual(0);
      expect(ar.x + ar.w).toBeLessThanOrEqual(v.w);
      expect(ar.y + ar.h).toBeLessThanOrEqual(v.h);
      for (const b of TOUCH_BUTTONS.slice(i + 1)) {
        expect(a.bit).not.toBe(b.bit);
        const br = b[o];
        const apart = ar.x + ar.w <= br.x || br.x + br.w <= ar.x || ar.y + ar.h <= br.y || br.y + br.h <= ar.y;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });
});
