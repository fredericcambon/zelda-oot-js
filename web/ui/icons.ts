import { useEffect, useState } from 'preact/hooks';
import { loadCartridge } from '../cartridge.ts';
import { ITEM_SIZE, QUEST_SIZE, readPictures, type Pictures } from '../inspect/icons.ts';
import { readExitLists } from '../inspect/exits.ts';
import { CARD_HEIGHT, CARD_WIDTH, readTitleCards, type TitleCards } from '../inspect/title-cards.ts';

export interface Icons {
  /** An image URL for item picture `index`, or null while the pictures load, or when there is none. */
  item(index: number): string | null;
  quest(index: number): string | null;
  /** Why the pictures are not there, when they are not. */
  error: string | null;
}

const NONE: Icons = { item: () => null, quest: () => null, error: null };

function urlOf(rgba: Uint8ClampedArray | null, width: number, height = width): string | null {
  if (!rgba) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvas.toDataURL();
}

function iconsFor(pictures: Pictures): Icons {
  const items = new Map<number, string | null>();
  const quest = new Map<number, string | null>();
  const cached = (cache: Map<number, string | null>, i: number, make: () => string | null) => {
    if (!cache.has(i)) cache.set(i, make());
    return cache.get(i)!;
  };
  return {
    item: (i) => cached(items, i, () => urlOf(pictures.item(i), ITEM_SIZE)),
    quest: (i) => cached(quest, i, () => urlOf(pictures.quest(i), QUEST_SIZE)),
    error: null,
  };
}

interface Art {
  icons: Icons;
  cards: TitleCards | null;
  exits: ReadonlyMap<number, readonly number[]>;
}

let loading: Promise<Art> | undefined;

/** The page fetches the pack again (the browser serves it from its cache) and keeps only the pictures it needs. */
function loadArt(): Promise<Art> {
  loading ??= loadCartridge(() => {})
    .then((image) => ({ icons: iconsFor(readPictures(image)), cards: cardsOf(image), exits: exitsOf(image) }))
    .catch((err: unknown) => ({ icons: { ...NONE, error: err instanceof Error ? err.message : String(err) }, cards: null, exits: new Map() }));
  return loading;
}

/** The pause menu's pictures, read from the game's own data; empty until they are loaded. */
export function useIcons(): Icons {
  const [icons, setIcons] = useState<Icons>(NONE);
  useEffect(() => {
    let live = true;
    void loadArt().then((a) => live && setIcons(a.icons));
    return () => {
      live = false;
    };
  }, []);
  return icons;
}

export interface CardImages {
  /** The scene's file table index for its card, or null when its record names none. */
  file(scene: number): number | null;
  /** An image URL for the scene's card in `language`, or null when it has none. */
  url(scene: number, language: number): string | null;
}

function cardImagesFor(cards: TitleCards): CardImages {
  const urls = new Map<string, string | null>();
  return {
    file: (scene) => cards.file(scene),
    url(scene, language) {
      const key = `${scene}:${language}`;
      if (!urls.has(key)) urls.set(key, urlOf(cards.card(scene, language), CARD_WIDTH, CARD_HEIGHT));
      return urls.get(key)!;
    },
  };
}

/** The title cards, read from the game's own data; null until they are loaded, and when the data has none. */
export function useTitleCards(): CardImages | null {
  const [cards, setCards] = useState<CardImages | null>(null);
  useEffect(() => {
    let live = true;
    void loadArt().then((a) => live && a.cards && setCards(cardImagesFor(a.cards)));
    return () => {
      live = false;
    };
  }, []);
  return cards;
}

function exitsOf(image: Uint8Array): ReadonlyMap<number, readonly number[]> {
  try {
    return readExitLists(image);
  } catch {
    return new Map();
  }
}

function cardsOf(image: Uint8Array): TitleCards | null {
  try {
    return readTitleCards(image);
  } catch {
    return null;
  }
}

/** The exit list of each scene, read from the game's own data; empty until it is loaded. */
export function useSceneExits(): ReadonlyMap<number, readonly number[]> | null {
  const [exits, setExits] = useState<ReadonlyMap<number, readonly number[]> | null>(null);
  useEffect(() => {
    let live = true;
    void loadArt().then((a) => live && setExits(a.exits));
    return () => {
      live = false;
    };
  }, []);
  return exits;
}
