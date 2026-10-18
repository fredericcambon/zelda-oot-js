// The one place that asks the player for a file: a save memory image. The game's cartridge is never asked for.

const MAX_BYTES = 1024 * 1024;

/** Opens the browser's file chooser for a save memory image and returns its bytes, or null when the choice is cancelled. */
export function pickSaveFile(): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bin,.sram,.srm,.sav';
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const chosen = input.files?.[0];
      if (!chosen) return resolve(null);
      if (chosen.size > MAX_BYTES) return reject(new Error(`${chosen.name} is too large for a save file`));
      chosen.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
    });
    input.click();
  });
}
