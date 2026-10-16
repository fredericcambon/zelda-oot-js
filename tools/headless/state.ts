// The game's record of the state overlay that holds the language and file selection screens (docs/re/input.md).

/** Address in the main code file's data of the 0x30-byte record for file 33 (virtual ROM 0xBA0A00-0xBB10E0). */
export const FILE_SELECT_RECORD = 0x800ef384;

/** Word offsets inside the record. */
export const RECORD = { romStart: 0x00, romEnd: 0x04, linkStart: 0x08, linkEnd: 0x0c, init: 0x14 } as const;

/** Link address of the overlay's init routine; the record holds it until the game loads the overlay and relocates it. */
export const FILE_SELECT_INIT_LINKED = 0x808127ac;

/** Whether the game has loaded the file select overlay: its record then holds the init routine's loaded address. */
export function fileSelectLoaded(rd32: (addr: number) => number): boolean {
  return rd32(FILE_SELECT_RECORD + RECORD.init) >>> 0 !== FILE_SELECT_INIT_LINKED;
}
