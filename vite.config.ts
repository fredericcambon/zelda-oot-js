import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { MODULE_URLS, serveGameFiles } from './web/game-files.ts';
import { savesDir, savesMiddleware } from './web/saves-endpoint.ts';

const dist = resolve(import.meta.dirname, 'dist');

// The recompiled game and the pack cut from the cartridge (`npm run port`) live in dist/ next to the web build. The dev and
// preview servers serve them from there (the pack to loopback only); the build copies the game, never the pack.
function gameFiles(): Plugin {
  return {
    name: 'oot-game-files',
    configureServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles(dist));
    },
    configurePreviewServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles(dist));
    },
    closeBundle() {
      mkdirSync(join(dist, 'web'), { recursive: true });
      for (const name of MODULE_URLS) {
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
