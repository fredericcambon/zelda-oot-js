import { describe, expect, it } from 'vitest';
import { FastForward } from './fastforward.ts';

const key = (k: string) => ({ key: k, prevented: false, preventDefault() { this.prevented = true; } });

describe('FastForward', () => {
  it('is on while Tab is held and suppresses Tab\'s own action', () => {
    const f = new FastForward();
    const down = key('Tab');
    expect(f.keydown(down)).toBe(true);
    expect(down.prevented).toBe(true);
    expect(f.active).toBe(true);
    const up = key('Tab');
    expect(f.keyup(up)).toBe(true);
    expect(up.prevented).toBe(true);
    expect(f.active).toBe(false);
  });

  it('ignores other keys', () => {
    const f = new FastForward();
    const other = key('a');
    expect(f.keydown(other)).toBe(false);
    expect(other.prevented).toBe(false);
    expect(f.active).toBe(false);
  });

  it('stops when the page loses focus', () => {
    const f = new FastForward();
    f.keydown(key('Tab'));
    f.reset();
    expect(f.active).toBe(false);
  });
});
