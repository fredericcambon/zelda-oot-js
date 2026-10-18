// Serves the local texture packs (`out/texpack/<variant>/`) at `/texpack/<variant>/` to this machine only: the textures are derived from the
// cartridge and are never published. Only `index.json` and `<16 hex digits>.png` in a variant folder are mapped to a path.
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { LOOPBACK } from '../../web/saves-endpoint.ts';

export const PACK_ROUTE = '/texpack/';
const NAME = /^[a-z0-9-]+\/(index\.json|[0-9a-f]{16}\.png)$/;

export function serveTexPack(dir: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = (req.url ?? '').split('?')[0]!;
    if (!url.startsWith(PACK_ROUTE)) return next();
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      res.statusCode = 403;
      res.end('the texture pack is served to this machine only');
      return;
    }
    const name = url.slice(PACK_ROUTE.length);
    const file = join(dir, name);
    // 404 here: left to Vite, a missing file would be answered with the page itself.
    const stat = NAME.test(name) ? statSync(file, { throwIfNoEntry: false }) : undefined;
    if (!stat?.isFile()) {
      res.statusCode = 404;
      res.end('no such texture');
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(readFileSync(file));
  };
}
