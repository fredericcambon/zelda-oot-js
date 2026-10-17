import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packImage } from '../tools/assets/pack.ts';
import { serveGameFiles } from './game-files.ts';
import { loadCartridge } from './cartridge.ts';

let dist: string;
let server: Server;
let base: string;
const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, base), { headers });

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'oot-dist-'));
  mkdirSync(dist, { recursive: true });
  const handler = serveGameFiles(dist);
  server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end('next'); }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dist, { recursive: true, force: true });
});

const image = (fill: number) => new Uint8Array(4096).fill(fill);

describe('game files', () => {
  it('answers 404 for what is not built', async () => {
    expect((await get('/game.pack')).status).toBe(404);
    expect((await get('/oot.wasm')).status).toBe(404);
  });

  it('serves the pack with a content validator, and answers 304 to a browser that has it', async () => {
    writeFileSync(join(dist, 'game.pack'), await packImage(image(1)));
    const first = await get('/game.pack');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-length')).toBe(String(64 + 4096));
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    await first.arrayBuffer();
    const again = await get('/game.pack', { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('never answers 304 for a rebuilt pack', async () => {
    const old = (await get('/game.pack')).headers.get('etag')!;
    writeFileSync(join(dist, 'game.pack'), await packImage(image(2)));
    const fresh = await get('/game.pack', { 'If-None-Match': old });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('etag')).not.toBe(old);
    expect(new Uint8Array(await fresh.arrayBuffer())[64]).toBe(2);
  });

  it('never answers 304 for a rebuilt wasm, even of the same size', async () => {
    const file = join(dist, 'oot.wasm');
    writeFileSync(file, new Uint8Array(100).fill(1));
    const old = (await get('/oot.wasm')).headers.get('etag')!;
    expect((await get('/oot.wasm', { 'If-None-Match': old })).status).toBe(304);
    writeFileSync(file, new Uint8Array(100).fill(2));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const fresh = await get('/oot.wasm', { 'If-None-Match': old });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('content-type')).toBe('application/wasm');
  });

  it('lets the page load the cartridge from the pack, and reports a missing or damaged one', async () => {
    const page = (url: string) => loadCartridge(() => {}, new URL(url, base).href);
    expect(Buffer.from(await page('/game.pack')).equals(Buffer.from(image(2)))).toBe(true);
    rmSync(join(dist, 'game.pack'));
    await expect(page('/game.pack')).rejects.toThrow('The game files are missing: run `npm run port -- --rom <path>` first');
    const damaged = await packImage(image(3));
    damaged[100]! ^= 1;
    writeFileSync(join(dist, 'game.pack'), damaged);
    await expect(page('/game.pack')).rejects.toThrow(/does not match its hash/);
  });

  it('reports a body longer than its Content-Length as a broken game file', async () => {
    const url = new URL('/game.pack', base).href;
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array(100), { headers: { 'content-length': '10' } });
    try {
      await expect(loadCartridge(() => {}, url)).rejects.toThrow(/longer than its 10 bytes.*npm run port/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
