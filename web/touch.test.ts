import { describe, expect, it } from 'vitest';
import { Button, STICK_MAX } from './input.ts';
import { HELD_GROW_PX, normalizeLook, pickButton, STICK_RADIUS_PX, stickFromOffset, TOUCH_BUTTONS, TouchPad } from './touch.ts';

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
  it('makes A the largest button and Start small, alone at the top centre', () => {
    const a = TOUCH_BUTTONS.find((b) => b.id === 'a')!;
    for (const b of TOUCH_BUTTONS) if (b !== a) expect(b.size).toBeLessThan(a.size);
    const start = TOUCH_BUTTONS.find((b) => b.id === 'start')!;
    expect(start.top).toBe(true);
    expect(TOUCH_BUTTONS.filter((b) => b.top)).toHaveLength(1);
    expect(TOUCH_BUTTONS.find((b) => b.id === 'z')!.left).toBe(true);
    const z = TOUCH_BUTTONS.find((b) => b.id === 'z')!;
    const r = TOUCH_BUTTONS.find((b) => b.id === 'r')!;
    expect(Math.min(z.size, r.size)).toBeGreaterThan(start.size);
  });
  it('lays the C buttons out as a diamond', () => {
    const c = (id: string) => { const b = TOUCH_BUTTONS.find((t) => t.id === id)!; return { x: b.x + b.size / 2, y: b.y + b.size / 2 }; };
    expect(c('cup').x).toBe(c('cdown').x);
    expect(c('cleft').y).toBe(c('cright').y);
    expect(c('cup').y).toBeLessThan(c('cleft').y);
    expect(c('cleft').y).toBeLessThan(c('cdown').y);
    expect(c('cleft').x).toBeLessThan(c('cup').x);
    expect(c('cup').x).toBeLessThan(c('cright').x);
  });
  it('has distinct bits and non-overlapping boxes', () => {
    for (const [i, a] of TOUCH_BUTTONS.entries()) {
      for (const b of TOUCH_BUTTONS.slice(i + 1)) {
        expect(a.bit).not.toBe(b.bit);
        if (a.top || b.top || a.left || b.left) continue;
        const apart = a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y;
        expect(apart, `${a.id} vs ${b.id}`).toBe(true);
      }
    }
  });
});

describe('pickButton', () => {
  const boxes = [
    { id: 'a', left: 130, top: 100, right: 200, bottom: 170 },
    { id: 'b', left: 30, top: 110, right: 90, bottom: 170 },
  ];
  it('finds the button under the point, or none', () => {
    expect(pickButton(boxes, 160, 130, null)).toBe('a');
    expect(pickButton(boxes, 60, 130, null)).toBe('b');
    expect(pickButton(boxes, 95, 130, null)).toBeNull();
  });
  it('slides from B to A when the finger crosses into A', () => {
    expect(pickButton(boxes, 60, 130, 'b')).toBe('b');
    expect(pickButton(boxes, 160, 130, 'b')).toBe('a');
  });
  it('grows the held button a little, only for the held one', () => {
    expect(pickButton(boxes, 95, 130, 'b')).toBe('b');
    expect(pickButton(boxes, 90 + HELD_GROW_PX + 1, 130, 'b')).toBeNull();
    expect(pickButton(boxes, 120, 130, 'a')).toBe('a');
    expect(pickButton(boxes, 120, 130, 'b')).toBeNull();
  });
});

describe('normalizeLook', () => {
  it('defaults to half opacity at normal size', () => {
    expect(normalizeLook(null)).toEqual({ opacity: 50, size: 100 });
  });
  it('keeps valid values and clamps the rest', () => {
    expect(normalizeLook({ opacity: 80, size: 120 })).toEqual({ opacity: 80, size: 120 });
    expect(normalizeLook({ opacity: 0, size: 500 })).toEqual({ opacity: 10, size: 140 });
    expect(normalizeLook({ opacity: Number.NaN })).toEqual({ opacity: 50, size: 100 });
  });
});
