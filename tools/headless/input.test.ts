import { describe, expect, it } from 'vitest';
import { padAt, parseInput } from './input.ts';

describe('input script', () => {
  const script = parseInput(`
    # comment
    10 START
    20 A+B 5 -7   # trailing comment
    30 NONE
    tap A 100 200 50 3
  `);

  it('holds each state until the next line', () => {
    expect(padAt(script, 9)).toEqual({ buttons: 0, x: 0, y: 0 });
    expect(padAt(script, 10)).toEqual({ buttons: 0x1000, x: 0, y: 0 });
    expect(padAt(script, 25)).toEqual({ buttons: 0xc000, x: 5, y: -7 });
    expect(padAt(script, 31)).toEqual({ buttons: 0, x: 0, y: 0 });
  });

  it('presses taps for `hold` frames every `every` frames inside the range', () => {
    const pressed = [99, 100, 102, 103, 149, 150, 152, 153, 200].map((f) => padAt(script, f).buttons === 0x8000);
    expect(pressed).toEqual([false, true, true, false, false, true, true, false, false]);
  });

  it('rejects unknown buttons, bad stick values and frames that do not increase', () => {
    expect(() => parseInput('1 JUMP')).toThrow(/unknown button/);
    expect(() => parseInput('1 A 200 0')).toThrow(/stick/);
    expect(() => parseInput('5 A\n5 B')).toThrow(/increase/);
    expect(() => parseInput('1 A 3')).toThrow(/expected/);
  });
});
