import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savesDir, savesMiddleware } from './saves-endpoint.ts';
import { SaveSync, serverHasSaves, serverStore, type SaveMemory } from './saves.ts';
import { SaveStates, serverStates, type StateSource } from './savestate.ts';

let dir: string;
let server: Server;
let base: string;
/** fetch for the page's relative URLs. */
const page: typeof fetch = (input, init) => fetch(new URL(String(input), base), init);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oot-saves-'));
  const handler = savesMiddleware(dir);
  server = createServer((req, res) => void handler(req, res, () => { res.statusCode = 404; res.end('next'); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const BUILD = 'a'.repeat(64);

describe('saves endpoint', () => {
  it('answers the probe', async () => {
    expect(await serverHasSaves(page)).toBe(true);
  });

  it('is not there for a server without it', async () => {
    expect(await serverHasSaves(async () => new Response('<html>', { status: 200 }))).toBe(false);
    expect(await serverHasSaves(async () => { throw new TypeError('offline'); })).toBe(false);
  });

  it('reads back what it was given, and reports a missing save', async () => {
    expect((await page('/api/saves/sram')).status).toBe(404);
    const put = await page('/api/saves/sram', { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(put.status).toBe(204);
    const got = await page('/api/saves/sram');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('keeps a state with the build and time that took it', async () => {
    const put = await page('/api/saves/state/2', { method: 'PUT', headers: { 'X-Build': BUILD, 'X-Saved-At': '1234' }, body: new Uint8Array([9]) });
    expect(put.status).toBe(204);
    const got = await page('/api/saves/state/2');
    expect(got.headers.get('X-Build')).toBe(BUILD);
    expect(got.headers.get('X-Saved-At')).toBe('1234');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([9]);
    expect((await page('/api/saves/state/3', { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(400);
  });

  it('keeps the video rate of a state, 50 Hz when none is given', async () => {
    await page('/api/saves/state/2', { method: 'PUT', headers: { 'X-Build': BUILD, 'X-Hz': '60' }, body: new Uint8Array([1]) });
    expect((await page('/api/saves/state/2')).headers.get('X-Hz')).toBe('60');
    await page('/api/saves/state/2', { method: 'PUT', headers: { 'X-Build': BUILD }, body: new Uint8Array([1]) });
    expect((await page('/api/saves/state/2')).headers.get('X-Hz')).toBe('50');
  });

  it('refuses paths that are not a save, and writes nothing outside its folder', async () => {
    for (const path of ['../../x', '..%2F..%2Fx', 'state/..%2Fsram', 'state/5', 'state/1/../../x', 'sram.bin', '%00', '%zz']) {
      for (const method of ['GET', 'PUT']) {
        const r = await page(`/api/saves/${path}`, { method, body: method === 'PUT' ? new Uint8Array([1]) : undefined });
        expect([400, 404], `${method} ${path}`).toContain(r.status);
      }
    }
    expect(readdirSync(dir).sort()).toEqual(['sram.bin', 'state-2.bin', 'state-2.bin.build']);
  });

  it('refuses a client that is not on this machine', async () => {
    const handler = savesMiddleware(dir);
    let status = 0;
    let nextCalled = false;
    const res = { setHeader() {}, end() {}, set statusCode(v: number) { status = v; } };
    await handler({ url: '/api/saves/sram', method: 'GET', socket: { remoteAddress: '192.168.1.20' }, headers: {} } as never, res as never, () => { nextCalled = true; });
    expect(status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('leaves other URLs to the next handler', async () => {
    expect(await (await page('/oot.js')).text()).toBe('next');
  });

  it('uses the folder named by the environment, else one under the home folder', () => {
    expect(savesDir({ OOT_SAVES_DIR: 'X:/saves' })).toBe('X:/saves');
    expect(savesDir({}).replaceAll('\\', '/')).toMatch(/[.]zelda-oot-js[/]saves$/);
  });
});

describe('saves through the endpoint', () => {
  function memory(): SaveMemory & { ram: Uint8Array } {
    const m = { ram: new Uint8Array(4), write: (b: Uint8Array) => m.ram.set(b), takeIfDirty: () => m.ram.slice() };
    return m;
  }

  it('carries a save written by one build to another', async () => {
    const writer = memory();
    writer.ram.set([7, 7, 7, 7]);
    await new SaveSync(writer, serverStore(page)).flush();
    const reader = memory();
    expect(await new SaveSync(reader, serverStore(page)).restore()).toBe(true);
    expect([...reader.ram]).toEqual([7, 7, 7, 7]);
  });

  it('keeps the build check on states', async () => {
    const source = (): StateSource & { value: number } => {
      const s = { value: 0, capture: async () => new Uint8Array([s.value]), apply: async (d: Uint8Array) => void (s.value = d[0]!) };
      return s;
    };
    const old = source();
    old.value = 4;
    await new SaveStates(old, serverStates(page), 'b'.repeat(64)).save();

    const sameBuild = source();
    expect(await new SaveStates(sameBuild, serverStates(page), 'b'.repeat(64)).load()).toBe('Loaded slot 1');
    expect(sameBuild.value).toBe(4);

    const other = source();
    expect(await new SaveStates(other, serverStates(page), 'c'.repeat(64)).load()).toContain('another build');
    expect(other.value).toBe(0);
  });

  it('refuses a state saved at the other video rate', async () => {
    const game = { value: 3, capture: async () => new Uint8Array([3]), apply: async () => { throw new Error('must not load'); } };
    await new SaveStates(game, serverStates(page), 'd'.repeat(64), 60).save();
    expect(await new SaveStates(game, serverStates(page), 'd'.repeat(64), 50).load()).toContain('saved in 60 Hz mode');
    const loaded: number[] = [];
    const target = { capture: async () => new Uint8Array(), apply: async (d: Uint8Array) => void loaded.push(d[0]!) };
    expect(await new SaveStates(target, serverStates(page), 'd'.repeat(64), 60).load()).toBe('Loaded slot 1');
    expect(loaded).toEqual([3]);
  });
});
