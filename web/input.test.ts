import { describe, expect, it } from 'vitest';
import { Button, mergePads, padFromGamepad, padFromKeys, STICK_MAX, type PadSnapshot } from './input.ts';

const pad = (pressed: number[] = [], axes: number[] = [0, 0, 0, 0]): PadSnapshot => ({
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
  axes,
});

describe('keyboard', () => {
  it('is neutral with no key held', () => {
    expect(padFromKeys(new Set())).toEqual({ buttons: 0, x: 0, y: 0 });
  });
  it('maps Enter to Start and X to A, ignoring unmapped keys', () => {
    expect(padFromKeys(new Set(['Enter', 'KeyX', 'KeyP'])).buttons).toBe(Button.Start | Button.A);
  });
  it('maps the arrows to the stick, up positive, and cancels opposite arrows', () => {
    expect(padFromKeys(new Set(['ArrowUp', 'ArrowRight']))).toEqual({ buttons: 0, x: STICK_MAX, y: STICK_MAX });
    expect(padFromKeys(new Set(['ArrowLeft', 'ArrowRight'])).x).toBe(0);
    expect(padFromKeys(new Set(['ArrowDown'])).y).toBe(-STICK_MAX);
  });
  it('uses the OSContPad bits', () => {
    expect(Button.A).toBe(0x8000);
    expect(Button.Start).toBe(0x1000);
    expect(Button.CRight).toBe(1);
  });
});

describe('gamepad', () => {
  it('maps the face buttons, start and the bumpers', () => {
    expect(padFromGamepad(pad([0, 2, 9, 4, 5])).buttons).toBe(Button.A | Button.B | Button.Start | Button.L | Button.R);
  });
  it('maps either trigger to Z and the d-pad to the d-pad', () => {
    expect(padFromGamepad(pad([6])).buttons).toBe(Button.Z);
    expect(padFromGamepad(pad([7])).buttons).toBe(Button.Z);
    expect(padFromGamepad(pad([12, 15])).buttons).toBe(Button.DUp | Button.DRight);
  });
  it('ignores the dead zone and flips the vertical axis', () => {
    expect(padFromGamepad(pad([], [0.1, -0.15, 0, 0]))).toEqual({ buttons: 0, x: 0, y: 0 });
    const full = padFromGamepad(pad([], [1, -1, 0, 0]));
    expect(full.x).toBe(STICK_MAX);
    expect(full.y).toBe(STICK_MAX);
  });
  it('scales between the dead zone and full deflection', () => {
    const half = padFromGamepad(pad([], [0.6, 0, 0, 0])).x;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(STICK_MAX);
  });
  it('turns the right stick into C buttons', () => {
    expect(padFromGamepad(pad([], [0, 0, -1, 0])).buttons).toBe(Button.CLeft);
    expect(padFromGamepad(pad([], [0, 0, 0, -1])).buttons).toBe(Button.CUp);
    expect(padFromGamepad(pad([], [0, 0, 0.3, 0.3])).buttons).toBe(0);
  });
  it('tolerates a pad with fewer buttons and axes', () => {
    expect(padFromGamepad({ buttons: [], axes: [] })).toEqual({ buttons: 0, x: 0, y: 0 });
  });
});

describe('merge', () => {
  it('ORs buttons and keeps the larger stick deflection', () => {
    const m = mergePads({ buttons: Button.A, x: 10, y: -80 }, { buttons: Button.B, x: -40, y: 5 });
    expect(m).toEqual({ buttons: Button.A | Button.B, x: -40, y: -80 });
  });
});
