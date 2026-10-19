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
  /** Soft contact shadows in corners and under objects of the 3D scene, from its depth (never the HUD or the sky). */
  ao: boolean;
  /** Strength of the occlusion, 0 to 100. */
  aoStrength: number;
  /** A soft glow around the bright parts of the 3D scene (never the HUD). */
  bloom: boolean;
  /** Strength of the bloom, 0 to 100. */
  bloomStrength: number;
  /** Brightness (luma, 0 to 100 for 0 to 1) above which pixels bloom. */
  bloomThreshold: number;
  /** Width of the soft edge around the threshold, 0 to 100 for 0 to 1; 0 is a hard cut. */
  bloomKnee: number;
  /** How far the glow spreads, 0 to 100: the number of blur levels. */
  bloomRadius: number;
  /** Contrast-adaptive sharpening of the 3D scene (never the HUD). */
  sharpen: boolean;
  /** Strength of the sharpening, 0 to 100. */
  sharpenStrength: number;
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
  ao: true,
  aoStrength: 40,
  bloom: true,
  bloomStrength: 30,
  bloomThreshold: 80,
  bloomKnee: 40,
  bloomRadius: 100,
  sharpen: true,
  sharpenStrength: 30,
});

export const isMobile = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const isStrength = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

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
  if (typeof raw.ao === 'boolean') settings.ao = raw.ao;
  if (isStrength(raw.aoStrength)) settings.aoStrength = raw.aoStrength;
  if (typeof raw.bloom === 'boolean') settings.bloom = raw.bloom;
  if (typeof raw.sharpen === 'boolean') settings.sharpen = raw.sharpen;
  if (isStrength(raw.bloomStrength)) settings.bloomStrength = raw.bloomStrength;
  if (isStrength(raw.bloomThreshold)) settings.bloomThreshold = raw.bloomThreshold;
  if (isStrength(raw.bloomKnee)) settings.bloomKnee = raw.bloomKnee;
  if (isStrength(raw.bloomRadius)) settings.bloomRadius = raw.bloomRadius;
  if (isStrength(raw.sharpenStrength)) settings.sharpenStrength = raw.sharpenStrength;
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
