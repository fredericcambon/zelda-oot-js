// WebGL2 back end for the draw batches of tools/gfx/dl.ts. Every colour image the game draws into is a 320x240 texture
// keyed by its address, so double buffering behaves as on the console; the depth image is one shared buffer.
import type { Batch, DecodedTexture, DisplayListResult, DrawState, RectBatch, TriangleBatch } from '../tools/gfx/dl.ts';
import { Geo } from '../tools/gfx/opcodes.ts';
import { CycleType, cycleTypeOf, fragmentSource, OtherL, shiftScale, specKey, specOf, VERTEX_SHADER, type ShaderSpec } from './shader.ts';

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
  unknown: number;
  problems: string[];
  programs: number;
  textures: number;
  targets: number;
}

interface Program {
  gl: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface GpuTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

const FLOATS_PER_VERTEX = 11;
const MAX_TEXTURES = 512;

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
  readonly stats: RenderStats = { tasks: 0, commands: 0, batches: 0, triangles: 0, rects: 0, unknown: 0, problems: [], programs: 0, textures: 0, targets: 0 };

  private readonly gl: WebGL2RenderingContext;
  private readonly programs = new Map<string, Program>();
  private readonly presentProgram: Program;
  private readonly buffer: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly depth: WebGLRenderbuffer;
  private readonly targets = new Map<number, Target>();
  private readonly textureCache = new Map<string, GpuTexture>();
  private textureByImage = new WeakMap<Uint8Array, GpuTexture>();
  private readonly white: GpuTexture;
  private lastTarget: Target | null = null;
  private vertices = new Float32Array(0);

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
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
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 40);
    this.depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, SCREEN_W, SCREEN_H);
    this.white = this.upload(1, 1, Uint8Array.of(255, 255, 255, 255));
  }

  // ---- Frame interface ---------------------------------------------------------------------------------------------

  /** Draws the batches of one graphics task into the colour images they name. */
  drawTask(result: DisplayListResult): void {
    const s = this.stats;
    s.tasks++;
    s.commands = result.commands;
    s.batches = result.batches.length;
    s.triangles = 0;
    s.rects = 0;
    s.unknown = result.unknown.length;
    s.problems = result.problems.slice(0, 8);
    for (const batch of result.batches) this.drawBatch(batch);
    s.programs = this.programs.size;
    s.textures = this.textureCache.size;
    s.targets = this.targets.size;
  }

  /** Shows the colour image at `address` (the one the video interface scans out), or the last one drawn when unknown. */
  present(address: number): void {
    const gl = this.gl;
    const target = this.targets.get(physical(address)) ?? this.lastTarget;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, SCREEN_W, SCREEN_H);
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
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SCREEN_W, SCREEN_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      t = { texture, framebuffer };
      this.targets.set(key, t);
    }
    return t;
  }

  private bindTarget(address: number): void {
    const t = this.target(address);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.framebuffer);
    this.lastTarget = t;
  }

  // ---- Batches -----------------------------------------------------------------------------------------------------

  private drawBatch(batch: Batch): void {
    const state = batch.state;
    this.bindTarget(state.colorImage.addr);
    if (batch.kind === 'triangles') this.drawTriangles(batch);
    else if (batch.kind === 'fillrect' && cycleTypeOf(state.otherModeH) === CycleType.FILL) this.fillRect(batch);
    else this.drawRect(batch);
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
    gl.scissor(x0, SCREEN_H - y1, x1 - x0, y1 - y0);
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

  private drawTriangles(b: TriangleBatch): void {
    const n = b.positions.length / 4;
    if (n === 0) return;
    this.stats.triangles += n / 3;
    const v = this.scratch(n);
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_VERTEX;
      v.set(b.positions.subarray(i * 4, i * 4 + 4), o);
      v.set(b.colors.subarray(i * 4, i * 4 + 4), o + 4);
      v[o + 8] = b.uvs[i * 2]!;
      v[o + 9] = b.uvs[i * 2 + 1]!;
      v[o + 10] = b.fog[i]!;
    }
    this.draw(b.state, n, true);
  }

  private drawRect(b: RectBatch): void {
    this.stats.rects++;
    const state = b.state;
    const copyOrFill = cycleTypeOf(state.otherModeH) >= CycleType.COPY;
    const x0 = b.xh / 4, y0 = b.yh / 4;
    const x1 = b.xl / 4 + (copyOrFill ? 1 : 0), y1 = b.yl / 4 + (copyOrFill ? 1 : 0);
    // A copy-mode rectangle steps four pixels per texel step.
    const stepS = b.dsdx / 1024 / (cycleTypeOf(state.otherModeH) === CycleType.COPY ? 4 : 1);
    const stepT = b.dtdy / 1024;
    const s0 = b.s / 32, t0 = b.t / 32;
    const corner = (px: number, py: number, o: number, v: Float32Array) => {
      v[o] = (px / SCREEN_W) * 2 - 1;
      v[o + 1] = 1 - (py / SCREEN_H) * 2;
      v[o + 2] = 0;
      v[o + 3] = 1;
      v[o + 4] = v[o + 5] = v[o + 6] = v[o + 7] = 1;
      v[o + 8] = s0 + (px - x0) * stepS;
      v[o + 9] = t0 + (py - y0) * stepT;
      v[o + 10] = 0;
    };
    const v = this.scratch(6);
    const order: [number, number][] = [[x0, y0], [x1, y0], [x0, y1], [x1, y0], [x1, y1], [x0, y1]];
    order.forEach(([px, py], i) => corner(px, py, i * FLOATS_PER_VERTEX, v));
    this.draw(state, 6, false);
  }

  private scratch(vertices: number): Float32Array {
    if (this.vertices.length < vertices * FLOATS_PER_VERTEX) this.vertices = new Float32Array(vertices * FLOATS_PER_VERTEX * 2);
    return this.vertices;
  }

  private draw(state: DrawState, count: number, triangles: boolean): void {
    const gl = this.gl;
    const spec = specOf(state);
    const program = this.program(spec);
    gl.useProgram(program.gl);
    this.applyRaster(state, triangles, spec);
    this.applyUniforms(program, state);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, count * FLOATS_PER_VERTEX), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  // ---- State -------------------------------------------------------------------------------------------------------

  private applyRaster(state: DrawState, triangles: boolean, spec: ShaderSpec): void {
    const gl = this.gl;
    gl.colorMask(true, true, true, true);
    const sc = this.scissorRect(state);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sc.x, SCREEN_H - sc.y - sc.h, sc.w, sc.h);

    const vp = state.viewport;
    if (triangles && vp.scale[0] !== 0 && vp.scale[1] !== 0) {
      const hw = Math.abs(vp.scale[0]) / 4, hh = Math.abs(vp.scale[1]) / 4;
      const cx = vp.trans[0] / 4, cy = vp.trans[1] / 4;
      gl.viewport(Math.round(cx - hw), Math.round(SCREEN_H - (cy + hh)), Math.round(hw * 2), Math.round(hh * 2));
    } else gl.viewport(0, 0, SCREEN_W, SCREEN_H);

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

  private applyUniforms(program: Program, state: DrawState): void {
    const gl = this.gl;
    const u = (name: string) => this.uniform(program, name);
    const p = state.primColor, e = state.envColor, f = state.fogColor, bl = state.blendColor;
    gl.uniform4f(u('uPrim'), p.r / 255, p.g / 255, p.b / 255, p.a / 255);
    gl.uniform4f(u('uEnv'), e.r / 255, e.g / 255, e.b / 255, e.a / 255);
    gl.uniform4f(u('uFog'), f.r / 255, f.g / 255, f.b / 255, f.a / 255);
    gl.uniform4f(u('uBlend'), bl.r / 255, bl.g / 255, bl.b / 255, bl.a / 255);
    gl.uniform1f(u('uPrimLod'), p.lodFrac / 255);

    const a = new Float32Array(8), m = new Float32Array(8), c = new Float32Array(8);
    for (let i = 0; i < 2; i++) {
      const decoded = state.textures[i];
      const tex = decoded ? this.textureFor(decoded) : this.white;
      const tile = decoded ? state.tiles[decoded.tile]! : null;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex.texture);
      gl.uniform1i(u(`uTex${i}`), i);
      a.set([tex.width, tex.height, tile ? tile.uls / 4 : 0, tile ? tile.ult / 4 : 0], i * 4);
      m.set(tile ? [tile.maskS, tile.maskT, tile.cmS, tile.cmT] : [0, 0, 0, 0], i * 4);
      c.set(tile ? [shiftScale(tile.shiftS), shiftScale(tile.shiftT), 0, 0] : [1, 1, 0, 0], i * 4);
    }
    gl.uniform4fv(u('uTexA'), a);
    gl.uniform4fv(u('uTexB'), m);
    gl.uniform4fv(u('uTexC'), c);
  }

  // ---- Programs and textures ---------------------------------------------------------------------------------------

  private link(vertex: string, fragment: string): Program {
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}\n${source}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`shader link failed: ${gl.getProgramInfoLog(program)}`);
    return { gl: program, uniforms: new Map() };
  }

  private program(spec: ShaderSpec): Program {
    const key = specKey(spec);
    let p = this.programs.get(key);
    if (!p) {
      p = this.link(VERTEX_SHADER, fragmentSource(spec));
      this.programs.set(key, p);
    }
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

  private upload(width: number, height: number, rgba: Uint8Array): GpuTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { texture, width, height };
  }

  /** Decoded textures are rebuilt for every task, so they are shared by content. */
  private textureFor(image: DecodedTexture): GpuTexture {
    const hit = this.textureByImage.get(image.rgba);
    if (hit) return hit;
    let h = 0x811c9dc5 ^ (image.width * 65537 + image.height);
    for (let i = 0; i < image.rgba.length; i++) h = Math.imul(h ^ image.rgba[i]!, 0x01000193);
    const key = `${image.width}x${image.height}:${h >>> 0}`;
    let tex = this.textureCache.get(key);
    if (!tex) {
      if (this.textureCache.size >= MAX_TEXTURES) {
        for (const t of this.textureCache.values()) this.gl.deleteTexture(t.texture);
        this.textureCache.clear();
        this.textureByImage = new WeakMap();
      }
      tex = this.upload(image.width, image.height, image.rgba);
      this.textureCache.set(key, tex);
    }
    this.textureByImage.set(image.rgba, tex);
    return tex;
  }
}
