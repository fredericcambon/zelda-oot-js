import { describe, expect, it } from 'vitest';
import { Button, connectNotice, GamepadTracker, mergePads, padFromGamepad, padFromKeys, STICK_MAX, type PadInfo, type PadSnapshot } from './input.ts';

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

describe('GamepadTracker', () => {
  const info = (index: number, mapping = 'standard', connected = true): PadInfo => ({ ...pad(), index, id: `pad ${index}`, mapping, connected });

  it('announces a connection and a disconnection', () => {
    const notes: string[] = [];
    const t = new GamepadTracker((n) => notes.push(n));
    t.connected(info(1));
    t.disconnected(1);
    expect(notes).toEqual(['Controller connected: pad 1', 'Controller disconnected']);
  });
  it('says so when the mapping is not standard', () => {
    expect(connectNotice({ id: 'x', mapping: '' })).toContain('non-standard mapping');
  });
  it('prefers the pad of the last connect event, and still reads a non-standard one', () => {
    const t = new GamepadTracker();
    const list = [info(0), null, info(2, '')];
    t.connected(list[2]!);
    expect(t.pick(list)?.index).toBe(2);
  });
  it('falls back to a standard pad, then any pad, and to none', () => {
    const t = new GamepadTracker();
    expect(t.pick([info(0, ''), info(1)])?.index).toBe(1);
    expect(t.pick([info(0, '')])?.index).toBe(0);
    expect(t.pick([info(0, 'standard', false), null])).toBeNull();
  });
  it('drops the active pad when it goes away', () => {
    const t = new GamepadTracker();
    t.connected(info(3));
    t.disconnected(3);
    expect(t.pick([info(0)])?.index).toBe(0);
  });
});
