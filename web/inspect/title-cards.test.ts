import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, decodeIA8, ENTRANCE_SHOWS_CARD, readTitleCards, SCENE_RECORDS, scenesWithCard } from './title-cards.ts';

describe('title cards', () => {
  it('decodes IA8 with the intensity in the high nibble and the alpha in the low one', () => {
    expect(Array.from(decodeIA8(new Uint8Array([0x00, 0x0f, 0xff, 0x8f])))).toEqual([0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 136, 136, 136, 255]);
  });

  it('counts a scene when its record names a card and an entrance with the bit leads into it', () => {
    const cards = { file: (scene: number) => (scene === 1 || scene === 2 ? 900 + scene : null) };
    const shown = scenesWithCard(cards, [
      { scene: 1, flags: ENTRANCE_SHOWS_CARD | 0x102 },
      { scene: 2, flags: 0x204 },
      { scene: 3, flags: ENTRANCE_SHOWS_CARD },
    ]);
    expect([...shown]).toEqual([1]);
  });
});

const rom = process.env.OOT_ROM;

describe.skipIf(!rom || !existsSync(rom))('title cards of the cartridge', () => {
  it('finds 65 scenes with a card among 57 files, each picture with visible text', () => {
    const cards = readTitleCards(new Uint8Array(readFileSync(rom!)));
    const withCard = Array.from({ length: SCENE_RECORDS }, (_, s) => s).filter((s) => cards.file(s) !== null);
    expect(withCard).toHaveLength(65);
    expect(new Set(withCard.map((s) => cards.file(s))).size).toBe(57);
    expect(cards.file(10)).toBeNull();
    for (const language of [0, 1, 2]) {
      const rgba = cards.card(81, language)!;
      expect(rgba).toHaveLength(CARD_WIDTH * CARD_HEIGHT * 4);
      const opaqueWhite = Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + 3]! === 255 && rgba[i * 4]! === 255).filter(Boolean).length;
      expect(opaqueWhite).toBeGreaterThan(100);
    }
    expect(cards.card(10, 0)).toBeNull();
  });
});
