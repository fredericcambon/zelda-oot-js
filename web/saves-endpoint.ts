// The dev and preview servers keep the player's saves on disk, in a folder shared by every checkout and build, so a
// save made in one running copy of the page is found by the next. Only this machine may use it.
//
//   GET|PUT /api/saves/sram          the cartridge's save memory
//   GET|PUT /api/saves/state/<1-4>   a save state; the build that took it travels in the X-Build header
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SAVES_PREFIX = '/api/saves/';
export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 512 * 1024 * 1024;
const FILES = /^(sram|state\/[1-4])$/;

export function savesDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OOT_SAVES_DIR || join(homedir(), '.zelda-oot-js', 'saves');
}

function reply(res: ServerResponse, status: number, text = ''): void {
  res.statusCode = status;
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answers requests under SAVES_PREFIX; anything else goes to `next`. */
export function savesMiddleware(dir: string) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = (req.url ?? '').split('?')[0]!;
    if (!url.startsWith(SAVES_PREFIX)) return next();
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return reply(res, 403, 'saves are served to this machine only');
    // Only the names above are ever turned into a path.
    let name: string;
    try {
      name = decodeURIComponent(url.slice(SAVES_PREFIX.length));
    } catch {
      return reply(res, 400, 'bad path');
    }
    if (name === 'ping') return reply(res, 204);
    if (!FILES.test(name)) return reply(res, 400, 'unknown save');
    const file = join(dir, `${name.replace('/', '-')}.bin`);
    const meta = `${file}.build`;
    try {
      if (req.method === 'GET') {
        let data: Buffer;
        try {
          data = readFileSync(file);
        } catch {
          return reply(res, 404);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        if (name !== 'sram') {
          const [build = '', savedAt = '0'] = readFileSync(meta, 'utf8').split('\n');
          res.setHeader('X-Build', build);
          res.setHeader('X-Saved-At', savedAt);
        }
        res.end(data);
      } else if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body) return reply(res, 413);
        mkdirSync(dir, { recursive: true });
        // Written beside and renamed, so a crash never leaves half a save.
        const write = (path: string, data: Buffer | string) => {
          writeFileSync(`${path}.tmp`, data);
          renameSync(`${path}.tmp`, path);
        };
        if (name !== 'sram') {
          const build = String(req.headers['x-build'] ?? '');
          if (!/^[0-9a-f]{64}$/.test(build)) return reply(res, 400, 'bad build id');
          write(meta, `${build}\n${Number(req.headers['x-saved-at']) || Date.now()}`);
        }
        write(file, body);
        reply(res, 204);
      } else {
        reply(res, 405);
      }
    } catch (err) {
      reply(res, 500, err instanceof Error ? err.message : String(err));
    }
  };
}
