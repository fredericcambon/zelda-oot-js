// `npm run tex -- upscale [--dump <cache>/tex/<rom>/dump] [--out <cache>/tex/<rom>/pack] [--tool <dir>] [--python <exe>] [--variants a,b,c,d] [--pad 16] [--limit N]`: enlarges every
// texture of the dump that is not volatile with a third-party model run locally (a Real-ESRGAN model of its official release, run by tools/tex/model_run.py
// with numpy, see docs/texture-pack.md) and writes one pack per variant named by `--variants` (the others in `--out` are left as they are), `<out>/<variant>/<hash>.png` plus an `index.json` that lists the pack, the settings
// it was made with, its texture memory and its build time. The models and the runtime are not part of the repository: they are fetched by hand into `--tool`
// and `--python`'s environment, and their output stays under `out/`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../gfx/png.ts';
import type { RgbaImage } from '../gfx/types.ts';
import type { TextureRecord } from './collect.ts';
import { modelInput, resample, seamRatio, upscaleTexture } from './image-ops.ts';
import { decodePng } from './png-read.ts';

/** Textures the spot-check found worse enlarged than original (`exclude.json`: hash to reason); they stay original. */
export const EXCLUDED_FILE = fileURLToPath(new URL('./exclude.json', import.meta.url));
export function loadExcluded(file = EXCLUDED_FILE): Record<string, string> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
}

export const RELEASE = { repo: 'xinntao/Real-ESRGAN', tag: 'v0.2.5.0', asset: 'realesrgan-ncnn-vulkan-20220424-windows.zip' };
/** The model of each factor: the release's x2 model is its x4 network followed by a bicubic halving. */
export const MODELS: Record<number, string> = { 2: 'realesr-animevideov3-x2', 4: 'realesr-animevideov3-x4' };

export interface Variant {
  name: string;
  label: string;
  scale: number;
  /** Share of the model in the colour; the rest is plain bilinear. */
  blend: number;
}

export const VARIANTS: readonly Variant[] = [
  { name: 'a', label: 'x2, 50% model + 50% bilinear', scale: 2, blend: 0.5 },
  { name: 'b', label: 'x2, model only', scale: 2, blend: 1 },
  { name: 'c', label: 'x4, model only', scale: 4, blend: 1 },
  { name: 'd', label: 'x4, 75% model + 25% bilinear', scale: 4, blend: 0.75 },
];

export interface UpscaleArgs {
  dump: string;
  out: string;
  tool: string;
  python: string;
  variants?: string[];
  pad: number;
  limit?: number;
  /** Hashes left original, with the reason (default: `exclude.json`). */
  excluded?: Record<string, string>;
  log?: (line: string) => void;
}

const toolsRoot = (): string => join(homedir(), '.zelda-oot-js', 'tools');
export const defaultToolDir = (): string => join(toolsRoot(), 'realesrgan-ncnn-20220424');
export const defaultPython = (): string => join(toolsRoot(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const seconds = (since: number): number => Math.round((performance.now() - since) / 10) / 100;

/** Larger images are screen-size pictures (backgrounds), not tiles of a surface: they are left alone. */
export const MAX_SIDE = 128;
/** A texture drawn in no more graphics tasks than this may be caught half loaded (noise in part of it): left alone. */
export const MIN_FRAMES = 3;

export interface PackStats {
  textures: number;
  /** RGBA8 bytes of the textures of the pack, and of the originals they replace; with a full mip chain the sizes are 4/3 of these. */
  bytes: number;
  originalBytes: number;
  /** Seconds the model took for this pack's factor (shared by the variants of that factor), and for the rest of this variant's work. */
  modelSeconds: number;
  otherSeconds: number;
}

/** Why a dumped texture gets no replacement, or null when it does. */
export function skipReason(r: TextureRecord, excluded: Record<string, string> = {}): string | null {
  if (excluded[r.hash]) return `excluded: ${excluded[r.hash]}`;
  if (r.volatile) return 'changes from frame to frame';
  if (Math.max(r.width, r.height) > MAX_SIDE) return `screen-size image (${r.width}x${r.height})`;
  if (r.frames < MIN_FRAMES) return `seen in ${r.frames} graphics task(s) only`;
  return null;
}

export interface UpscaleResult {
  skipped: { hash: string; why: string }[];
  stats: Record<string, PackStats>;
  /**
   * Per variant: axes along which a texture wraps, and those where the replacement's seam ratio (`seamRatio`) is more than 1.5 times (plus 0.5) that of the
   * plain bilinear enlargement of the same texture, which has no seam of its own.
   */
  seams: Record<string, { wrapping: number; worse: number }>;
}

export function upscale({ dump, out, tool, python, variants: wanted, pad, limit, excluded = loadExcluded(), log = console.log }: UpscaleArgs): UpscaleResult {
  const models = join(tool, 'models');
  const variants = VARIANTS.filter((v) => !wanted || wanted.includes(v.name));
  if (!existsSync(python) || [...new Set(variants.map((v) => v.scale))].some((s) => !existsSync(join(models, `${MODELS[s]}.param`)))) {
    throw new Error(`the upscaler is not set up (${python}, ${models}): see docs/texture-pack.md`);
  }
  const index = JSON.parse(readFileSync(join(dump, 'index.json'), 'utf8')) as { textures: Record<string, TextureRecord> };
  const result: UpscaleResult = { skipped: [], stats: {}, seams: {} };
  const todo: TextureRecord[] = [];
  for (const r of Object.values(index.textures)) {
    const why = skipReason(r, excluded);
    if (why) result.skipped.push({ hash: r.hash, why });
    else todo.push(r);
  }
  if (limit !== undefined) todo.length = Math.min(todo.length, limit);

  const work = resolve(out, '..', 'texpack-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'in'), { recursive: true });
  const originals = new Map<string, RgbaImage>();
  for (const r of todo) {
    const img = decodePng(readFileSync(join(dump, `${r.hash}.png`)));
    originals.set(r.hash, img);
    const input = modelInput(img, r, pad);
    writeFileSync(join(work, 'in', `${r.hash}.png`), encodePng(input.width, input.height, input.rgba));
  }
  const originalBytes = todo.reduce((n, r) => n + r.width * r.height * 4, 0);

  const script = fileURLToPath(new URL('./model_run.py', import.meta.url));
  const raw = new Map<number, Map<string, RgbaImage>>();
  const modelSeconds = new Map<number, number>();
  for (const scale of new Set(variants.map((v) => v.scale))) {
    const dir = join(work, `out${scale}`);
    mkdirSync(dir, { recursive: true });
    log(`running ${MODELS[scale]} on ${todo.length} textures`);
    const t0 = performance.now();
    const run = spawnSync(python, ['-I', script, join(models, `${MODELS[scale]}.param`), join(models, `${MODELS[scale]}.bin`), join(work, 'in'), dir], { cwd: work, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`the upscaler failed (${run.status}): ${run.stderr.slice(-500)}`);
    modelSeconds.set(scale, seconds(t0));
    raw.set(scale, new Map(todo.map((r) => [r.hash, decodePng(readFileSync(join(dir, `${r.hash}.png`)))])));
  }
  const libs = spawnSync(python, ['-I', '-c', 'import numpy, PIL, sys; print(f"Python {sys.version.split()[0]}, numpy {numpy.__version__}, Pillow {PIL.__version__}")'], { encoding: 'utf8' }).stdout.trim();
  const files = Object.fromEntries(
    [...new Set(variants.map((v) => MODELS[v.scale]!))].flatMap((m) => readdirSync(models).filter((f) => f.startsWith(`${m}.`)).sort().map((f) => [f, sha256(join(models, f))])),
  );

  for (const v of variants) {
    const t0 = performance.now();
    const dir = join(out, v.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const textures: Record<string, { width: number; height: number }> = {};
    const seams = { wrapping: 0, worse: 0 };
    let bytes = 0;
    for (const r of todo) {
      const original = originals.get(r.hash)!;
      const big = upscaleTexture(original, r, { pad, blend: v.blend, scale: v.scale }, raw.get(v.scale)!.get(r.hash)!);
      writeFileSync(join(dir, `${r.hash}.png`), encodePng(big.width, big.height, big.rgba));
      textures[r.hash] = { width: big.width, height: big.height };
      bytes += big.width * big.height * 4;
      for (const axis of ['x', 'y'] as const) {
        if ((axis === 'x' ? r.edgeS : r.edgeT) !== 'wrap') continue;
        seams.wrapping++;
        const reference = upscaleTexture(original, r, { pad, blend: 0, scale: v.scale }, resample(modelInput(original, r, pad), v.scale, 'linear'));
        if (seamRatio(big, axis) > seamRatio(reference, axis) * 1.5 + 0.5) seams.worse++;
      }
    }
    const stats: PackStats = { textures: todo.length, bytes, originalBytes, modelSeconds: modelSeconds.get(v.scale)!, otherSeconds: seconds(t0) };
    result.stats[v.name] = stats;
    result.seams[v.name] = seams;
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      variant: v.name,
      label: v.label,
      scale: v.scale,
      model: MODELS[v.scale],
      release: `https://github.com/${RELEASE.repo}/releases/tag/${RELEASE.tag}`,
      asset: RELEASE.asset,
      runtime: `tools/tex/model_run.py on ${libs}, CPU`,
      note: 'the x2 model of the release is its x4 network followed by a bicubic halving (end of its param file)',
      files,
      settings: { scale: v.scale, pad, blend: v.blend, alpha: 'plain bicubic enlargement of the padded alpha, never through the model, left as a gradient', gray: 'kept gray' },
      stats,
      seams,
      textures,
    }, null, 1));
    log(`${v.name} (${v.label}): ${todo.length} textures, ${(bytes / 1048576).toFixed(1)} MiB (originals ${(originalBytes / 1048576).toFixed(1)} MiB), model ${stats.modelSeconds}s + ${stats.otherSeconds}s; ${seams.worse} of ${seams.wrapping} wrapping axes with a seam worse than plain bilinear's`);
  }
  const kinds = new Map<string, number>();
  for (const { why } of result.skipped) {
    const kind = why.replace(/^excluded: .*/, 'excluded').replace(/ \(.*\)/, '').replace(/\d+ graphics/, 'N graphics');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  log(`${result.skipped.length} textures left original (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')})`);
  rmSync(work, { recursive: true, force: true });
  return result;
}
