// WebGL2 back end for the draw batches of tools/gfx/types.ts (produced by the interpreter in runtime/gfx/). Every colour image the game draws into is a 320x240 texture
// keyed by its address, so double buffering behaves as on the console; the depth image is one shared buffer.
import type { DecodedTexture, DisplayListResult, DrawState, RectBatch, TriangleBatch } from '../tools/gfx/types.ts';
import { mergeRuns, type DrawRun, type Run } from './batching.ts';
import { GpuTimer } from './gpu-timer.ts';
import { Geo } from '../tools/gfx/opcodes.ts';
import { CycleType, cycleTypeOf, fragmentSource, OtherL, shiftScale, specKey, specOf, VERTEX_SHADER, type ShaderSpec } from './shader.ts';
import { MAX_SCALE, type GfxSettings } from './gfx-settings.ts';
import { bindToggleKey, fits, hashTexture, pagePack, type TexPack } from './tex-pack.ts';

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
}

interface Target {
  /** The finished image, which is what gets presented. */
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  /** With multisampling: the buffers drawn into, resolved into `texture` at the end of a task. */
  samples: { color: WebGLRenderbuffer; framebuffer: WebGLFramebuffer } | null;
  dirty: boolean;
}

/** What a renderer made without settings uses: no multisampling, no mip levels. */
const PLAIN: GfxSettings = { filter: 'n64', msaa: false, scaleCap: 0, mipmaps: false, anisotropy: 1 };
const MSAA_SAMPLES = 4;

/**
 * Whether the mip levels of a texture are the right pictures for the tile: a mask smaller than the texture repeats only part
 * of it, and a level made from the whole texture would blend that repeat with its neighbours.
 */
const mipmappable = (tile: { maskS: number; maskT: number }, tex: GpuTexture): boolean =>
  tex.mipmapped && (tile.maskS === 0 || 1 << tile.maskS === tex.width / tex.scale) && (tile.maskT === 0 || 1 << tile.maskT === tex.height / tex.scale);

const FLOATS_PER_VERTEX = 10;
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
const PRESENT_VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const physical = (addr: number): number => addr & 0x1fffffff;

export class Renderer {
  cullMode: CullMode = 'normal';
  readonly stats: RenderStats = { tasks: 0, commands: 0, batches: 0, triangles: 0, rects: 0, drawCalls: 0, unmergedDrawCalls: 0, unknown: 0, problems: [], programs: 0, compileMs: 0, textures: 0, targets: 0 };

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
  private readonly presentProgram: Program;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly depth: WebGLRenderbuffer;
  private scale = 1;
  private settings: GfxSettings;
  private samples = 0;
  private readonly targets = new Map<number, Target>();
  private readonly textureCache = new Map<number, GpuTexture>();
  private readonly white: GpuTexture;
  private lastResult: DisplayListResult | null = null;
  private lastPresented: number | null = null;
  private lastTarget: Target | null = null;
  private vertices = new Float32Array(0);

  /** `texPack`: the replacement textures; by default the pack the page is served with, none where there is no page to ask (the tests). */
  constructor(readonly canvas: HTMLCanvasElement, scale = 1, settings: GfxSettings = PLAIN, readonly texPack: TexPack | null = pagePack()) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.settings = { ...settings };
    this.gpuTimer = new GpuTimer(gl);
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') !== null;
    this.presentProgram = this.link(PRESENT_VERTEX, PRESENT_FRAGMENT);
    this.buffer = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 32);
    this.depth = gl.createRenderbuffer()!;
    this.setScale(scale);
    this.white = this.upload(1, 1, Uint8Array.of(255, 255, 255, 255), false);
    if (this.texPack) {
      this.texPack.onChange = (hash) => this.packChanged(hash);
      if (typeof addEventListener === 'function') bindToggleKey(this.texPack, globalThis);
      // The handle the screenshot tool (tools/tex/compare.ts) drives.
      Object.assign(globalThis, { ootTexPack: { pack: this.texPack, redraw: () => this.redraw(), inUse: () => [...this.textureCache.values()].filter((t) => t.scale > 1).length } });
    }
  }

  /** The pack arrived, a replacement arrived (`hash`) or the switch was toggled: the textures concerned are rebuilt when next drawn. */
  private packChanged(hash?: string): void {
    if (hash === undefined) this.clearTextures();
    else for (const [id, tex] of this.textureCache) if (tex.hash === hash) this.dropTexture(id, tex);
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

  /** Renders at `scale` times the 320x240 the game addresses; the colour images are dropped and redrawn by the game. */
  setScale(scale: number): void {
    const gl = this.gl;
    this.scale = Math.min(MAX_SCALE, Math.max(1, Number.isFinite(scale) ? scale : 1));
    this.canvas.width = Math.round(SCREEN_W * this.scale);
    this.canvas.height = Math.round(SCREEN_H * this.scale);
    for (const t of this.targets.values()) this.deleteTarget(t);
    this.targets.clear();
    this.lastTarget = null;
    this.samples = this.settings.msaa ? this.supportedSamples() : 0;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    if (this.samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, this.canvas.width, this.canvas.height);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.canvas.width, this.canvas.height);
  }

  /** Applies new options; the colour images and the cached textures are dropped and rebuilt as the game draws. */
  setSettings(settings: GfxSettings): void {
    this.settings = { ...settings };
    this.setScale(this.scale);
    this.clearTextures();
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
    this.syncMipBudget = 1;
    s.drawCalls = 0;
    s.unmergedDrawCalls = 0;
    s.commands = result.commands;
    s.batches = result.batches.length;
    s.triangles = 0;
    s.rects = 0;
    s.unknown = result.unknown.length;
    s.problems = result.problems.slice(0, 8);
    try {
      this.drawRuns(mergeRuns(result.batches));
    } finally {
      this.resolveTargets();
      this.gpuTimer.end();
    }
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
      t = { texture, framebuffer, samples, dirty: samples !== null };
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
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, vertices * FLOATS_PER_VERTEX), gl.STREAM_DRAW);
    }
    let first = 0;
    for (const [i, run] of runs.entries()) {
      if (run.kind === 'fill') {
        this.bindTarget(run.batch.state.colorImage.addr);
        this.fillRect(run.batch);
        continue;
      }
      const count = counts[i]!;
      this.bindTarget(run.state.colorImage.addr);
      this.draw(run, first, count);
      first += count;
    }
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
      const o = (first + i) * FLOATS_PER_VERTEX;
      v.set(b.positions.subarray(i * 4, i * 4 + 4), o);
      v.set(b.colors.subarray(i * 4, i * 4 + 4), o + 4);
      v[o + 8] = b.uvs[i * 2]!;
      v[o + 9] = b.uvs[i * 2 + 1]!;
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
    order.forEach(([px, py], i) => corner(px, py, (first + i) * FLOATS_PER_VERTEX));
    return first + 6;
  }

  private scratch(vertices: number): Float32Array {
    if (this.vertices.length < vertices * FLOATS_PER_VERTEX) this.vertices = new Float32Array(vertices * FLOATS_PER_VERTEX * 2);
    return this.vertices;
  }

  private draw(run: DrawRun, first: number, count: number): void {
    const gl = this.gl;
    const state = run.state;
    const spec = specOf(state, { filter: this.settings.filter, mip: this.settings.mipmaps && run.triangles });
    const { program, spec: used } = this.program(spec);
    gl.useProgram(program.gl);
    this.applyRaster(state, run.triangles, used);
    this.applyUniforms(program, state, run.triangles, used.mip);
    gl.drawArrays(gl.TRIANGLES, first, count);
    this.stats.drawCalls++;
  }

  // ---- State -------------------------------------------------------------------------------------------------------

  private applyRaster(state: DrawState, triangles: boolean, spec: ShaderSpec): void {
    const gl = this.gl;
    gl.colorMask(true, true, true, true);
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
      gl.viewport(left, this.canvas.height - bottom, this.devX(cx + 2 * hw) - left, bottom - top);
    } else gl.viewport(0, 0, this.canvas.width, this.canvas.height);

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
    for (let i = 0; i < 2; i++) {
      const decoded = state.textures[i];
      const tex = decoded ? this.textureFor(decoded) : this.white;
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
   * The program for a spec. A mip-level program is slow to build, so the first frames draw with the same program without mip
   * levels while the full one builds in the background (in parallel when the browser can, else one per task).
   */
  private program(spec: ShaderSpec): { program: Program; spec: ShaderSpec } {
    const key = specKey(spec);
    let p = this.programs.get(key);
    if (p) return { program: p, spec };
    if (spec.mip) {
      const full = this.mipProgram(spec, key);
      return full ? { program: full, spec } : this.program({ ...spec, mip: false });
    }
    const started = performance.now();
    p = this.link(VERTEX_SHADER, fragmentSource(spec));
    this.stats.compileMs += performance.now() - started;
    this.programs.set(key, p);
    return { program: p, spec };
  }

  /** The finished program, or null while it is still building or waits for its turn. */
  private mipProgram(spec: ShaderSpec, key: string): Program | null {
    const gl = this.gl;
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
    let p: Program;
    try {
      p = this.finish(building);
    } catch (err) {
      // A variant that does not build leaves the draws on the program without mip levels.
      console.error(err);
      p = this.program({ ...spec, mip: false }).program;
    }
    this.stats.compileMs += performance.now() - started;
    this.programs.set(key, p);
    return p;
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
    return { texture, width, height, mipmapped: mipmaps, scale };
  }

  private dropTexture(id: number, tex: GpuTexture): void {
    this.gl.deleteTexture(tex.texture);
    this.textureCache.delete(id);
  }

  private clearTextures(): void {
    for (const t of this.textureCache.values()) this.gl.deleteTexture(t.texture);
    this.textureCache.clear();
  }

  /** The interpreter numbers each decoded image once, so the id names the pixels and no upload repeats across tasks. */
  private textureFor(image: DecodedTexture): GpuTexture {
    let tex = this.textureCache.get(image.id);
    if (!tex) {
      const pack = this.texPack?.available ? this.texPack : null;
      const hash = pack ? hashTexture(image.width, image.height, image.rgba) : undefined;
      const replacement = pack && hash ? pack.lookup(hash) : null;
      tex = replacement && fits(image, replacement)
        ? this.upload(replacement.width, replacement.height, replacement, this.settings.mipmaps, replacement.width / image.width)
        : this.upload(image.width, image.height, image.rgba);
      tex.hash = hash;
      this.textureCache.set(image.id, tex);
    }
    return tex;
  }
}
