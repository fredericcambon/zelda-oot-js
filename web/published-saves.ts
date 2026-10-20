// On the Pages site there is no saves server. The deploy publishes the player's saves under `saves/` (tools/pages/assets.ts); a visitor with no save of their own
// starts from those, and what they save afterwards stays in their browser.
import type { PublishedSaves } from '../tools/pages/assets.ts';
import type { SaveStore } from './saves.ts';
import { OLD_FORMAT, type StateStore } from './savestate.ts';

export type Published = PublishedSaves;

/** The manifest of the published saves, or null when the site has none. */
export async function loadPublished(base: string, fetcher: typeof fetch = fetch): Promise<Published | null> {
  try {
    const r = await fetcher(`${base}saves/index.json`);
    return r.ok ? ((await r.json()) as Published) : null;
  } catch {
    return null;
  }
}

/** Reads from `local` and falls back to the published save; writes go to `local`. */
export function withPublishedSram(local: SaveStore, published: Published, base: string, fetcher: typeof fetch = fetch): SaveStore {
  return {
    async load() {
      const own = await local.load();
      if (own || !published.sram) return own;
      const r = await fetcher(`${base}saves/sram.bin`);
      if (!r.ok) throw new Error(`could not read the published save: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    store: (bytes, options) => local.store(bytes, options),
  };
}

export function withPublishedStates(local: StateStore, published: Published, base: string, fetcher: typeof fetch = fetch): StateStore {
  return {
    async get(slot) {
      const own = await local.get(slot);
      const meta = published.states[slot];
      if (own || !meta) return own;
      const r = await fetcher(`${base}saves/state-${slot}.bin`);
      if (!r.ok) throw new Error(`could not read published slot ${slot}: ${r.status}`);
      return { format: meta.format || OLD_FORMAT, savedAt: meta.savedAt, hz: meta.hz, data: new Uint8Array(await r.arrayBuffer()) };
    },
    put: (slot, record) => local.put(slot, record),
  };
}
