// Loads the built game module and starts it on a cartridge image: the sequence the page and the headless runner share.

/** The exports every host uses (runtime/headless.c). */
export interface OotCore {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _oot_boot(rom: number, size: number): void;
  _oot_frame(): void | Promise<void>;
  _oot_idle(): number;
  _oot_frames(): number;
  _oot_gfx_tasks(): number;
  _oot_audio_tasks(): number;
  _oot_retraces(): number;
  _oot_rdram(): number;
  _oot_pad_set(port: number, buttons: number, x: number, y: number): void;
  _oot_sram(): number;
  _oot_sram_size(): number;
  _oot_sram_take_dirty(): number;
  _oot_fatal_message(): number;
  UTF8ToString(ptr: number): string;
}

export const RDRAM_SIZE = 0x800000;

/** Instantiates the module at `moduleUrl`, copies `rom` into its memory and calls `oot_boot`. */
export async function startModule<M extends OotCore>(moduleUrl: string, rom: Uint8Array, options: object): Promise<M> {
  const factory = (await import(/* @vite-ignore */ moduleUrl)).default as (opts: object) => Promise<M>;
  const mod = await factory({ print: () => {}, printErr: (m: string) => console.error(m), ...options });
  const copy = mod._malloc(rom.length);
  mod.HEAPU8.set(rom, copy);
  mod._oot_boot(copy, rom.length);
  return mod;
}
