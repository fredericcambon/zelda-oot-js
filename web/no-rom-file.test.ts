import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The page gets the game's data only from the files `npm run port` wrote beside the wasm; it must never ask the user
// for a ROM file or name one in a request.
const sources = readdirSync(__dirname)
  .filter((f) => /\.(ts|html)$/.test(f) && !f.endsWith('.test.ts'))
  .map((f) => ({ name: f, text: readFileSync(join(__dirname, f), 'utf8') }));

describe('web shell', () => {
  it('has sources to check', () => {
    expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(['main.ts', 'cartridge.ts', 'index.html']));
  });

  it.each([
    ['a ROM file name or extension', /\.(z64|n64|v64)\b/i],
    ['a file input', /type\s*=\s*["']?file/i],
    ['the file-reading APIs', /FileReader|showOpenFilePicker|\bFile\b|\.files\b|dataTransfer/],
  ])('never uses %s', (_what, pattern) => {
    for (const s of sources) expect(s.text, s.name).not.toMatch(pattern);
  });

  it('requests only the game files under /game-data/, /oot.js, the module it loads and its wasm', () => {
    const fetched = sources.flatMap((s) => [...s.text.matchAll(/fetch\(\s*([^)]*)\)/g)].map((m) => m[1]!));
    for (const arg of fetched) expect(arg).toMatch(/base|index\.json|wasmUrl/);
  });
});
