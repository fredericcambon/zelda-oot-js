// Rebuilds the cartridge image from the asset files `npm run port` wrote next to the game (dist/assets). The page never
// asks for a ROM file: the manifest says which byte range of the image each asset holds.
import type { Manifest } from '../tools/assets/write.ts';

const PARALLEL_FETCHES = 8;

export async function loadCartridge(onProgress: (done: number, total: number) => void, base = '/game-data/'): Promise<Uint8Array> {
  const response = await fetch(`${base}manifest.json`);
  if (!response.ok) throw new Error('The game files are missing: run `npm run port -- --rom <path>` first');
  const manifest = (await response.json()) as Manifest;
  const image = new Uint8Array(manifest.rom.size);
  const queue = [...manifest.entries];
  let done = 0;
  onProgress(0, queue.length);
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const r = await fetch(`${base}${e.path}`);
      if (!r.ok) throw new Error(`could not load ${e.path} (${r.status})`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length !== e.romEnd - e.romStart) throw new Error(`${e.path} has ${bytes.length} bytes, the manifest says ${e.romEnd - e.romStart}`);
      image.set(bytes, e.romStart);
      onProgress(++done, manifest.entries.length);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_FETCHES }, worker));
  return image;
}
