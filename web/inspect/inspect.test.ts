import { describe, expect, it } from 'vitest';
import { guestRam } from '../../tools/headless/load-save.ts';
import { ActionQueue, Bridge, FreezeList, Refused } from './index.ts';

const ram = () => new Uint8Array(0x800000);

describe('ActionQueue', () => {
  it('runs actions in order and returns their messages', async () => {
    const q = new ActionQueue();
    const order: number[] = [];
    q.push(() => { order.push(1); return 'one'; });
    q.push(async () => { order.push(2); });
    q.push(async () => { order.push(3); return 'three'; });
    expect(q.pending).toBe(3);
    expect(await q.drain()).toEqual(['one', 'three']);
    expect(order).toEqual([1, 2, 3]);
    expect(q.pending).toBe(0);
  });

  it('shows a refusal as it is and prefixes other errors, and goes on with the rest', async () => {
    const q = new ActionQueue();
    q.push(() => { throw new Refused('Not now: busy'); }, 'Edit failed');
    q.push(() => { throw new Error('boom'); }, 'Edit failed');
    q.push(() => 'done');
    expect(await q.drain()).toEqual(['Not now: busy', 'Edit failed: boom', 'done']);
  });
});

describe('FreezeList', () => {
  it('writes big-endian values and replaces a hold on the same bytes', () => {
    const mem = guestRam(ram());
    const list = new FreezeList();
    list.add(0x80100000, 4, 0x11223344);
    list.add(0x80100010, 2, 0xabcd);
    list.add(0x80100020, 1, 0x7f);
    list.apply(mem);
    expect([mem.rd8(0x80100000), mem.rd8(0x80100001), mem.rd8(0x80100002), mem.rd8(0x80100003)]).toEqual([0x11, 0x22, 0x33, 0x44]);
    expect([mem.rd8(0x80100010), mem.rd8(0x80100011), mem.rd8(0x80100020)]).toEqual([0xab, 0xcd, 0x7f]);
    list.add(0x80100020, 1, 0x01);
    expect(list.list()).toHaveLength(3);
    list.apply(mem);
    expect(mem.rd8(0x80100020)).toBe(0x01);
  });

  it('removes and clears', () => {
    const list = new FreezeList();
    const a = list.add(0x80100000, 1, 1);
    list.add(0x80100001, 1, 2);
    list.remove(a.id);
    expect(list.list().map((f) => f.addr)).toEqual([0x80100001]);
    list.clear();
    expect(list.list()).toEqual([]);
  });
});

describe('Bridge', () => {
  it('refuses changes while no game runs', () => {
    const b = new Bridge(() => null);
    expect(b.ram()).toBeNull();
    expect(b.unsafeReason()).toBe('no game is running');
    expect(() => b.writable()).toThrow(Refused);
  });

  it('uses the shared safe-state check: a memory that is not in a scene is refused', () => {
    const b = new Bridge(ram);
    expect(b.unsafeReason()).toMatch(/not in a scene/);
    expect(() => b.writable()).toThrow(/^Not now: /);
  });

  it('holds values only in a safe state', () => {
    const bytes = ram();
    let safe = false;
    const b = new Bridge(() => bytes, () => (safe ? undefined : 'busy'));
    b.freezes.add(0x80100000, 1, 9);
    b.applyFreezes();
    expect(bytes[0x100000]).toBe(0);
    safe = true;
    b.applyFreezes();
    expect(bytes[0x100000]).toBe(9);
    expect(b.writable()).toBeDefined();
  });
});
