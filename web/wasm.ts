// The game's wasm module, fetched once: compiled while it downloads.
import { mark } from './timing.ts';

export const MODULE_URL = '/oot.js';

/** Starts loading the module's script so it is ready when the game starts. */
export function preloadModule(url: string = MODULE_URL): void {
  import(/* @vite-ignore */ url).catch(() => {});
}

export interface WasmBuild {
  module: Promise<WebAssembly.Module>;
}

export function fetchWasm(url = '/oot.wasm'): WasmBuild {
  const response = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`could not load ${url} (${r.status}): run \`npm run port -- --rom <path>\` first`);
    return r;
  });
  const module = response.then((r) => WebAssembly.compileStreaming(r.clone())).then((m) => (mark('compiled'), m));
  return { module };
}
