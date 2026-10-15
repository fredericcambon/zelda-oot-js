import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const dist = resolve(import.meta.dirname, 'dist');
const GAME_FILES: Record<string, string> = { '/oot.js': 'text/javascript', '/oot.wasm': 'application/wasm' };

// The recompiled game and the pieces of the cartridge image (`npm run port`) live in dist/ next to the web build, so the
// dev server serves them from there and the build copies them beside the page.
function gameFiles(): Plugin {
  return {
    name: 'oot-game-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]!);
        const file = join(dist, url);
        const type = GAME_FILES[url] ?? (url.startsWith('/rom/') && !url.includes('..') ? 'application/octet-stream' : undefined);
        if (!type) return next();
        // Answer 404 here: left to Vite, a missing file would be served as the page itself.
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('not built: run npm run port -- --rom <path>');
          return;
        }
        res.setHeader('Content-Type', url.endsWith('.json') ? 'application/json' : type);
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      mkdirSync(join(dist, 'web'), { recursive: true });
      for (const name of Object.keys(GAME_FILES)) {
        if (existsSync(join(dist, name))) copyFileSync(join(dist, name), join(dist, 'web', name));
      }
      if (existsSync(join(dist, 'rom'))) cpSync(join(dist, 'rom'), join(dist, 'web', 'rom'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  plugins: [gameFiles()],
});
