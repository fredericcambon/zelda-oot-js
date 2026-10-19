// The exit list of every scene: the entrance table indices its exits lead to, read from the scene files of the cartridge image the
// page already loads (docs/re/entrances.md). Nothing is stored or shipped.
import { readCommands } from '../../tools/assets/scene.ts';
import { locateFileTable } from '../../tools/rom/filetable.ts';
import { fileOf } from './icons.ts';
import { CODE_FILE, SCENE_RECORDS, SCENE_RECORD_SIZE, SCENE_TABLE_AT } from './title-cards.ts';

/** Scene header command whose operand is a segment 2 pointer to the exit list (handler 0x800829D8). */
const EXIT_LIST_COMMAND = 0x13;
const SEGMENT_SCENE = 2;
/** The entrance table has this many records; a halfword at or past it is not an entrance index. */
const ENTRANCE_COUNT = 1556;

/** Exit lists by scene: the entrance table index of exit 1, 2, ...; a scene without the command has none. */
export function readExitLists(cartridge: Uint8Array): Map<number, number[]> {
  const table = locateFileTable(cartridge);
  const code = fileOf(cartridge, table.entries[CODE_FILE]!);
  const codeView = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const byStart = new Map(table.entries.map((e) => [e.virtualStart, e]));
  const lists = new Map<number, number[]>();
  for (let scene = 0; scene < SCENE_RECORDS; scene++) {
    const entry = byStart.get(codeView.getUint32(SCENE_TABLE_AT + scene * SCENE_RECORD_SIZE));
    if (!entry) continue;
    const bytes = fileOf(cartridge, entry);
    const commands = readCommands(bytes);
    const command = commands?.find((c) => c.id === EXIT_LIST_COMMAND && c.value >>> 24 === SEGMENT_SCENE);
    if (!commands || !command) continue;
    lists.set(scene, exitList(bytes, commands.map((c) => c.value), command.value & 0xffffff));
  }
  return lists;
}

/**
 * The list has no count: it runs to the next data the header points to. Halfwords that are not entrance indices are dropped
 * and so are zeros at the end, which are padding.
 */
export function exitList(bytes: Uint8Array, headerWords: readonly number[], at: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const next = headerWords.filter((w) => w >>> 24 === SEGMENT_SCENE && (w & 0xffffff) > at).map((w) => w & 0xffffff);
  const end = Math.min(bytes.length, ...next);
  const list: number[] = [];
  for (let o = at; o + 2 <= end; o += 2) {
    const v = view.getUint16(o);
    if (v < ENTRANCE_COUNT) list.push(v);
  }
  while (list.length > 0 && list[list.length - 1] === 0) list.pop();
  return list;
}
