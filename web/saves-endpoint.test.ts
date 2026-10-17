import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savesDir, savesMiddleware } from './saves-endpoint.ts';
import { SaveSync, serverHasSaves, serverStore, type SaveMemory } from './saves.ts';
import { OLD_FORMAT, SaveStates, serverStates, type StateSource } from './savestate.ts';

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

  it('keeps a state with its format version and the time it was saved', async () => {
    const put = await page('/api/saves/state/2', { method: 'PUT', headers: { 'X-State-Format': '1', 'X-Saved-At': '1234' }, body: new Uint8Array([9]) });
    expect(put.status).toBe(204);
    const got = await page('/api/saves/state/2');
    expect(got.headers.get('X-State-Format')).toBe('1');
    expect(got.headers.get('X-Saved-At')).toBe('1234');
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([9]);
    expect((await page('/api/saves/state/3', { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(400);
    expect((await page('/api/saves/state/3', { method: 'PUT', headers: { 'X-State-Format': 'x' }, body: new Uint8Array([1]) })).status).toBe(400);
  });

  it('refuses paths that are not a save, and writes nothing outside its folder', async () => {
    for (const path of ['../../x', '..%2F..%2Fx', 'state/..%2Fsram', 'state/5', 'state/1/../../x', 'sram.bin', '%00', '%zz']) {
      for (const method of ['GET', 'PUT']) {
        const r = await page(`/api/saves/${path}`, { method, body: method === 'PUT' ? new Uint8Array([1]) : undefined });
        expect([400, 404], `${method} ${path}`).toContain(r.status);
      }
    }
    expect(readdirSync(dir).sort()).toEqual(['sram.bin', 'state-2.bin', 'state-2.bin.format']);
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

  it('keeps the version check on states', async () => {
    const source = (): StateSource & { value: number } => {
      const s = { value: 0, capture: async () => new Uint8Array([s.value]), apply: async (d: Uint8Array) => void (s.value = d[0]!) };
      return s;
    };
    const old = source();
    old.value = 4;
    await new SaveStates(old, serverStates(page), 1).save();

    const sameVersion = source();
    expect(await new SaveStates(sameVersion, serverStates(page), 1).load()).toBe('Loaded slot 1');
    expect(sameVersion.value).toBe(4);

    const newer = source();
    expect(await new SaveStates(newer, serverStates(page), 2).load()).toContain('uses state format 1, this build reads 2');
    expect(newer.value).toBe(0);
  });

  it('serves a state kept before the portable format as the old format, and leaves its files', async () => {
    writeFileSync(join(dir, 'state-4.bin'), new Uint8Array([6]));
    writeFileSync(join(dir, 'state-4.bin.build'), `${'f'.repeat(64)}
777`);
    const states = serverStates(page);
    const record = await states.get(4);
    expect(record).toMatchObject({ format: OLD_FORMAT, savedAt: 777 });
    expect([...record!.data]).toEqual([6]);

    const game = { value: 0, capture: async () => new Uint8Array(), apply: async () => { throw new Error('must not load'); } };
    const sets = new SaveStates(game, states, 1);
    await sets.select(3);
    expect(sets.slot).toBe(4);
    expect(await sets.load()).toBe('Slot 4 was saved in the old format and cannot be loaded');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['state-4.bin', 'state-4.bin.build']));

    await states.put(4, { format: 1, savedAt: 9, data: new Uint8Array([7]) });
    expect(await states.get(4)).toMatchObject({ format: 1, savedAt: 9 });
    rmSync(join(dir, 'state-4.bin'));
    rmSync(join(dir, 'state-4.bin.build'));
    rmSync(join(dir, 'state-4.bin.format'));
  });
});
