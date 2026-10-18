// An optional local pack of replacement textures: `out/texpack/<variant>/<hash>.png` on the machine that built it (`npm run tex -- upscale`), served to
// loopback clients only at `/texpack/<variant>/` and listed in its `index.json`. A decoded texture is looked up by `hashImage`. A replacement is a
// whole multiple (2 or 4) of the size of the texture it stands for, and the renderer samples it with the texture's own tile settings.
import { hashImage, hashTexture } from '../tools/tex/hash.ts';

export { hashImage, hashTexture };

export const PACK_URL = 'texpack/';
export const STORAGE_KEY = 'oot.texpack';
export const VARIANT_KEY = 'oot.texpack.variant';
export const DEFAULT_VARIANT = 'a';
/** The key that switches between the original textures and the pack. */
export const TOGGLE_KEY = 't';
/** The factors a replacement may have. */
export const PACK_SCALES = [2, 4];

export interface PackSummary {
  /** Whether a pack is being served. */
  available: boolean;
  enabled: boolean;
  /** Entries in the pack. */
  entries: number;
  /** Distinct textures the renderer has decoded and looked up. */
  seen: number;
  /** Of those, the ones that have a replacement in use. */
  replaced: number;
  /** Replacements requested and not yet loaded. */
  pending: number;
}

type Listener = () => void;

export class TexPack {
  private entries: Set<string> | null = null;
  private readonly bitmaps = new Map<string, ImageBitmap | null>();
  private readonly requested = new Set<string>();
  /** Entry that each texture looked up resolved to ('' for none). */
  private readonly names = new Map<string, string>();
  private on: boolean;
  /** Called when the index arrives, when a replacement arrives (with the name of its entry) and when the switch is toggled (with no name). */
  onChange: ((hash?: string) => void) | null = null;

  constructor(private base = PACK_URL, enabled = readEnabled(), public variant = readVariant()) {
    this.on = enabled;
  }

  /** Switches to another variant of the pack: its index is fetched, the replacements of the old one are forgotten and `onChange` is called. */
  async setVariant(variant: string, fetcher: typeof fetch = fetch): Promise<void> {
    this.variant = variant;
    try {
      localStorage.setItem(VARIANT_KEY, variant);
    } catch {
      // The choice is kept for this page only.
    }
    this.entries = null;
    this.bitmaps.clear();
    this.requested.clear();
    this.names.clear();
    await this.load(fetcher);
    this.onChange?.();
  }

  /** Fetches the index of the pack; a missing pack, or a server that answers with something else, leaves it empty. */
  async load(fetcher: typeof fetch = fetch): Promise<void> {
    try {
      const response = await fetcher(`${this.base}${this.variant}/index.json`);
      if (!response.ok) return;
      const index = (await response.json()) as { textures?: unknown };
      if (!index.textures || typeof index.textures !== 'object') return;
      this.entries = new Set(Object.keys(index.textures));
    } catch {
      return;
    }
    if (this.entries.size > 0) this.onChange?.();
  }

  /** Hashes of the textures looked up that the pack has no entry for. */
  unresolved(): string[] {
    return [...this.names].filter(([, name]) => name === '').map(([hash]) => hash);
  }

  /** The entry a texture looked up resolved to ('' for none, undefined when it was not looked up). */
  nameOf(hash: string): string | undefined {
    return this.names.get(hash);
  }

  get available(): boolean {
    return this.entries !== null && this.entries.size > 0;
  }

  get enabled(): boolean {
    return this.on;
  }

  set enabled(value: boolean) {
    if (value === this.on) return;
    this.on = value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      // The choice is kept for this page only.
    }
    this.onChange?.();
  }

  /**
   * The replacement for a texture, or null: not in the pack, pack off, or still on its way (it is requested, and `onChange` is called with the name of the
   * entry when it arrives).
   */
  lookup(hash: string): ImageBitmap | null {
    if (!this.entries) return null;
    const name = this.entries.has(hash) ? hash : '';
    this.names.set(hash, name);
    if (!this.on || name === '') return null;
    const known = this.bitmaps.get(name);
    if (known !== undefined) return known;
    if (!this.requested.has(name)) {
      this.requested.add(name);
      void this.fetchOne(name);
    }
    return null;
  }

  private async fetchOne(hash: string): Promise<void> {
    const variant = this.variant;
    let bitmap: ImageBitmap | null = null;
    try {
      const response = await fetch(`${this.base}${variant}/${hash}.png`);
      if (response.ok) bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      bitmap = null;
    }
    // The answer to a request for a variant that has been switched away from is dropped.
    if (variant !== this.variant) return;
    this.bitmaps.set(hash, bitmap);
    this.onChange?.(hash);
  }

  summary(): PackSummary {
    let replaced = 0;
    for (const name of this.names.values()) if (name !== '' && this.bitmaps.get(name)) replaced++;
    return {
      available: this.available,
      enabled: this.on,
      entries: this.entries?.size ?? 0,
      seen: this.names.size,
      replaced,
      pending: this.requested.size - this.bitmaps.size,
    };
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function readVariant(): string {
  try {
    return localStorage.getItem(VARIANT_KEY) || DEFAULT_VARIANT;
  } catch {
    return DEFAULT_VARIANT;
  }
}

/** The factor by which a replacement is larger than the texture it stands for in both directions (one of `PACK_SCALES`), or 0 when it does not fit. */
export function scaleOf(original: { width: number; height: number }, replacement: { width: number; height: number }): number {
  const k = replacement.width / original.width;
  return PACK_SCALES.includes(k) && replacement.height === original.height * k ? k : 0;
}

/** The pack of the page, or null where there is no page to serve one (the tests, a worker). */
export function pagePack(): TexPack | null {
  if (typeof location === 'undefined' || typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;
  const pack = new TexPack(new URL(PACK_URL, document.baseURI).href);
  void pack.load();
  return pack;
}

/** Shows `text` at the bottom of the page for a moment. */
function toast(text: string): void {
  let element = document.getElementById('texpack-toast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'texpack-toast';
    element.style.cssText = 'position:fixed;left:50%;bottom:1.5em;transform:translateX(-50%);padding:.4em .8em;background:#000c;color:#fff;font:14px sans-serif;border-radius:4px;pointer-events:none;z-index:10';
    document.body.append(element);
  }
  element.textContent = text;
  element.style.display = 'block';
  clearTimeout(Number(element.dataset.timer));
  const shown = element;
  element.dataset.timer = String(setTimeout(() => (shown.style.display = 'none'), 1500));
}

/** Binds the toggle key on `target`, with a notice on the page. Returns what unbinds it. */
export function bindToggleKey(pack: TexPack, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>): Listener {
  const handler = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.metaKey || k.altKey || k.key.toLowerCase() !== TOGGLE_KEY) return;
    const element = k.target as Element | null;
    if (element && /^(input|textarea|select)$/i.test(element.tagName)) return;
    if (!pack.available) return;
    pack.enabled = !pack.enabled;
    toast(pack.enabled ? 'Texture pack: on' : 'Texture pack: off (original textures)');
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}
