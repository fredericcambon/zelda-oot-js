import { describe, expect, it } from 'vitest';
import { itemIconIndex, LAST_ITEM_ICON, questIconIndex } from './icons.ts';

describe('picture indexes', () => {
  it('uses the item id, with the four exceptions the pause menu showed', () => {
    expect([0, 3, 59, 70].map(itemIconIndex)).toEqual([0, 3, 59, 70]);
    expect([33, 34, 45, 46].map(itemIconIndex)).toEqual([45, 46, 33, 34]);
    expect(itemIconIndex(LAST_ITEM_ICON + 1)).toBeNull();
    expect(itemIconIndex(0xff)).toBeNull();
  });

  it('maps medallions, stones, boxes and the spider token, and nothing else', () => {
    expect([0, 5, 18, 20, 21, 22, 23].map(questIconIndex)).toEqual([0, 5, 6, 8, 9, 10, 11]);
    expect([6, 11, 12, 17].map(questIconIndex)).toEqual([null, null, null, null]);
  });
});
