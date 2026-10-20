import { describe, expect, it } from 'vitest';
import { Button, STICK_MAX } from './input.ts';
import { STICK_RADIUS_PX, stickFromOffset, TOUCH_BUTTONS, TouchPad } from './touch.ts';

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
  it('covers A, B, Z, R, Start and the four C buttons, each at least 48 px', () => {
    const bits = TOUCH_BUTTONS.reduce((m, b) => m | b.bit, 0);
    const need = Button.A | Button.B | Button.Z | Button.R | Button.Start | Button.CUp | Button.CDown | Button.CLeft | Button.CRight;
    expect(bits & need).toBe(need);
    for (const b of TOUCH_BUTTONS) expect(b.size).toBeGreaterThanOrEqual(48);
  });
  it('puts L left of R, each with its own bit', () => {
    const l = TOUCH_BUTTONS.find((b) => b.id === 'l')!;
    const r = TOUCH_BUTTONS.find((b) => b.id === 'r')!;
    expect(l.bit).toBe(Button.L);
    expect(r.bit).toBe(Button.R);
    expect(l.x + l.size).toBeLessThanOrEqual(r.x);
  });
  it('has distinct bits and non-overlapping boxes', () => {
    for (const [i, a] of TOUCH_BUTTONS.entries()) {
      for (const b of TOUCH_BUTTONS.slice(i + 1)) {
        expect(a.bit).not.toBe(b.bit);
        const apart = a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });
});
