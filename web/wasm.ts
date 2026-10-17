// The game's wasm module, fetched once: compiled while it downloads, and hashed from a second reader of the same response.
import { mark } from './timing.ts';
import { buildIdOf } from './savestate.ts';

export const MODULE_URL = '/oot.js';

/** Starts loading the module's script so it is ready when the game starts. */
export function preloadModule(url: string = MODULE_URL): void {
  import(/* @vite-ignore */ url).catch(() => {});
}

export interface WasmBuild {
  module: Promise<WebAssembly.Module>;
  /** Identifies this build of the game (the hash of its wasm file). */
  buildId: Promise<string>;
}

export function fetchWasm(url = '/oot.wasm'): WasmBuild {
  const response = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`could not load ${url} (${r.status}): run \`npm run port -- --rom <path>\` first`);
    return r;
  });
  const module = response.then((r) => WebAssembly.compileStreaming(r.clone())).then((m) => (mark('compiled'), m));
  const buildId = response.then((r) => r.clone().arrayBuffer()).then(buildIdOf);
  // A failed download is reported through `module`; this one is read later and must not also surface unhandled.
  buildId.catch(() => {});
  return { module, buildId };
}
