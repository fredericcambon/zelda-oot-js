import { describe, expect, it } from 'vitest';
import { ACTOR_FIELDS } from '../../tools/headless/actors.ts';
import { guestRam } from '../../tools/headless/load-save.ts';
import { CTX_ACTOR_LISTS, SCENE_RECORD_SIZE, SCENE_TABLE } from '../../tools/headless/state.ts';
import { Bridge } from './bridge.ts';
import { goToActor, readSnapshot } from './actors.ts';
import { Refused } from './queue.ts';

const CONTEXT = 0x80300000;
const float = (n: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, n); return v.getUint32(0); };

function world(link = true) {
  const bytes = new Uint8Array(0x800000);
  const mem = guestRam(bytes);
  mem.write32(0x80112be0, CONTEXT);
  mem.write32(CONTEXT + 0xa4, 0x55 << 16);
  mem.write32(CONTEXT + 0x1242c, SCENE_TABLE + 0x55 * SCENE_RECORD_SIZE);
  const put = (addr: number, id: number, category: number, x: number, y: number, z: number, next: number) => {
    mem.write32(addr, (id << 16 | category << 8 | 0xff) >>> 0);
    mem.write32(addr + 0x24, float(x));
    mem.write32(addr + 0x28, float(y));
    mem.write32(addr + 0x2c, float(z));
    mem.write32(addr + ACTOR_FIELDS.next, next);
  };
  const list = (category: number, count: number, head: number) => {
    mem.write32(CONTEXT + CTX_ACTOR_LISTS + category * 8, count);
    mem.write32(CONTEXT + CTX_ACTOR_LISTS + category * 8 + 4, head);
  };
  if (link) {
    put(0x80200000, 0, 2, 0, 0, 0, 0);
    list(2, 1, 0x80200000);
  }
  put(0x80201000, 0x25, 6, 300, 0, 400, 0x80201200);
  put(0x80201200, 0x11, 6, 30, 0, 40, 0);
  list(6, 2, 0x80201000);
  return { mem, bridge: new Bridge(() => bytes, () => undefined) };
}

describe('actor snapshot', () => {
  it('groups by category, nearest to Link first', () => {
    const snap = readSnapshot(world().mem, undefined);
    expect(snap.count).toBe(3);
    expect(snap.groups.map((g) => g.category)).toEqual([2, 6]);
    expect(snap.groups[1]!.rows.map((r) => [r.id, r.distance])).toEqual([[0x11, 50], [0x25, 500]]);
  });

  it('has no distances without Link', () => {
    const snap = readSnapshot(world(false).mem, undefined);
    expect(snap.link).toBeNull();
    expect(snap.groups[0]!.rows.every((r) => r.distance === null)).toBe(true);
  });

  it('is empty while no scene is loaded', () => {
    expect(readSnapshot(guestRam(new Uint8Array(0x800000)), 'x')).toMatchObject({ scene: null, count: 0, refusal: 'x' });
  });

  it('stops at a loop in a list', () => {
    const { mem } = world();
    mem.write32(0x80201200 + ACTOR_FIELDS.next, 0x80201000);
    expect(readSnapshot(mem, undefined).count).toBe(3);
  });
});

describe('go to', () => {
  it('writes Link next to the actor', () => {
    const { mem, bridge } = world();
    goToActor(bridge, 0x80201200);
    const link = readSnapshot(mem, undefined).link!;
    expect(link).toEqual({ x: 80, y: 0, z: 40 });
  });

  it('refuses Link, a gone actor, and an unsafe state', () => {
    const { bridge } = world();
    expect(() => goToActor(bridge, 0x80200000)).toThrow('That is Link');
    expect(() => goToActor(bridge, 0x80209000)).toThrow(Refused);
    const bytes = new Uint8Array(0x800000);
    expect(() => goToActor(new Bridge(() => bytes), 0x80201000)).toThrow(/Not now/);
  });
});
