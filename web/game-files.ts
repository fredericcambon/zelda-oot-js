// Serves what `npm run port` built in dist/: the game module and the pack (the cartridge image, for this machine only).
// Every answer carries an ETag derived from the content and `no-cache`, so the browser keeps its copy but asks before
// using it: a rebuilt file has a new ETag and is downloaded, an unchanged one costs a 304.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { PACK_FILE, PACK_HEADER_SIZE, readPackHeader } from '../tools/assets/pack.ts';
import { LOOPBACK } from './saves-endpoint.ts';

const TYPES: Record<string, string> = { '/oot.js': 'text/javascript', '/oot.wasm': 'application/wasm', [`/${PACK_FILE}`]: 'application/octet-stream' };
const LOCAL_ONLY = `/${PACK_FILE}`;

/** The recompiled game: built into dist/web beside the page, unlike the pack. */
export const MODULE_URLS = ['/oot.js', '/oot.wasm'];

const hashes = new Map<string, { stamp: string; etag: string }>();

/** The validator for a built file: the pack names its image hash in its header, any other file is hashed once per version. */
function etagOf(file: string, name: string, size: number, mtimeMs: number): string {
  if (name === LOCAL_ONLY) {
    const head = Buffer.alloc(PACK_HEADER_SIZE);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, head, 0, PACK_HEADER_SIZE, 0);
    } finally {
      closeSync(fd);
    }
    return `"${readPackHeader(head).sha256}"`;
  }
  const stamp = `${size}:${mtimeMs}`;
  const known = hashes.get(file);
  if (known?.stamp === stamp) return known.etag;
  const etag = `"${createHash('sha256').update(readFileSync(file)).digest('hex')}"`;
  hashes.set(file, { stamp, etag });
  return etag;
}

const matches = (header: string | undefined, etag: string) => header !== undefined && (header.trim() === '*' || header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag));

export function serveGameFiles(dist: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]!);
    const type = TYPES[url];
    if (!type) return next();
    // The pack is for this machine only: refuse it to any other host (`--host`).
    if (url === LOCAL_ONLY && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      res.statusCode = 403;
      res.end('the game files are served to this machine only');
      return;
    }
    const file = join(dist, url);
    // Answer 404 here: left to Vite, a missing file would be served as the page itself.
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      res.statusCode = 404;
      res.end('not built: run npm run port -- --rom <path>');
      return;
    }
    let etag: string;
    try {
      etag = etagOf(file, url, stat.size, stat.mtimeMs);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (matches(req.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', stat.size);
    createReadStream(file).pipe(res);
  };
}
