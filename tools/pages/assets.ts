// What the Pages build carries besides the web build, the game and the pack: the player's saves (`saves/`, with a manifest the page reads) and the
// upscaled texture pack (`texpack/<variant>/`, where the page looks for it). Both come from this machine's folders (web/saves-endpoint.ts, tools/tex/location.ts).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateMeta } from '../../web/saves-endpoint.ts';

export const SAVES_DIR = 'saves';
export const SAVES_MANIFEST = 'index.json';
export const PACK_DIR = 'texpack';
const SLOTS = [1, 2, 3, 4];

export interface PublishedSaves {
  sram: boolean;
  /** Slot to the format, saved-at time and video rate of its state. */
  states: Record<string, { format: number; savedAt: number; hz: 50 | 60 }>;
}

/** Copies the cartridge save and the save states of `from` into `<out>/saves/` and writes the manifest; returns it. */
export function publishSaves(from: string, out: string): PublishedSaves {
  const to = join(out, SAVES_DIR);
  mkdirSync(to, { recursive: true });
  const manifest: PublishedSaves = { sram: false, states: {} };
  if (existsSync(join(from, 'sram.bin'))) {
    copyFileSync(join(from, 'sram.bin'), join(to, 'sram.bin'));
    manifest.sram = true;
  }
  for (const slot of SLOTS) {
    const file = join(from, `state-${slot}.bin`);
    if (!existsSync(file)) continue;
    copyFileSync(file, join(to, `state-${slot}.bin`));
    const [format = '0', savedAt = '0', hz = '50'] = stateMeta(file);
    manifest.states[slot] = { format: Number(format) || 0, savedAt: Number(savedAt) || 0, hz: hz === '60' ? 60 : 50 };
  }
  writeFileSync(join(to, SAVES_MANIFEST), JSON.stringify(manifest));
  return manifest;
}

const PACK_FILE = /^([0-9a-f]{16}\.png|index\.json)$/;

/** Copies the files of one variant of the texture pack to `<out>/texpack/<variant>/`; returns how many. */
export function publishPack(packDir: string, variant: string, out: string): number {
  const from = join(packDir, variant);
  if (!existsSync(join(from, 'index.json'))) throw new Error(`no texture pack at ${from}: build it first (npm run tex -- upscale)`);
  const to = join(out, PACK_DIR, variant);
  mkdirSync(to, { recursive: true });
  let count = 0;
  for (const name of readdirSync(from)) {
    if (!PACK_FILE.test(name)) continue;
    copyFileSync(join(from, name), join(to, name));
    count++;
  }
  return count;
}
