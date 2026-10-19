// Prints how the Warp list folds the entrance table into places and how many rows have text names (docs/re/entrances.md):
// `OOT_ROM=<rom> npx tsx tools/assets/places-report.ts [--all]` (--all lists every scene with its rows).
import { readFileSync } from 'node:fs';
import { CARD_NAMES } from '../../web/inspect/card-names.ts';
import { readExitLists } from '../../web/inspect/exits.ts';
import { buildPlaces } from '../../web/inspect/places.ts';
import { CODE_FILE, readTitleCards, SCENE_RECORDS, SCENE_RECORD_SIZE, SCENE_TABLE_AT } from '../../web/inspect/title-cards.ts';
import { SCENE_COUNT } from '../../web/inspect/warp.ts';
import { ENTRANCE_COUNT, ENTRANCE_TABLE, SCENE_TABLE } from '../headless/state.ts';
import { readFile } from '../rom/extract.ts';
import { locateFileTable } from '../rom/filetable.ts';

const path = process.env.OOT_ROM;
if (!path) throw new Error('set OOT_ROM to the ROM path');
const rom = new Uint8Array(readFileSync(path));
const code = readFile(rom, locateFileTable(rom).entries[CODE_FILE]!);
const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
const at = SCENE_TABLE_AT - (SCENE_TABLE - ENTRANCE_TABLE);
const entries = Array.from({ length: ENTRANCE_COUNT }, (_, entry) => {
  const word = dv.getUint32(at + entry * 4);
  return { entry, scene: word >>> 24, spawn: (word >>> 16) & 0xff, valid: word >>> 24 < SCENE_COUNT };
});
const cards = readTitleCards(rom);
const exits = readExitLists(rom);
const places = buildPlaces(entries, exits, (scene) => {
  const file = cards.file(scene);
  return file === null ? undefined : CARD_NAMES[file];
});

const valid = entries.filter((e) => e.valid).length;
const lists = [...exits.values()];
console.log(`scene records ${SCENE_RECORDS} (record size ${SCENE_RECORD_SIZE}); exit lists ${exits.size}, ${lists.reduce((n, l) => n + l.length, 0)} exits`);
console.log(`table records ${entries.length}, valid ${valid}, rows (scene + spawn) ${places.rows} in ${places.groups.length} scenes`);
console.log(`rows named by a title card (proven) ${places.named.card}, named from neighbours (derived) ${places.named.derived}, neither ${places.named.none}`);
const arrivals = places.groups.flatMap((g) => g.arrivals);
console.log(`rows told apart by where they come from ${arrivals.filter((a) => a.sources.length > 0).length}; by spawn number only ${arrivals.filter((a) => a.sources.length === 0).length}`);
console.log(`rows with only one record ${arrivals.filter((a) => a.entries.length === 1).length}; with 4 ${arrivals.filter((a) => a.entries.length === 4).length}; with more ${arrivals.filter((a) => a.entries.length > 4).length}`);
console.log(`scenes by kind: ${['card', 'derived', 'none'].map((k) => `${k} ${places.groups.filter((g) => g.kind === k).length}`).join(', ')}`);
if (process.argv.includes('--all')) {
  for (const g of places.groups) console.log(`${g.kind} | ${g.name} [${g.scene}] | ${g.arrivals.map((a) => `${a.name} {${a.entries.join(',')}}`).join(' ; ')}`);
}
