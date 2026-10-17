import { describe, expect, it } from 'vitest';
import { migrateToServer, type Stores } from './migrate.ts';
import { OLD_FORMAT, type StateRecord } from './savestate.ts';

function stores(sram: Uint8Array | null = null, states: Record<number, StateRecord> = {}) {
  let value = sram;
  const records = new Map<number, StateRecord>(Object.entries(states).map(([k, v]) => [Number(k), v]));
  const s: Stores & { sramValue(): Uint8Array | null; records: Map<number, StateRecord> } = {
    sramValue: () => value,
    records,
    sram: { load: async () => value, store: async (b: Uint8Array) => void (value = b) },
    states: { get: async (n: number) => records.get(n) ?? null, put: async (n: number, r: StateRecord) => void records.set(n, r) },
  };
  return s;
}

const rec = (n: number): StateRecord => ({ format: 1, savedAt: n, data: new Uint8Array([n]) });

describe('migrateToServer', () => {
  it('uploads what the server lacks and leaves the local copy', async () => {
    const local = stores(new Uint8Array([1]), { 1: rec(1), 3: rec(3) });
    const server = stores();
    expect(await migrateToServer(local, server)).toEqual(['sram', 'slot 1', 'slot 3']);
    expect(server.sramValue()).toEqual(new Uint8Array([1]));
    expect(server.records.get(3)).toEqual(rec(3));
    expect(local.sramValue()).toEqual(new Uint8Array([1]));
    expect(local.records.size).toBe(2);
  });

  it('carries a state of the old format over as it is', async () => {
    const old: StateRecord = { format: OLD_FORMAT, savedAt: 5, data: new Uint8Array([5]) };
    const server = stores();
    expect(await migrateToServer(stores(null, { 1: old }), server)).toEqual(['slot 1']);
    expect(server.records.get(1)).toEqual(old);
  });

  it('never overwrites what the server has', async () => {
    const local = stores(new Uint8Array([1]), { 1: rec(1) });
    const server = stores(new Uint8Array([9]), { 1: rec(9) });
    expect(await migrateToServer(local, server)).toEqual([]);
    expect(server.sramValue()).toEqual(new Uint8Array([9]));
    expect(server.records.get(1)).toEqual(rec(9));
  });

  it('does nothing when there is nothing local, and carries on after a failure', async () => {
    expect(await migrateToServer(stores(), stores())).toEqual([]);
    const server = stores();
    server.sram.store = async () => { throw new Error('disk full'); };
    const failures: string[] = [];
    const moved = await migrateToServer(stores(new Uint8Array([1]), { 2: rec(2) }), server, (what) => failures.push(what));
    expect(failures).toEqual(['sram']);
    expect(moved).toEqual(['slot 2']);
  });
});
