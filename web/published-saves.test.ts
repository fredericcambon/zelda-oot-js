import { describe, expect, it } from 'vitest';
import { withPublishedSram, withPublishedStates } from './published-saves.ts';
import type { StateStore } from './savestate.ts';

const files: Record<string, Uint8Array> = { '/b/saves/sram.bin': new Uint8Array([7]), '/b/saves/state-1.bin': new Uint8Array([9]) };
const fetcher = (async (url: string) => (url in files ? new Response(files[url] as BodyInit) : new Response('', { status: 404 }))) as unknown as typeof fetch;
const published = { sram: true, states: { 1: { format: 1, savedAt: 5, hz: 60 as const } } };

describe('published saves', () => {
  it('serves the published sram only while the browser has none', async () => {
    const local = { load: async () => null, store: async () => {} };
    expect([...(await withPublishedSram(local, published, '/b/', fetcher).load())!]).toEqual([7]);
    const own = { load: async () => new Uint8Array([1]), store: async () => {} };
    expect([...(await withPublishedSram(own, published, '/b/', fetcher).load())!]).toEqual([1]);
  });
  it('serves the published state of a slot the browser lacks', async () => {
    const local: StateStore = { get: async () => null, put: async () => {} };
    const store = withPublishedStates(local, published, '/b/', fetcher);
    expect(await store.get(1)).toEqual({ format: 1, savedAt: 5, hz: 60, data: new Uint8Array([9]) });
    expect(await store.get(2)).toBeNull();
  });
});
