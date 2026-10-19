import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { PACK_FILE } from './tools/assets/pack.ts';
import { MODULE_URLS, serveGameFiles } from './web/game-files.ts';
import { savesDir, savesMiddleware } from './web/saves-endpoint.ts';
import { packDir } from './tools/tex/location.ts';
import { serveTexPack } from './tools/tex/serve.ts';

const dist = resolve(import.meta.dirname, 'dist');
const pagesDir = resolve(import.meta.dirname, 'dist-pages');

// The recompiled game and the pack cut from the cartridge (`npm run port`) live in dist/ next to the web build. The dev and
// preview servers serve them from there (the pack to loopback only); the build copies the game, never the pack. The local texture pack
// (<cache>/tex/<ROM SHA-1>/pack/, or OOT_TEXPACK_DIR; `npm run tex -- upscale`) is served to loopback only by both servers and is in no build.
function gameFiles(pages: boolean): Plugin {
  return {
    name: 'oot-game-files',
    configureServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles(dist));
      server.middlewares.use(serveTexPack(() => packDir(dist)));
    },
    configurePreviewServer(server) {
      server.middlewares.use(savesMiddleware(savesDir()));
      server.middlewares.use(serveGameFiles(dist));
      server.middlewares.use(serveTexPack(() => packDir(dist)));
    },
    closeBundle() {
      const out = pages ? pagesDir : join(dist, 'web');
      mkdirSync(out, { recursive: true });
      // The Pages site is the only build that carries the pack; it must be complete or the page would be dead.
      const names = pages ? [...MODULE_URLS, `/${PACK_FILE}`] : MODULE_URLS;
      for (const name of names) {
        if (existsSync(join(dist, name))) copyFileSync(join(dist, name), join(out, name));
        else if (pages) throw new Error(`dist${name} is missing: run npm run port -- --rom <path> first`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    root: 'web',
    base: pages ? '/zelda-oot-js/' : '/',
    build: { outDir: pages ? pagesDir : '../dist/web', emptyOutDir: true, assetsDir: 'bundle' },
    plugins: [gameFiles(pages)],
  };
});
