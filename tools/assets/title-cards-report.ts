// Lists which scenes have a title card and which of them the game can draw (docs/re/title-cards.md), and writes one sheet of
// the cards to out/title-cards/ (git-ignored): `OOT_ROM=<rom> npx tsx tools/assets/title-cards-report.ts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CARD_HEIGHT, CARD_WIDTH, ENTRANCE_SHOWS_CARD, readTitleCards, SCENE_RECORDS, scenesWithCard } from '../../web/inspect/title-cards.ts';
import { encodePng } from '../gfx/png.ts';
import { readFile } from '../rom/extract.ts';
import { locateFileTable } from '../rom/filetable.ts';
import { ENTRANCE_COUNT, ENTRANCE_TABLE, SCENE_TABLE } from '../headless/state.ts';
import { SCENE_COUNT } from '../../web/inspect/warp.ts';

const path = process.env.OOT_ROM;
if (!path) throw new Error('set OOT_ROM to the ROM path');
const rom = new Uint8Array(readFileSync(path));
const table = locateFileTable(rom);
const cards = readTitleCards(rom);

// The entrance table sits SCENE_TABLE - ENTRANCE_TABLE bytes before the scene table in the main code file (file 28, scene table at 949600).
const code = readFile(rom, table.entries[28]!);
const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
const entranceAt = 949600 - (SCENE_TABLE - ENTRANCE_TABLE);
const entrances = Array.from({ length: ENTRANCE_COUNT }, (_, entry) => {
  const word = dv.getUint32(entranceAt + entry * 4);
  return { entry, scene: word >>> 24, flags: word & 0xffff };
});
const shown = scenesWithCard(cards, entrances);

const withFile: number[] = [];
const without: number[] = [];
for (let scene = 0; scene < SCENE_RECORDS; scene++) (cards.file(scene) === null ? without : withFile).push(scene);
const hidden = withFile.filter((s) => !shown.has(s));
const files = new Set(withFile.map((s) => cards.file(s)));

console.log(`scenes ${SCENE_RECORDS}; with a card file ${withFile.length} (${files.size} distinct files); drawn by an entrance with bit ${ENTRANCE_SHOWS_CARD.toString(16)}: ${shown.size}; file but no such entrance: [${hidden.join(', ')}]`);
console.log(`without a card (${without.length}): ${without.join(', ')}`);
console.log('scene | file | entrances with bit / all');
for (const scene of withFile) {
  const mine = entrances.filter((e) => e.scene === scene);
  console.log(`${scene} | ${cards.file(scene)} | ${mine.filter((e) => e.flags & ENTRANCE_SHOWS_CARD).length} / ${mine.length}`);
}

// What each entrance of the Warp list can show: the destination scene's card, and the picture the sweep took there (web/public/warp-thumbs).
const valid = entrances.filter((e) => e.scene < SCENE_COUNT);
const hasCard = (e: { scene: number }) => shown.has(e.scene);
const hasPicture = (e: { entry: number }) => existsSync(`web/public/warp-thumbs/${String(e.entry).padStart(4, '0')}.png`);
const cardOnly = valid.filter((e) => hasCard(e) && !hasPicture(e));
const pictureOnly = valid.filter((e) => !hasCard(e) && hasPicture(e));
const both = valid.filter((e) => hasCard(e) && hasPicture(e));
const neither = valid.filter((e) => !hasCard(e) && !hasPicture(e));
console.log(`entrances ${entrances.length}; valid ${valid.length}; with a card ${valid.filter(hasCard).length}; with a picture ${valid.filter(hasPicture).length}; both ${both.length}, card only ${cardOnly.length}, picture only ${pictureOnly.length}, neither ${neither.length}`);
if (neither.length > 0) console.log(`neither: ${neither.map((e) => e.entry).join(', ')}`);

// One row per scene with a card, English picture.
const rows = withFile.length;
const sheet = new Uint8Array(CARD_WIDTH * CARD_HEIGHT * rows * 4);
withFile.forEach((scene, r) => sheet.set(cards.card(scene, 0)!, r * CARD_WIDTH * CARD_HEIGHT * 4));
mkdirSync('out/title-cards', { recursive: true });
writeFileSync('out/title-cards/sheet.png', encodePng(CARD_WIDTH, CARD_HEIGHT * rows, sheet));
console.log(`wrote out/title-cards/sheet.png (rows in the order of the scene list above)`);
