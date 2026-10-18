// `npm run tex -- upscale [--dump out/texdump] [--out out/texpack] [--tool <dir>] [--python <exe>] [--blend 1] [--pad 16] [--limit N]`: doubles every
// texture of the dump that is not volatile with a third-party model run locally (a Real-ESRGAN model of its official release, run by tools/tex/model_run.py
// with numpy, see docs/texture-pack.md), and writes `<out>/<hash>.png` plus `index.json`, which lists the pack and the settings it was made with. The model and
// the runtime are not part of the repository: they are fetched by hand into `--tool` and `--python`'s environment, and their output stays under `out/`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../gfx/png.ts';
import type { TextureRecord } from './collect.ts';
import { bilinear2x, modelInput, seamRatio, upscaleTexture } from './image-ops.ts';
import { decodePng } from './png-read.ts';

export const MODEL = 'realesr-animevideov3-x2';
export const RELEASE = { repo: 'xinntao/Real-ESRGAN', tag: 'v0.2.5.0', asset: 'realesrgan-ncnn-vulkan-20220424-windows.zip' };

export interface UpscaleArgs {
  dump: string;
  out: string;
  tool: string;
  python: string;
  blend: number;
  pad: number;
  limit?: number;
  log?: (line: string) => void;
}

const toolsRoot = (): string => join(homedir(), '.zelda-oot-js', 'tools');
export const defaultToolDir = (): string => join(toolsRoot(), 'realesrgan-ncnn-20220424');
export const defaultPython = (): string => join(toolsRoot(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Larger images are screen-size pictures (backgrounds), not tiles of a surface: they are left alone. */
export const MAX_SIDE = 128;
/** A texture drawn in no more graphics tasks than this may be caught half loaded (noise in part of it): left alone. */
export const MIN_FRAMES = 3;

export interface UpscaleResult {
  made: string[];
  /**
   * Axes along which a texture wraps, and those where the replacement's seam ratio (`seamRatio`) is more than 1.5 times (plus 0.5) that of the plain
   * bilinear x2 of the same texture, which has no seam of its own, with the worst such pair (`original` there is that reference).
   */
  seams: { wrapping: number; worse: number; worst: { hash: string; original: number; upscaled: number } | null };
  skipped: { hash: string; why: string }[];
}

export function upscale({ dump, out, tool, python, blend, pad, limit, log = console.log }: UpscaleArgs): UpscaleResult {
  const models = join(tool, 'models');
  if (!existsSync(python) || !existsSync(join(models, `${MODEL}.param`))) {
    throw new Error(`the upscaler is not set up (${python}, ${models}): see docs/texture-pack.md`);
  }
  const index = JSON.parse(readFileSync(join(dump, 'index.json'), 'utf8')) as { textures: Record<string, TextureRecord> };
  const all = Object.values(index.textures);
  const result: UpscaleResult = { made: [], seams: { wrapping: 0, worse: 0, worst: null }, skipped: [] };
  const todo: TextureRecord[] = [];
  for (const r of all) {
    if (r.volatile) result.skipped.push({ hash: r.hash, why: 'changes from frame to frame' });
    else if (Math.max(r.width, r.height) > MAX_SIDE) result.skipped.push({ hash: r.hash, why: `screen-size image (${r.width}x${r.height})` });
    else if (r.frames < MIN_FRAMES) result.skipped.push({ hash: r.hash, why: `seen in ${r.frames} graphics task(s) only` });
    else todo.push(r);
  }
  if (limit !== undefined) todo.length = Math.min(todo.length, limit);

  const work = resolve(out, '..', 'texpack-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'in'), { recursive: true });
  mkdirSync(join(work, 'out'), { recursive: true });
  const originals = new Map<string, { width: number; height: number; rgba: Uint8Array }>();
  for (const r of todo) {
    const img = decodePng(readFileSync(join(dump, `${r.hash}.png`)));
    originals.set(r.hash, img);
    const input = modelInput(img, r, pad);
    writeFileSync(join(work, 'in', `${r.hash}.png`), encodePng(input.width, input.height, input.rgba));
  }
  log(`running ${MODEL} on ${todo.length} textures`);
  const script = fileURLToPath(new URL('./model_run.py', import.meta.url));
  const run = spawnSync(python, ['-I', script, join(models, `${MODEL}.param`), join(models, `${MODEL}.bin`), join(work, 'in'), join(work, 'out')], { cwd: work, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`the upscaler failed (${run.status}): ${run.stderr.slice(-500)}`);
  const libs = spawnSync(python, ['-I', '-c', 'import numpy, PIL, sys; print(f"Python {sys.version.split()[0]}, numpy {numpy.__version__}, Pillow {PIL.__version__}")'], { encoding: 'utf8' }).stdout.trim();

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const textures: Record<string, { width: number; height: number }> = {};
  for (const r of todo) {
    const file = join(work, 'out', `${r.hash}.png`);
    if (!existsSync(file)) {
      result.skipped.push({ hash: r.hash, why: 'the upscaler wrote nothing' });
      continue;
    }
    const big = upscaleTexture(originals.get(r.hash)!, r, { pad, blend }, decodePng(readFileSync(file)));
    writeFileSync(join(out, `${r.hash}.png`), encodePng(big.width, big.height, big.rgba));
    textures[r.hash] = { width: big.width, height: big.height };
    for (const axis of ['x', 'y'] as const) {
      if ((axis === 'x' ? r.edgeS : r.edgeT) !== 'wrap') continue;
      result.seams.wrapping++;
      const reference = upscaleTexture(originals.get(r.hash)!, r, { pad, blend: 0 }, bilinear2x(modelInput(originals.get(r.hash)!, r, pad)));
      const original = seamRatio(reference, axis), upscaled = seamRatio(big, axis);
      if (upscaled <= original * 1.5 + 0.5) continue;
      result.seams.worse++;
      const worst = result.seams.worst;
      if (!worst || upscaled - original > worst.upscaled - worst.original) result.seams.worst = { hash: r.hash, original, upscaled };
    }
    result.made.push(r.hash);
  }
  const models_ = readdirSync(models).filter((f) => f.startsWith(MODEL)).sort();
  writeFileSync(join(out, 'index.json'), JSON.stringify({
    scale: 2,
    model: MODEL,
    release: `https://github.com/${RELEASE.repo}/releases/tag/${RELEASE.tag}`,
    asset: RELEASE.asset,
    runtime: `tools/tex/model_run.py on ${libs}, CPU`,
    note: 'the x2 model of the release is its x4 network followed by a bicubic halving (see the end of its param file)',
    files: Object.fromEntries(models_.map((f) => [f, sha256(join(models, f))])),
    settings: { scale: 2, pad, blend, alpha: 'bilinear x2 of the padded alpha, cut at 128 when the texture has only alpha 0 and 255', gray: 'kept gray' },
    seams: result.seams,
    textures,
  }, null, 1));
  const sm = result.seams;
  log(`${result.made.length} textures in ${out}; ${result.skipped.length} left original; wrap-around seam ratio over ${sm.wrapping} wrapping axes: ${sm.worse} where the replacement's seam is clearly worse than plain bilinear's${sm.worst ? ` (worst ${sm.worst.hash}: ${sm.worst.original.toFixed(2)} -> ${sm.worst.upscaled.toFixed(2)})` : ''}`);
  rmSync(work, { recursive: true, force: true });
  return result;
}
