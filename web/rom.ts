// Rebuilds the cartridge image from the pieces `npm run port` wrote next to the game (dist/rom). The page never asks
// for a ROM file: the index says which byte range each piece holds.
interface PieceIndex {
  size: number;
  pieces: { start: number; end: number; path: string }[];
}

const PARALLEL_FETCHES = 8;

export async function loadRomImage(onProgress: (done: number, total: number) => void, base = '/rom/'): Promise<Uint8Array> {
  const response = await fetch(`${base}index.json`);
  if (!response.ok) throw new Error('The game files are missing: run `npm run port -- --rom <path>` first');
  const index = (await response.json()) as PieceIndex;
  const image = new Uint8Array(index.size);
  const queue = [...index.pieces];
  let done = 0;
  onProgress(0, queue.length);
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const r = await fetch(`${base}${p.path}`);
      if (!r.ok) throw new Error(`could not load ${p.path} (${r.status})`);
      image.set(new Uint8Array(await r.arrayBuffer()), p.start);
      onProgress(++done, index.pieces.length);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_FETCHES }, worker));
  return image;
}
