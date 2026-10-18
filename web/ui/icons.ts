import { useEffect, useState } from 'preact/hooks';
import { loadCartridge } from '../cartridge.ts';
import { ITEM_SIZE, QUEST_SIZE, readPictures, type Pictures } from '../inspect/icons.ts';

export interface Icons {
  /** An image URL for item picture `index`, or null while the pictures load, or when there is none. */
  item(index: number): string | null;
  quest(index: number): string | null;
  /** Why the pictures are not there, when they are not. */
  error: string | null;
}

const NONE: Icons = { item: () => null, quest: () => null, error: null };

function urlOf(rgba: Uint8ClampedArray | null, size: number): string | null {
  if (!rgba) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
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

let loading: Promise<Icons> | undefined;

/** The page fetches the pack again (the browser serves it from its cache) and keeps only the two picture files. */
function loadIcons(): Promise<Icons> {
  loading ??= loadCartridge(() => {}).then((cartridge) => iconsFor(readPictures(cartridge))).catch((err: unknown) => ({ ...NONE, error: err instanceof Error ? err.message : String(err) }));
  return loading;
}

/** The pause menu's pictures, read from the game's own data; empty until they are loaded. */
export function useIcons(): Icons {
  const [icons, setIcons] = useState<Icons>(NONE);
  useEffect(() => {
    let live = true;
    void loadIcons().then((i) => live && setIcons(i));
    return () => {
      live = false;
    };
  }, []);
  return icons;
}
