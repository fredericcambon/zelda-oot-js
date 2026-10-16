import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { LOOPBACK, savesDir, savesMiddleware } from './web/saves-endpoint.ts';

const dist = resolve(import.meta.dirname, 'dist');
const GAME_FILES: Record<string, string> = { '/oot.js': 'text/javascript', '/oot.wasm': 'application/wasm' };

// The recompiled game and the assets cut from the cartridge (`npm run port`) live in dist/ next to the web build. The dev
// server serves them from there (the assets to loopback only); the build copies the game, never the assets.
const DATA_PREFIX = '/game-data/';

function serveGameFiles(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = decodeURIComponent((req.url ?? '').split('?')[0]!);
  const isData = url.startsWith(DATA_PREFIX);
  if (url.includes('..')) return next();
  const file = isData ? join(dist, 'assets', url.slice(DATA_PREFIX.length)) : join(dist, url);
  const type = GAME_FILES[url] ?? (isData ? 'application/octet-stream' : undefined);
  if (!type) return next();
  // The cartridge assets are for this machine only: refuse them to any other host (`--host`).
  if (isData && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    res.statusCode = 403;
    res.end('the game files are served to this machine only');
    return;
  }
  // Answer 404 here: left to Vite, a missing file would be served as the page itself.
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('not built: run npm run port -- --rom <path>');
    return;
  }
  res.setHeader('Content-Type', url.endsWith('.json') ? 'application/json' : type);
  createReadStream(file).pipe(res);
}

function gameFiles(): Plugin {
  return {
    name: 'oot-game-files',
    configureServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles);
    },
    configurePreviewServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles);
    },
    closeBundle() {
      mkdirSync(join(dist, 'web'), { recursive: true });
      for (const name of Object.keys(GAME_FILES)) {
        if (existsSync(join(dist, name))) copyFileSync(join(dist, name), join(dist, 'web', name));
      }
    },
  };
}

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, assetsDir: 'bundle' },
  plugins: [gameFiles()],
});
