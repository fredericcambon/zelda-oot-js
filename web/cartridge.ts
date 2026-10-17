// Loads the cartridge image from the pack `npm run port` wrote next to the game. The page never asks for a ROM file.
import { MISSING_PACK_MESSAGE, PACK_FILE, PACK_HEADER_SIZE, unpackImage } from '../tools/assets/pack.ts';
import { mark } from './timing.ts';

export async function loadCartridge(onProgress: (bytes: number, total: number) => void, url = `${import.meta.env.BASE_URL}${PACK_FILE}`): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(MISSING_PACK_MESSAGE);
  // A compressing host reports the compressed length, which is not the size of the body.
  const total = response.headers.has('content-encoding') ? 0 : Number(response.headers.get('content-length')) || 0;
  // Without a length the body is read in one piece, without progress.
  const pack = total > 0 ? new Uint8Array(total) : new Uint8Array(await response.arrayBuffer());
  if (total > 0) {
    let received = 0;
    const reader = response.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      pack.set(r.value, received);
      // The header, which names the image size and hash, is the first thing in the file.
      if (received < PACK_HEADER_SIZE && received + r.value.length >= PACK_HEADER_SIZE) mark('manifest');
      received += r.value.length;
      onProgress(received, total);
    }
    if (received !== total) throw new Error(`The game file ended after ${received} of ${total} bytes: run \`npm run port -- --rom <path>\` again`);
  }
  const image = await unpackImage(pack);
  mark('cartridge');
  return image;
}
