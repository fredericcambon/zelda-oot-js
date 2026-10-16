// Saves made while the page used the browser's own storage move to the server's folder the first time the server
// has the endpoint. The browser's copy stays where it is.
import type { SaveStore } from './saves.ts';
import { SLOT_COUNT, type StateStore } from './savestate.ts';

export interface Stores {
  sram: SaveStore;
  states: StateStore;
}

/** Copies what the server lacks from `local`; returns what moved, and passes failures to `report`. */
export async function migrateToServer(local: Stores, server: Stores, report: (what: string, err: unknown) => void = () => {}): Promise<string[]> {
  const moved: string[] = [];
  const attempt = async (what: string, run: () => Promise<boolean>) => {
    try {
      if (await run()) moved.push(what);
    } catch (err) {
      report(what, err);
    }
  };
  await attempt('sram', async () => {
    if ((await server.sram.load()) !== null) return false;
    const bytes = await local.sram.load();
    if (!bytes) return false;
    await server.sram.store(bytes);
    return true;
  });
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    await attempt(`slot ${slot}`, async () => {
      if ((await server.states.get(slot)) !== null) return false;
      const record = await local.states.get(slot);
      if (!record) return false;
      await server.states.put(slot, record);
      return true;
    });
  }
  return moved;
}
