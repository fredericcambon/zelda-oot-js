import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const dist = resolve(import.meta.dirname, 'dist');
const GAME_FILES: Record<string, string> = { '/oot.js': 'text/javascript', '/oot.wasm': 'application/wasm' };

// The recompiled game (`npm run port`) lives in dist/ next to the web build, so the dev server serves it from there and
// the build copies it beside the page.
function gameFiles(): Plugin {
  return {
    name: 'oot-game-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        const file = join(dist, url);
        const type = GAME_FILES[url];
        if (!type || !existsSync(file)) return next();
        res.setHeader('Content-Type', type);
        createReadStream(file).pipe(res);
      });
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
  build: { outDir: '../dist/web', emptyOutDir: true },
  plugins: [gameFiles()],
});
