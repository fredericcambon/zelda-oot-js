// Rendering options that the user can change: texture filter, anti-aliasing, resolution cap. Kept in localStorage.

/** n64: the console's 3-point filter; smooth: standard bilinear; sharp: nearest texel. */
export type FilterMode = 'n64' | 'smooth' | 'sharp';

export const FILTER_MODES: readonly FilterMode[] = ['n64', 'smooth', 'sharp'];

/** hard: the game's alpha test; smooth: alpha-to-coverage edges on cut-outs (needs multisampling). */
export type CutoutMode = 'hard' | 'smooth';

export const CUTOUT_MODES: readonly CutoutMode[] = ['hard', 'smooth'];

export interface GfxSettings {
  filter: FilterMode;
  /** 4x multisampling of the 3D framebuffer where the browser offers it. */
  msaa: boolean;
  /** Largest device pixel ratio the 3D image is rendered at; 0 means no cap. */
  scaleCap: number;
  /** Mip levels for 3D textures. */
  mipmaps: boolean;
  /** Taps along the long axis of a texture's footprint on surfaces seen at a grazing angle (1 off, up to 8). */
  anisotropy: number;
  /** Edges of cut-out textures (foliage, fences) in 3D scenes. */
  cutout: CutoutMode;
}

export const STORAGE_KEY = 'oot.gfx';
export const MOBILE_SCALE_CAP = 2;
/** The 3D image is at most this many times 320x240 (a 2560 pixel wide canvas). */
export const MAX_SCALE = 8;

export const defaultSettings = (mobile: boolean): GfxSettings => ({
  filter: 'n64',
  msaa: true,
  scaleCap: mobile ? MOBILE_SCALE_CAP : 0,
  mipmaps: true,
  anisotropy: mobile ? 2 : 4,
  cutout: 'smooth',
});

export const isMobile = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** The stored settings, with every field that is missing or invalid taken from the defaults. */
export function parseSettings(text: string | null, mobile: boolean): GfxSettings {
  const settings = defaultSettings(mobile);
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // Unreadable text: the defaults stay.
  }
  if (FILTER_MODES.includes(raw.filter as FilterMode)) settings.filter = raw.filter as FilterMode;
  if (CUTOUT_MODES.includes(raw.cutout as CutoutMode)) settings.cutout = raw.cutout as CutoutMode;
  if (typeof raw.msaa === 'boolean') settings.msaa = raw.msaa;
  if (typeof raw.mipmaps === 'boolean') settings.mipmaps = raw.mipmaps;
  if (typeof raw.scaleCap === 'number' && Number.isFinite(raw.scaleCap) && raw.scaleCap >= 0) settings.scaleCap = raw.scaleCap;
  if (typeof raw.anisotropy === 'number' && Number.isInteger(raw.anisotropy) && raw.anisotropy >= 1 && raw.anisotropy <= 8) settings.anisotropy = raw.anisotropy;
  return settings;
}

export function loadSettings(): GfxSettings {
  const mobile = isMobile();
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY), mobile);
  } catch {
    return defaultSettings(mobile);
  }
}

/** Returns false when the browser did not keep the settings. */
export function saveSettings(settings: GfxSettings): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** The 3D image's size as a multiple of 320x240: the canvas in device pixels, with the device pixel ratio capped by `scaleCap`. */
export function renderScale(cssWidth: number, devicePixelRatio: number, settings: GfxSettings): number {
  const ratio = settings.scaleCap > 0 ? Math.min(devicePixelRatio, settings.scaleCap) : devicePixelRatio;
  const scale = (cssWidth * ratio) / 320;
  return Math.min(MAX_SCALE, Math.max(1, Number.isFinite(scale) ? scale : 1));
}
