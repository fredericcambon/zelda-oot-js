// WebGL2 back end for the draw batches of tools/gfx/types.ts (produced by the interpreter in runtime/gfx/). Every colour image the game draws into is a 320x240 texture
// keyed by its address, so double buffering behaves as on the console; the depth image is one shared buffer.
import type { DecodedTexture, DisplayListResult, DrawState, LightSet, RectBatch, TriangleBatch } from '../tools/gfx/types.ts';
import { mergeRuns, type DrawRun, type Run } from './batching.ts';
import { GpuTimer } from './gpu-timer.ts';
import { flicker, frameCamera, pickLights, POINT_LIGHT_COLOR, POINT_LIGHT_GAIN, POINT_LIGHT_RADIUS, type FrameCamera, type PointLight } from './point-lights.ts';
import { Geo } from '../tools/gfx/opcodes.ts';
import { CycleType, cycleTypeOf, fragmentSource, OtherL, shiftScale, specKey, specOf, VERTEX_SHADER, type ShaderSpec } from './shader.ts';
import { MAX_SCALE, type GfxSettings } from './gfx-settings.ts';
import { texturesRead } from '../tools/tex/used.ts';
import { effectsOn, FULLSCREEN_VERTEX, occlusionOn, PostFx, type SceneDepth } from './post-fx.ts';
import { fitProjection, type ProjectionFit } from './ao.ts';
import { isLowContrast, softened } from './low-contrast.ts';
import { bindToggleKey, scaleOf, hashImage, pagePack, type TexPack } from './tex-pack.ts';

export const SCREEN_W = 320;
export const SCREEN_H = 240;

/** What to do with faces the geometry mode asks to cull. */
export type CullMode = 'normal' | 'swapped' | 'off';

export interface RenderStats {
  tasks: number;
  commands: number;
  batches: number;
  triangles: number;
  rects: number;
  /** WebGL draw calls of the last task. */
  drawCalls: number;
  /** Draw calls the last task would have needed with one per batch. */
  unmergedDrawCalls: number;
  unknown: number;
  problems: string[];
  programs: number;
  /** Milliseconds spent compiling and linking the programs so far. */
  compileMs: number;
  textures: number;
  targets: number;
  /** Draws of the last task that wanted a mip-level program and drew with the one without (the mip variant is not usable yet, or did not build). */
  mipFallbackDraws: number;
  /** Times a mip variant went from unusable to usable (once per variant: the choice does not alternate). */
  programSwitches: number;
  /** Mip variants that did not build; each is reported once and stays on the program without mip levels. */
  mipFailures: number;
  /** Textures uploaded in the last task, and over the run; every upload builds the mip levels once. */
  uploads: number;
  totalUploads: number;
  /** Only with `trackTextureBuilds`: uploads of a picture that had been uploaded before, and the most uploads of one picture. */
  reuploads: number;
  maxUploadsOfOne: number;
  /** Pixel lighting: triangles lit, those among them with normals against their face, those with vertices lit differently, and those left on the vertex path, summed over the tasks drawn so far. */
  lighting: { lit: number; reversed: number; mixed: number; vertexPath: number };
}

interface Program {
  gl: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

/** A program that has been sent to the driver and not yet checked. */
interface Building {
  program: WebGLProgram;
  stages: { shader: WebGLShader; source: string }[];
}

/** `COMPLETION_STATUS_KHR` of the KHR_parallel_shader_compile extension. */
const COMPLETION_STATUS_KHR = 0x91b1;

interface GpuTexture {
  texture: WebGLTexture;
  /** Size of the uploaded image; a replacement from the texture pack is `scale` times the size of the texture it stands for. */
  width: number;
  height: number;
  mipmapped: boolean;
  scale: number;
  /** Hash of the decoded texture, when it was looked up in the pack. */
  hash?: string;
  /** Hash of the picture a texture made from the decoded image holds; textures are shared by it (`byContent`). */
  content?: string;
  /** Decoded-image ids that use this texture. */
  refs: number;
}

interface Target {
  /** The finished image, which is what gets presented. */
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  /** With multisampling: the buffers drawn into, resolved into `texture` at the end of a task. */
  samples: { color: WebGLRenderbuffer; framebuffer: WebGLFramebuffer } | null;
  dirty: boolean;
  /** The task that last drew into this image (`Renderer.taskId`); the two flags below describe that task. */
  task: number;
  /** A depth-tested triangle draw has been made: the image holds a 3D scene. */
  hasScene: boolean;
  /** The image as it was before the first HUD draw, when there was one (see `Renderer.drawRuns`). */
  scene: { texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null;
  sceneSplit: boolean;
  /** The depth buffer as it was when the scene was complete (with the occlusion on), in the task `task`, with the projection of that task's main draws. */
  depth: { texture: WebGLTexture; framebuffer: WebGLFramebuffer; task: number; projection: ProjectionFit } | null;
}

/** What a renderer made without settings uses: no multisampling, no mip levels. */
const PLAIN: GfxSettings = { filter: 'n64', msaa: false, scaleCap: 0, mipmaps: false, anisotropy: 1, cutout: 'hard', lightingMode: 'vertex', pointLights: false, pointLightStrength: 50, ao: false, aoStrength: 0, bloom: false, bloomStrength: 0, bloomThreshold: 80, bloomKnee: 40, bloomRadius: 100, sharpen: false, sharpenStrength: 0 };
const MSAA_SAMPLES = 4;

/**
 * Whether the mip levels of a texture are the right pictures for the tile: a mask smaller than the texture repeats only part
 * of it, and a level made from the whole texture would blend that repeat with its neighbours.
 */
const mipmappable = (tile: { maskS: number; maskT: number }, tex: GpuTexture): boolean =>
  tex.mipmapped && (tile.maskS === 0 || 1 << tile.maskS === tex.width / tex.scale) && (tile.maskT === 0 || 1 << tile.maskT === tex.height / tex.scale);

/** Words per vertex: position, colour and uv, and in pixel lighting mode a fifth word of four signed bytes (normal x, y, z and 1 for a triangle lit per pixel). */
const VERTEX_WORDS = 10;
const LIT_VERTEX_WORDS = 11;
const MAX_TEXTURES = 512;
/** Texture unit that uploads bind on: units 0 and 1 hold the two tiles the combiner reads and must not be disturbed. */
const UPLOAD_UNIT = 2;

const PRESENT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uImage;
out vec4 outColor;
void main() { outColor = vec4(texture(uImage, vUv).rgb, 1.0); }
`;

const physical = (addr: number): number => addr & 0x1fffffff;

export class Renderer {
  cullMode: CullMode = 'normal';
  readonly stats: RenderStats = { tasks: 0, commands: 0, batches: 0, triangles: 0, rects: 0, drawCalls: 0, unmergedDrawCalls: 0, unknown: 0, problems: [], programs: 0, compileMs: 0, textures: 0, targets: 0, mipFallbackDraws: 0, programSwitches: 0, mipFailures: 0, uploads: 0, totalUploads: 0, reuploads: 0, maxUploadsOfOne: 0, lighting: { lit: 0, reversed: 0, mixed: 0, vertexPath: 0 } };

  private readonly gl: WebGL2RenderingContext;
  /** Called with the GPU milliseconds of each finished game frame (its task plus the presents that followed). */
  onGpuTime: ((ms: number) => void) | null = null;

  private readonly gpuTimer: GpuTimer;
  private presentGpuMs = 0;
  private readonly programs = new Map<string, Program>();
  private readonly building = new Map<string, Building>();
  private readonly parallel: boolean;
  /** Mip-level programs that may still be built on the calling thread in this task, when the browser cannot build in parallel. */
  private syncMipBudget = 0;
  /** The task from which a built mip variant is used: a variant finished while a task is drawn waits for the next, so no task draws one layer with it and another without. */
  private readonly mipUsableFrom = new Map<string, number>();
  /** Mip variants that failed to build. */
  private readonly mipFailed = new Set<string>();
  /** Counts the uploads of each picture (by its hash) for the debug overlay; off by default, hashing every upload costs. */
  trackTextureBuilds = false;
  private readonly uploadCounts = new Map<string, number>();
  private readonly presentProgram: Program;
  private readonly fx: PostFx;
  private taskId = 0;
  /** The projection of the main 3D draws of the task being drawn; null without the occlusion or without such draws. */
  private projection: ProjectionFit | null = null;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly depth: WebGLRenderbuffer;
  private scale = 1;
  private settings: GfxSettings;
  private samples = 0;
  private readonly targets = new Map<number, Target>();
  private readonly textureCache = new Map<number, GpuTexture>();
  /** Textures of the decoded images by the hash of their picture: the interpreter numbers an image afresh when its caches turn over, and the same picture must not be uploaded and have its mip levels built again. */
  private readonly byContent = new Map<string, GpuTexture>();
  private readonly white: GpuTexture;
  private lastResult: DisplayListResult | null = null;
  /** While recording (for tools/tex/compare.ts): per task, the textures it drew as `<hash><state>`, state `+` replaced, `~` in the pack but not yet loaded, `-` not in the pack. */
  private textureLog: { frames: string[][]; facts: Map<string, { width: number; height: number; fmt: number; siz: number; unloaded: number; rgba?: string }> } | null = null;
  private lastPresented: number | null = null;
  private lastTarget: Target | null = null;
  private vertices = new Float32Array(0);
  private vertexBytes = new Int8Array(0);
  private words = VERTEX_WORDS;
  /** Torches and fires of the scene (world positions), the camera of the task being drawn, the lights picked for it and the viewport of the draw in progress. */
  private pointSources: readonly PointLight[] = [];
  private camera: FrameCamera | null = null;
  private pointLights: PointLight[] = [];
  private viewportRect: [number, number, number, number] = [0, 0, 1, 1];

  /** `texPack`: the replacement textures; by default the pack the page is served with, none where there is no page to ask (the tests). */
  constructor(readonly canvas: HTMLCanvasElement, scale = 1, settings: GfxSettings = PLAIN, readonly texPack: TexPack | null = pagePack()) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.settings = { ...settings };
    this.gpuTimer = new GpuTimer(gl);
    this.fx = new PostFx(gl);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') !== null;
    this.presentProgram = this.link(FULLSCREEN_VERTEX, PRESENT_FRAGMENT);
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    this.layoutVertices();
    this.depth = gl.createRenderbuffer()!;
    this.setScale(scale);
    this.white = this.upload(1, 1, Uint8Array.of(255, 255, 255, 255), false);
    if (this.texPack) {
      this.texPack.onChange = (hash) => this.packChanged(hash);
      if (typeof addEventListener === 'function') bindToggleKey(this.texPack, globalThis);
      // The handle the screenshot tool (tools/tex/compare.ts) drives.
      Object.assign(globalThis, { ootTexPack: { pack: this.texPack, redraw: () => this.redraw(), boundsOf: (hashes: string[]) => this.boundsOf(new Set(hashes)), inUse: () => [...this.textureCache.values()].filter((t) => t.scale > 1).length, record: (on: boolean) => this.recordTextures(on), recorded: () => this.recorded() } });
    }
  }

  /** Points the vertex attributes at the buffer's layout for the lighting mode in force. */
  private layoutVertices(): void {
    const gl = this.gl;
    this.words = this.settings.lightingMode === 'pixel' || this.settings.pointLights ? LIT_VERTEX_WORDS : VERTEX_WORDS;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = this.words * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 32);
    if (this.words === LIT_VERTEX_WORDS) {
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.BYTE, false, stride, 40);
    } else {
      gl.disableVertexAttribArray(3);
      gl.vertexAttrib4f(3, 0, 0, 0, 0);
    }
  }

  /** The pack arrived, a replacement arrived (`hash`) or the switch was toggled: the textures concerned are rebuilt when next drawn. */
  private packChanged(name?: string): void {
    if (name === undefined) this.clearTextures();
    else for (const [id, tex] of this.textureCache) if (tex.hash !== undefined && this.texPack?.nameOf(tex.hash) === name) this.dropTexture(id, tex);
  }

  private recordTextures(on: boolean): void {
    this.textureLog = on ? { frames: [], facts: new Map() } : null;
  }

  private recorded(): { frames: string[][]; facts: Record<string, { width: number; height: number; fmt: number; siz: number; unloaded: number; rgba?: string }> } {
    return { frames: this.textureLog?.frames ?? [], facts: Object.fromEntries(this.textureLog?.facts ?? []) };
  }

  private logTextures(result: DisplayListResult): void {
    const log = this.textureLog!;
    const ids = new Set<number>();
    const frame: string[] = [];
    for (const b of result.batches) {
      const read = texturesRead(b.state);
      for (const [slot, image] of b.state.textures.entries()) {
        const tex = image && read[slot] && !ids.has(image.id) ? this.textureCache.get(image.id) : undefined;
        if (!image || !tex?.hash) continue;
        ids.add(image.id);
        const state = tex.scale > 1 ? '+' : this.texPack?.nameOf(tex.hash) ? '~' : '-';
        frame.push(tex.hash + state);
        const known = log.facts.get(tex.hash);
        if (!known || (state === '-' && known.rgba === undefined)) {
          log.facts.set(tex.hash, {
            width: image.width, height: image.height, fmt: image.fmt ?? 0, siz: image.siz ?? 0, unloaded: image.loaded ? image.loaded.reduce((n, v) => n + (v === 0 ? 1 : 0), 0) : 0,
            // The picture of a texture the pack has no entry for, to look at.
            rgba: state === '-' ? btoa(String.fromCharCode(...image.rgba)) : undefined,
          });
        }
      }
    }
    log.frames.push(frame);
  }

  /** Draws the last task and shows the picture it drew (not the one the video interface scans out, which is the frame before). Only valid while the game is not running: the task reads the game's memory. */
  redraw(): void {
    if (!this.lastResult) return;
    // The colour and depth images still hold the picture the task drew: left in place, depth testing would reject the redraw.
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    for (const t of this.targets.values()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.samples ? t.samples.framebuffer : t.framebuffer);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      t.dirty = true;
    }
    this.drawTask(this.lastResult);
    const drawn = this.lastResult.batches.map((b) => b.state).filter((st) => physical(st.colorImage.addr) !== physical(st.depthImage)).at(-1);
    this.present(drawn?.colorImage.addr ?? this.lastPresented ?? 0);
  }

  /**
   * The point, in canvas pixels, at the centre of the on-screen area covered by the triangles of the last task that sample a texture whose hash is in
   * `hashes` (for centring close-ups, as a box of no size); null when there is none. 3D draws only (the HUD is drawn without the depth buffer), vertices behind the eye are ignored, and so are triangles
   * centred in the corner where the minimap sits.
   */
  private boundsOf(hashes: ReadonlySet<string>): { x: number; y: number; w: number; h: number } | null {
    let sx = 0, sy = 0, total = 0;
    const { width, height } = this.canvas;
    for (const b of this.lastResult?.batches ?? []) {
      if (b.kind !== 'triangles' || (b.state.geometryMode & Geo.ZBUFFER) === 0 || !b.state.textures.some((t) => t && hashes.has(hashImage(t)))) continue;
      for (let i = 0; i + 12 <= b.positions.length; i += 12) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
        for (let k = 0; k < 3; k++) {
          const w = b.positions[i + k * 4 + 3]!;
          if (w <= 0) behind = true;
          const x = ((b.positions[i + k * 4]! * 0.5) / w * 0.5 + 0.5) * width, y = (0.5 - (b.positions[i + k * 4 + 1]! * 0.5) / w * 0.5) * height;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width, x1); y1 = Math.min(height, y1);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        if (behind || x1 <= x0 || y1 <= y0 || (cx > 0.62 * width && cy > 0.66 * height)) continue;
        const area = (x1 - x0) * (y1 - y0);
        sx += cx * area; sy += cy * area; total += area;
      }
    }
    return total > 0 ? { x: sx / total, y: sy / total, w: 0, h: 0 } : null;
  }

  /** Renders at `scale` times the 320x240 the game addresses; the colour images are dropped and redrawn by the game. */
  setScale(scale: number): void {
    const gl = this.gl;
    this.scale = Math.min(MAX_SCALE, Math.max(1, Number.isFinite(scale) ? scale : 1));
    this.canvas.width = Math.round(SCREEN_W * this.scale);
    this.canvas.height = Math.round(SCREEN_H * this.scale);
    for (const t of this.targets.values()) this.deleteTarget(t);
    this.targets.clear();
    this.fx.dispose();
    this.lastTarget = null;
    this.samples = this.settings.msaa ? this.supportedSamples() : 0;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    if (this.samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, this.canvas.width, this.canvas.height);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.canvas.width, this.canvas.height);
  }

  /** The light sources of the scene, as world positions, for the frames drawn from now on. */
  setPointSources(sources: readonly PointLight[]): void {
    this.pointSources = sources;
  }

  /** Ids of the actors the user marked as light sources (the game reads their positions for the frames drawn from now on). */
  markedLightIds: ReadonlySet<number> = new Set();

  /** Applies new options; unless only the post-processing changed, the colour images and the cached textures are dropped and rebuilt as the game draws. */
  setSettings(settings: GfxSettings): void {
    const effectsOnly = (Object.keys(settings) as (keyof GfxSettings)[]).every((k) => k === 'lightingMode' || k.startsWith('pointLight') || k.startsWith('ao') || k.startsWith('bloom') || k.startsWith('sharpen') || settings[k] === this.settings[k]);
    this.settings = { ...settings };
    this.layoutVertices();
    // The effects act at present time only: the images and textures stay.
    if (effectsOnly) return;
    this.setScale(this.scale);
    this.clearTextures();
  }

  /** The fit of the last task's main projection (see `fitProjection`); null when the occlusion is off or no draw gave one. */
  get depthProjection(): Readonly<ProjectionFit> | null {
    return this.projection;
  }

  get options(): Readonly<GfxSettings> {
    return this.settings;
  }

  get resolutionScale(): number {
    return this.scale;
  }

  /** Samples per pixel of the 3D framebuffer in use (0 without multisampling). */
  get msaaSamples(): number {
    return this.samples;
  }

  /** The largest sample count up to four that both the colour and the depth format offer, 0 when there is none. */
  private supportedSamples(): number {
    const gl = this.gl;
    const offered = (format: number): number[] => Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) ?? []);
    const depth = offered(gl.DEPTH_COMPONENT24);
    return offered(gl.RGBA8).filter((n) => n <= MSAA_SAMPLES && depth.includes(n)).sort((a, b) => b - a)[0] ?? 0;
  }

  /** Device pixels from a position in the 320x240 the game addresses. */
  private devX(x: number): number {
    return Math.round((x * this.canvas.width) / SCREEN_W);
  }

  private devY(y: number): number {
    return Math.round((y * this.canvas.height) / SCREEN_H);
  }

  /** Scissors to the rectangle with corners (x0, y0) and (x1, y1) in the 320x240 the game addresses, y down. */
  private setScissor(x0: number, y0: number, x1: number, y1: number): void {
    const left = this.devX(x0), top = this.devY(y0), bottom = this.devY(y1);
    this.gl.scissor(left, this.canvas.height - bottom, this.devX(x1) - left, bottom - top);
  }

  // ---- Frame interface ---------------------------------------------------------------------------------------------

  /** Draws the batches of one graphics task into the colour images they name. */
  drawTask(result: DisplayListResult): void {
    const s = this.stats;
    // The cache is emptied between tasks: emptying it while a draw holds two textures would delete the first one.
    if (this.textureCache.size >= MAX_TEXTURES) this.clearTextures();
    this.collectGpu();
    this.gpuTimer.begin('task');
    s.tasks++;
    this.lastResult = result;
    this.taskId++;
    this.syncMipBudget = 1;
    s.mipFallbackDraws = 0;
    s.uploads = 0;
    s.drawCalls = 0;
    s.unmergedDrawCalls = 0;
    s.commands = result.commands;
    s.batches = result.batches.length;
    s.triangles = 0;
    s.rects = 0;
    s.unknown = result.unknown.length;
    s.problems = result.problems.slice(0, 8);
    if (result.lighting) {
      s.lighting.lit += result.lighting.lit;
      s.lighting.reversed += result.lighting.reversed;
      s.lighting.mixed += result.lighting.mixed;
      s.lighting.vertexPath += result.lighting.vertexPath;
    }
    this.camera = this.settings.pointLights ? frameCamera(result.cameras) : null;
    this.pointLights = this.camera ? pickLights(this.pointSources, this.camera) : [];
    this.projection = occlusionOn(this.settings) ? fitProjection(result.batches) : null;
    try {
      this.drawRuns(mergeRuns(result.batches));
    } finally {
      this.resolveTargets();
      this.captureDepths();
      this.gpuTimer.end();
    }
    if (this.textureLog) this.logTextures(result);
    s.programs = this.programs.size;
    s.textures = this.textureCache.size;
    s.targets = this.targets.size;
  }

  /** Shows the colour image at `address` (the one the video interface scans out), or the last one drawn when unknown. */
  present(address: number): void {
    this.lastPresented = address;
    this.gpuTimer.begin('present');
    try {
      this.presentImage(address);
    } finally {
      this.gpuTimer.end();
    }
  }

  private collectGpu(): void {
    for (const { tag, ms } of this.gpuTimer.poll()) {
      if (tag === 'present') this.presentGpuMs += ms;
      else {
        this.onGpuTime?.(ms + this.presentGpuMs);
        this.presentGpuMs = 0;
      }
    }
  }

  private presentImage(address: number): void {
    const gl = this.gl;
    const target = this.targets.get(physical(address)) ?? this.lastTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!target) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    if (effectsOn(this.settings) && target.hasScene) {
      const d = target.depth && target.depth.task === target.task ? target.depth : null;
      const depth: SceneDepth | null = d && occlusionOn(this.settings) ? { texture: d.texture, a: d.projection.a, b: d.projection.b } : null;
      this.fx.run(target.sceneSplit ? target.scene!.texture : target.texture, target.sceneSplit ? target.texture : null, depth, this.canvas.width, this.canvas.height, this.settings);
      gl.bindVertexArray(this.vao);
      return;
    }
    gl.useProgram(this.presentProgram.gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this.uniform(this.presentProgram, 'uImage'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- Targets -----------------------------------------------------------------------------------------------------

  private target(address: number): Target {
    const key = physical(address);
    let t = this.targets.get(key);
    if (!t) {
      const gl = this.gl;
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      let samples: Target['samples'] = null;
      if (this.samples > 0) {
        const color = gl.createRenderbuffer()!;
        gl.bindRenderbuffer(gl.RENDERBUFFER, color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, this.canvas.width, this.canvas.height);
        const multisampled = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, multisampled);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
        samples = { color, framebuffer: multisampled };
      } else gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      t = { texture, framebuffer, samples, dirty: samples !== null, task: 0, hasScene: false, scene: null, sceneSplit: false, depth: null };
      this.targets.set(key, t);
    }
    return t;
  }

  private deleteTarget(t: Target): void {
    const gl = this.gl;
    gl.deleteTexture(t.texture);
    gl.deleteFramebuffer(t.framebuffer);
    if (t.samples) {
      gl.deleteRenderbuffer(t.samples.color);
      gl.deleteFramebuffer(t.samples.framebuffer);
    }
    if (t.scene) {
      gl.deleteTexture(t.scene.texture);
      gl.deleteFramebuffer(t.scene.framebuffer);
    }
    if (t.depth) {
      gl.deleteTexture(t.depth.texture);
      gl.deleteFramebuffer(t.depth.framebuffer);
    }
  }

  private bindTarget(address: number): void {
    const t = this.target(address);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.samples ? t.samples.framebuffer : t.framebuffer);
    t.dirty = true;
    this.lastTarget = t;
  }

  /** Copies the multisampled buffers drawn into since the last resolve into the images that get presented. */
  private resolveTargets(): void {
    if (this.samples === 0) return;
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.disable(gl.SCISSOR_TEST);
    for (const t of this.targets.values()) {
      if (!t.dirty || !t.samples) continue;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.samples.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.framebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      t.dirty = false;
    }
  }

  // ---- Batches -----------------------------------------------------------------------------------------------------

  /** Fills the vertex buffer once for the whole task, then draws each run from its slice of it. */
  private drawRuns(runs: Run[]): void {
    const counts = runs.map((run) => (run.kind === 'draw' ? run.batches.reduce((n, b) => n + (b.kind === 'triangles' ? b.positions.length / 4 : 6), 0) : 0));
    const vertices = counts.reduce((a, b) => a + b, 0);
    const v = this.scratch(vertices);
    const gl = this.gl;
    let at = 0;
    for (const run of runs) {
      if (run.kind === 'fill') continue;
      for (const b of run.batches) at = b.kind === 'triangles' ? this.writeTriangles(b, v, at) : this.writeRect(b, v, at);
    }
    if (vertices > 0) {
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, vertices * this.words), gl.STREAM_DRAW);
    }
    let first = 0;
    for (const [i, run] of runs.entries()) {
      if (run.kind === 'fill') {
        this.bindTarget(run.batch.state.colorImage.addr);
        this.fillRect(run.batch);
        continue;
      }
      const count = counts[i]!;
      this.separateScene(run);
      this.bindTarget(run.state.colorImage.addr);
      this.draw(run, first, count);
      first += count;
    }
  }

  /**
   * Splits a 3D scene from the HUD drawn over it, for the post-processing at present time (post-fx.ts). A triangle draw with the depth buffer in use
   * (`Geo.ZBUFFER`) is scene. A draw before the first of those in the task is scene too: the sky backdrop and other non-depth-tested 3D draws come first.
   * Every non-depth-tested draw after it is HUD (texture rectangles, 2D triangles, and any non-Z 3D effect drawn late, which then stays unprocessed),
   * and the first one copies the colour image, which at that point is the scene alone. Depth-tested draws after that (menu items with their own
   * depth) are HUD as well. An image with no depth-tested draw in a task (file select, some menus) holds no scene and is presented as it is; so is the
   * pause menu's backdrop, a texture drawn as 2D.
   */
  private separateScene(run: DrawRun): void {
    if (!effectsOn(this.settings)) return;
    const t = this.target(run.state.colorImage.addr);
    if (t.task !== this.taskId) {
      t.task = this.taskId;
      t.hasScene = false;
      t.sceneSplit = false;
    }
    if (run.triangles && (run.state.geometryMode & Geo.ZBUFFER) !== 0) {
      if (!t.sceneSplit) t.hasScene = true;
    } else if (t.hasScene && !t.sceneSplit) {
      this.copyScene(t);
      t.sceneSplit = true;
    }
  }

  /** An image whose scene was not followed by HUD draws holds its scene as it is at the end of the task: the depth is copied then. */
  private captureDepths(): void {
    if (!occlusionOn(this.settings)) return;
    for (const t of this.targets.values()) if (t.task === this.taskId && t.hasScene && !t.sceneSplit) this.copyDepth(t);
  }

  /**
   * Copies the depth buffer into a texture the occlusion can read. A multisampled buffer is resolved by the copy (one sample per pixel), which suits it:
   * the occlusion works on the pixels of the finished image.
   */
  private copyDepth(t: Target): void {
    const gl = this.gl;
    const projection = this.projection;
    if (!projection) return;
    const { width, height } = this.canvas;
    if (!t.depth) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
      t.depth = { texture, framebuffer, task: 0, projection };
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.samples ? t.samples.framebuffer : t.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.depth.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    t.depth.task = t.task;
    t.depth.projection = projection;
  }

  /** Copies what has been drawn into the image so far into its scene texture. */
  private copyScene(t: Target): void {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.disable(gl.SCISSOR_TEST);
    if (t.samples) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.samples.framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.framebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    if (!t.scene) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      t.scene = { texture, framebuffer };
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.scene.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (occlusionOn(this.settings)) this.copyDepth(t);
  }

  private scissorRect(state: DrawState): { x: number; y: number; w: number; h: number } {
    const sc = state.scissor;
    if (sc.xl === 0 && sc.yl === 0) return { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H };
    const x = Math.max(0, sc.xh >> 2), y = Math.max(0, sc.yh >> 2);
    return { x, y, w: Math.max(0, Math.min(SCREEN_W, sc.xl >> 2) - x), h: Math.max(0, Math.min(SCREEN_H, sc.yl >> 2) - y) };
  }

  /** Clears a rectangle of the colour image to the fill colour, or of the depth image to the far plane. */
  private fillRect(b: RectBatch): void {
    const gl = this.gl;
    const sc = this.scissorRect(b.state);
    // Corners are inclusive in fill mode.
    const x0 = Math.max(sc.x, b.xh >> 2), y0 = Math.max(sc.y, b.yh >> 2);
    const x1 = Math.min(sc.x + sc.w, (b.xl >> 2) + 1), y1 = Math.min(sc.y + sc.h, (b.yl >> 2) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    gl.enable(gl.SCISSOR_TEST);
    this.setScissor(x0, y0, x1, y1);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    if (physical(b.state.colorImage.addr) === physical(b.state.depthImage)) {
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      return;
    }
    const fill = b.state.fillColor >>> 0;
    if (b.state.colorImage.siz === 3) gl.clearColor(((fill >>> 24) & 255) / 255, ((fill >>> 16) & 255) / 255, ((fill >>> 8) & 255) / 255, 1);
    else {
      const px = fill >>> 16;
      gl.clearColor(((px >>> 11) & 31) / 31, ((px >>> 6) & 31) / 31, ((px >>> 1) & 31) / 31, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private writeTriangles(b: TriangleBatch, v: Float32Array, first: number): number {
    const n = b.positions.length / 4;
    this.stats.triangles += n / 3;
    this.stats.unmergedDrawCalls++;
    for (let i = 0; i < n; i++) {
      const o = (first + i) * this.words;
      v.set(b.positions.subarray(i * 4, i * 4 + 4), o);
      v.set(b.colors.subarray(i * 4, i * 4 + 4), o + 4);
      v[o + 8] = b.uvs[i * 2]!;
      v[o + 9] = b.uvs[i * 2 + 1]!;
      if (this.words === LIT_VERTEX_WORDS) {
        // Normal bytes are whole numbers except on vertices a clip made; those round.
        const bytes = this.vertexBytes, at = (o + VERTEX_WORDS) * 4;
        const n = b.normals;
        for (let k = 0; k < 4; k++) bytes[at + k] = n ? Math.round(n[i * 4 + k]!) : 0;
      }
    }
    return first + n;
  }

  private writeRect(b: RectBatch, v: Float32Array, first: number): number {
    this.stats.rects++;
    this.stats.unmergedDrawCalls++;
    const state = b.state;
    const copyOrFill = cycleTypeOf(state.otherModeH) >= CycleType.COPY;
    const x0 = b.xh / 4, y0 = b.yh / 4;
    const x1 = b.xl / 4 + (copyOrFill ? 1 : 0), y1 = b.yl / 4 + (copyOrFill ? 1 : 0);
    // A copy-mode rectangle steps four pixels per texel step.
    const stepS = b.dsdx / 1024 / (cycleTypeOf(state.otherModeH) === CycleType.COPY ? 4 : 1);
    const stepT = b.dtdy / 1024;
    const s0 = b.s / 32, t0 = b.t / 32;
    // Edges sit on device pixels, so neighbouring rectangles meet without a seam or a doubled row.
    const snapX = (px: number) => this.devX(px) / this.canvas.width;
    const snapY = (py: number) => this.devY(py) / this.canvas.height;
    const corner = (px: number, py: number, o: number) => {
      v[o] = snapX(px) * 2 - 1;
      v[o + 1] = 1 - snapY(py) * 2;
      v[o + 2] = 0;
      v[o + 3] = 1;
      v[o + 4] = v[o + 5] = v[o + 6] = v[o + 7] = 1;
      v[o + 8] = s0 + (px - x0) * stepS;
      v[o + 9] = t0 + (py - y0) * stepT;
    };
    const order: [number, number][] = [[x0, y0], [x1, y0], [x0, y1], [x1, y0], [x1, y1], [x0, y1]];
    order.forEach(([px, py], i) => corner(px, py, (first + i) * this.words));
    if (this.words === LIT_VERTEX_WORDS) for (let i = 0; i < 6; i++) this.vertices[(first + i) * this.words + VERTEX_WORDS] = 0;
    return first + 6;
  }

  private scratch(vertices: number): Float32Array {
    if (this.vertices.length < vertices * this.words) {
      this.vertices = new Float32Array(vertices * this.words * 2);
      this.vertexBytes = new Int8Array(this.vertices.buffer);
    }
    return this.vertices;
  }

  private draw(run: DrawRun, first: number, count: number): void {
    const gl = this.gl;
    const state = run.state;
    const cutout = this.settings.cutout === 'smooth' && this.samples > 0 && run.triangles && (state.geometryMode & Geo.ZBUFFER) !== 0;
    const spec = specOf(state, { filter: this.settings.filter, mip: this.settings.mipmaps && run.triangles, cutout, smoothTexels: this.softTextures(state), pixelLight: run.lights !== null, pointLight: run.triangles && this.pointLights.length > 0 && (state.otherModeL & OtherL.Z_UPDATE) !== 0 });
    const { program, spec: used } = this.program(spec);
    gl.useProgram(program.gl);
    this.applyRaster(state, run.triangles, used);
    this.applyUniforms(program, state, run.triangles, used.mip);
    if (used.pixelLight && run.lights) this.applyLights(program, run.lights);
    if (used.pointLight) this.applyPointLights(program);
    gl.drawArrays(gl.TRIANGLES, first, count);
    this.stats.drawCalls++;
  }

  /** Whether every texture the draw reads is a soft gradient: the 3-point filter would only cut its contours along diagonals. */
  private softTextures(state: DrawState): boolean {
    if (this.settings.filter !== 'n64' || ((state.otherModeH >>> 12) & 3) === 0) return false;
    const read = texturesRead(state);
    const used = state.textures.filter((t, i) => t && read[i]);
    return used.length > 0 && used.every((t) => isLowContrast(t!));
  }

  // ---- State -------------------------------------------------------------------------------------------------------

  private applyRaster(state: DrawState, triangles: boolean, spec: ShaderSpec): void {
    const gl = this.gl;
    // Alpha-to-coverage takes the coverage from the shader's alpha output; the target keeps its alpha of 1.
    gl.colorMask(true, true, true, !spec.cutout);
    if (spec.cutout) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    const sc = this.scissorRect(state);
    gl.enable(gl.SCISSOR_TEST);
    this.setScissor(sc.x, sc.y, sc.x + sc.w, sc.y + sc.h);

    const vp = state.viewport;
    if (triangles && vp.scale[0] !== 0 && vp.scale[1] !== 0) {
      // The viewport is twice as wide and high as the screen it maps to, around the same centre: triangles are clipped to
      // twice the screen's size (runtime/gfx/dl.c), and the vertex shader halves x and y, so that this guard band is the clip volume.
      const hw = Math.abs(vp.scale[0]) / 4, hh = Math.abs(vp.scale[1]) / 4;
      const cx = vp.trans[0] / 4, cy = vp.trans[1] / 4;
      const left = this.devX(cx - 2 * hw), top = this.devY(cy - 2 * hh), bottom = this.devY(cy + 2 * hh);
      this.viewportRect = [left, this.canvas.height - bottom, this.devX(cx + 2 * hw) - left, bottom - top];
    } else this.viewportRect = [0, 0, this.canvas.width, this.canvas.height];
    gl.viewport(...this.viewportRect);

    if (spec.framebufferBlend) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    } else gl.disable(gl.BLEND);

    const l = state.otherModeL;
    const depthOn = triangles && (state.geometryMode & Geo.ZBUFFER) !== 0;
    const compare = (l & OtherL.Z_COMPARE) !== 0, update = (l & OtherL.Z_UPDATE) !== 0;
    if (depthOn && (compare || update)) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(compare ? gl.LEQUAL : gl.ALWAYS);
      gl.depthMask(update);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    const decal = ((l >>> OtherL.ZMODE_SHIFT) & 3) === 3;
    if (decal && depthOn) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
    } else gl.disable(gl.POLYGON_OFFSET_FILL);

    const cullFront = (state.geometryMode & Geo.CULL_FRONT) !== 0, cullBack = (state.geometryMode & Geo.CULL_BACK) !== 0;
    if (triangles && this.cullMode !== 'off' && (cullFront || cullBack)) {
      gl.enable(gl.CULL_FACE);
      const swap = this.cullMode === 'swapped';
      if (cullFront && cullBack) gl.cullFace(gl.FRONT_AND_BACK);
      else gl.cullFace(cullFront !== swap ? gl.FRONT : gl.BACK);
    } else gl.disable(gl.CULL_FACE);
  }

  private applyUniforms(program: Program, state: DrawState, triangles: boolean, mip: boolean): void {
    const gl = this.gl;
    const u = (name: string) => this.uniform(program, name);
    const p = state.primColor, e = state.envColor, f = state.fogColor, bl = state.blendColor;
    gl.uniform4f(u('uPrim'), p.r / 255, p.g / 255, p.b / 255, p.a / 255);
    gl.uniform4f(u('uEnv'), e.r / 255, e.g / 255, e.b / 255, e.a / 255);
    gl.uniform4f(u('uFog'), f.r / 255, f.g / 255, f.b / 255, f.a / 255);
    gl.uniform4f(u('uBlend'), bl.r / 255, bl.g / 255, bl.b / 255, bl.a / 255);
    gl.uniform1f(u('uPrimLod'), p.lodFrac / 255);
    gl.uniform1f(u('uAniso'), this.settings.anisotropy);
    gl.uniform1f(u('uXyScale'), state.viewport.scale[0] !== 0 && state.viewport.scale[1] !== 0 && triangles ? 0.5 : 1);

    const a = new Float32Array(8), m = new Float32Array(8), c = new Float32Array(8);
    const read = texturesRead(state);
    for (let i = 0; i < 2; i++) {
      const decoded = state.textures[i];
      const tex = decoded ? this.textureFor(decoded, read[i]!) : this.white;
      const tile = decoded ? state.tiles[decoded.tile]! : null;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex.texture);
      gl.uniform1i(u(`uTex${i}`), i);
      // A replacement is sampled in its own texels: the coordinates, the tile origin and the masks' periods are scaled by its size.
      const k = tex.scale, log2k = Math.log2(k);
      a.set([tex.width, tex.height, tile ? (tile.uls / 4) * k : 0, tile ? (tile.ult / 4) * k : 0], i * 4);
      m.set(tile ? [tile.maskS ? tile.maskS + log2k : 0, tile.maskT ? tile.maskT + log2k : 0, tile.cmS, tile.cmT] : [0, 0, 0, 0], i * 4);
      c.set(tile ? [shiftScale(tile.shiftS) * k, shiftScale(tile.shiftT) * k, mip && mipmappable(tile, tex) ? 1 : 0, 0] : [1, 1, 0, 0], i * 4);
    }
    gl.uniform4fv(u('uTexA'), a);
    gl.uniform4fv(u('uTexB'), m);
    gl.uniform4fv(u('uTexC'), c);
  }

  private applyPointLights(program: Program): void {
    const gl = this.gl, camera = this.camera!;
    const seconds = performance.now() / 1000, gain = (POINT_LIGHT_GAIN * this.settings.pointLightStrength) / 50;
    const pos = new Float32Array(32), color = new Float32Array(32);
    this.pointLights.forEach((p, i) => {
      pos.set([p.x, p.y, p.z, POINT_LIGHT_RADIUS], i * 4);
      const k = gain * (p.level ?? flicker(i, seconds));
      color.set([POINT_LIGHT_COLOR[0] * k, POINT_LIGHT_COLOR[1] * k, POINT_LIGHT_COLOR[2] * k, 0], i * 4);
    });
    gl.uniformMatrix4fv(this.uniform(program, 'uInvCamera'), false, Float32Array.from(camera.inverse));
    gl.uniform3f(this.uniform(program, 'uEye'), ...camera.eye);
    gl.uniform4f(this.uniform(program, 'uViewport'), ...this.viewportRect);
    gl.uniform4fv(this.uniform(program, 'uPointPos'), pos);
    gl.uniform4fv(this.uniform(program, 'uPointColor'), color);
    gl.uniform1i(this.uniform(program, 'uPointCount'), this.pointLights.length);
    gl.uniform1i(this.uniform(program, 'uCameraSlot'), camera.slot);
  }

  private applyLights(program: Program, lights: LightSet): void {
    const gl = this.gl;
    gl.uniform3f(this.uniform(program, 'uLightAmbient'), ...lights.ambient);
    gl.uniform3fv(this.uniform(program, 'uLightColor'), lights.colors);
    gl.uniform3fv(this.uniform(program, 'uLightDir'), lights.dirs);
    gl.uniform1i(this.uniform(program, 'uLightCount'), lights.count);
  }

  // ---- Programs and textures ---------------------------------------------------------------------------------------

  /** Compiles and links without waiting for the result; `finish` checks it. */
  private start(vertex: string, fragment: string): Building {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return { shader: s, source };
    };
    const stages = [compile(gl.VERTEX_SHADER, vertex), compile(gl.FRAGMENT_SHADER, fragment)];
    const program = gl.createProgram()!;
    for (const { shader } of stages) gl.attachShader(program, shader);
    gl.linkProgram(program);
    return { program, stages };
  }

  private finish({ program, stages }: Building): Program {
    const gl = this.gl;
    for (const { shader, source } of stages) {
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader)}
${source}`);
    }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`shader link failed: ${gl.getProgramInfoLog(program)}`);
    return { gl: program, uniforms: new Map() };
  }

  private link(vertex: string, fragment: string): Program {
    return this.finish(this.start(vertex, fragment));
  }

  /**
   * The program for a spec. A mip-level program is slow to build, so until it is usable the draws use the same program without mip levels (built
   * in parallel when the browser can, else one per task). The choice is made once per task for every draw: a variant that finishes during a task is
   * used from the next one, and a variant that does not build stays on the program without mip levels for good.
   */
  private program(spec: ShaderSpec): { program: Program; spec: ShaderSpec } {
    const key = specKey(spec);
    if (spec.mip) {
      const full = this.mipFailed.has(key) ? null : this.mipProgram(spec, key);
      if (full) return { program: full, spec };
      this.stats.mipFallbackDraws++;
      return this.program({ ...spec, mip: false });
    }
    let p = this.programs.get(key);
    if (p) return { program: p, spec };
    const started = performance.now();
    p = this.link(VERTEX_SHADER, fragmentSource(spec));
    this.stats.compileMs += performance.now() - started;
    this.programs.set(key, p);
    return { program: p, spec };
  }

  /** The mip variant when it is usable in this task, else null: it is not built yet, still building, waiting for its turn, finished in this task, or failed. */
  private mipProgram(spec: ShaderSpec, key: string): Program | null {
    const gl = this.gl;
    const done = this.programs.get(key);
    if (done) return (this.mipUsableFrom.get(key) ?? 0) <= this.taskId ? done : null;
    let building = this.building.get(key);
    if (!building) {
      if (!this.parallel && this.syncMipBudget <= 0) return null;
      this.syncMipBudget--;
      const started = performance.now();
      building = this.start(VERTEX_SHADER, fragmentSource(spec));
      this.stats.compileMs += performance.now() - started;
      this.building.set(key, building);
    }
    if (this.parallel && !gl.getProgramParameter(building.program, COMPLETION_STATUS_KHR)) return null;
    this.building.delete(key);
    const started = performance.now();
    try {
      this.programs.set(key, this.finish(building));
      this.mipUsableFrom.set(key, this.taskId + 1);
      this.stats.programSwitches++;
    } catch (err) {
      this.mipFailed.add(key);
      this.stats.mipFailures++;
      console.error(`the mip-level variant of a shader did not build; its draws stay without mip levels:`, err);
    }
    this.stats.compileMs += performance.now() - started;
    return null;
  }

  private uniform(p: Program, name: string): WebGLUniformLocation | null {
    let loc = p.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(p.gl, name);
      p.uniforms.set(name, loc);
    }
    return loc;
  }

  private upload(width: number, height: number, rgba: Uint8Array | ImageBitmap, mipmaps = this.settings.mipmaps, scale = 1): GpuTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (rgba instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    return { texture, width, height, mipmapped: mipmaps, scale, refs: 1 };
  }

  private countUpload(image: DecodedTexture, replaced: boolean): void {
    this.stats.uploads++;
    this.stats.totalUploads++;
    if (!this.trackTextureBuilds) return;
    const key = hashImage(image) + (replaced ? '+pack' : '');
    const n = (this.uploadCounts.get(key) ?? 0) + 1;
    this.uploadCounts.set(key, n);
    if (n > 1) this.stats.reuploads++;
    if (n > this.stats.maxUploadsOfOne) this.stats.maxUploadsOfOne = n;
  }

  private dropTexture(id: number, tex: GpuTexture): void {
    this.textureCache.delete(id);
    if (--tex.refs > 0) return;
    this.gl.deleteTexture(tex.texture);
    if (tex.content !== undefined && this.byContent.get(tex.content) === tex) this.byContent.delete(tex.content);
  }

  private clearTextures(): void {
    for (const t of new Set(this.textureCache.values())) this.gl.deleteTexture(t.texture);
    this.textureCache.clear();
    this.byContent.clear();
  }

  /**
   * The interpreter numbers each decoded image once, so the id names the pixels and no upload repeats across tasks. `read`: the draw's combiner reads the
   * image, so the pack may replace it (see tools/tex/used.ts).
   */
  private textureFor(image: DecodedTexture, read: boolean): GpuTexture {
    let tex = this.textureCache.get(image.id);
    const pack = read && this.texPack?.available ? this.texPack : null;
    if (tex && pack && tex.hash === undefined) {
      this.dropTexture(image.id, tex);
      tex = undefined;
    }
    if (!tex) {
      const hash = pack ? hashImage(image) : undefined;
      const replacement = pack && hash ? pack.lookup(hash) : null;
      const k = replacement ? scaleOf(image, replacement) : 0;
      if (replacement && k > 0) {
        tex = this.upload(replacement.width, replacement.height, replacement, this.settings.mipmaps, k);
        this.countUpload(image, true);
      } else {
        const content = hash ?? hashImage(image);
        tex = this.byContent.get(content);
        if (tex) tex.refs++;
        else {
          tex = this.upload(image.width, image.height, this.settings.filter === 'n64' && isLowContrast(image) ? softened(image) : image.rgba);
          tex.content = content;
          this.byContent.set(content, tex);
          this.countUpload(image, false);
        }
      }
      tex.hash ??= hash;
      this.textureCache.set(image.id, tex);
    }
    return tex;
  }
}
