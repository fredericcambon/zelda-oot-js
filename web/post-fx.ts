// Post-processing of the 3D scene at present time: ambient occlusion (ao.ts), a bloom (bright pass, dual-filter blur chain, additive mix) and a
// contrast-adaptive sharpening, in one final pass that also puts the HUD back unchanged. The effects work on the scene image alone (see `Renderer` for
// how it is told apart from the HUD); the occlusion comes first, so the bloom and the sharpening see the darkened scene.
import { AO_GAIN, AO_RADIUS, AO_TAN_HALF_FOV, APPLY_FRAGMENT, BLUR_FRAGMENT, OCCLUSION_FRAGMENT, type DepthProjection } from './ao.ts';
import type { GfxSettings } from './gfx-settings.ts';

export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Levels of the blur chain, each half the size of the one above (the first is half the scene). */
const LEVELS = 4;
/** Share of the blurred highlights added at a bloom strength of 100. */
const BLOOM_GAIN = 1.0;
/** Weight of the neighbours in the sharpening at a strength of 100 (-0.2 is the strongest the filter stays stable at). */
const SHARPEN_WEIGHT = 0.2;

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

// Each level is half the size of the one above: the bright pass reads the scene at full size, the down passes read the level above.
const BRIGHT_FRAGMENT = `${HEADER}
uniform sampler2D uSrc;
uniform vec2 uTexel;
// Pixels below uEdge.x add nothing to the bloom and pixels above uEdge.y add everything; between them the share rises smoothly.
uniform vec2 uEdge;
vec3 bright(vec2 uv) {
  vec3 c = texture(uSrc, uv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * smoothstep(uEdge.x, uEdge.y, l);
}
void main() {
  outColor = vec4((bright(vUv + uTexel * vec2(-1.0, -1.0)) + bright(vUv + uTexel * vec2(1.0, -1.0)) + bright(vUv + uTexel * vec2(-1.0, 1.0)) + bright(vUv + uTexel * vec2(1.0, 1.0))) * 0.25, 1.0);
}
`;
const DOWN_FRAGMENT = `${HEADER}
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 sum = texture(uSrc, vUv).rgb * 4.0;
  sum += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  sum += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  outColor = vec4(sum / 8.0, 1.0);
}
`;
// Blended onto the next larger level.
const UP_FRAGMENT = `${HEADER}
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 sum = texture(uSrc, vUv + uTexel * vec2(-2.0, 0.0)).rgb + texture(uSrc, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  sum += texture(uSrc, vUv + uTexel * vec2(0.0, -2.0)).rgb + texture(uSrc, vUv + uTexel * vec2(0.0, 2.0)).rgb;
  sum += 2.0 * (texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  sum += 2.0 * (texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  outColor = vec4(sum / 12.0, 1.0);
}
`;
// uScene is the 3D scene as shown (with its occlusion); uRaw is the scene as drawn and uFinal, when uMask is set, the finished frame (scene plus HUD):
// every pixel that differs from the raw scene belongs to the HUD and is copied unchanged, so a semi-transparent HUD element keeps the unprocessed scene
// behind it.
const FINAL_FRAGMENT = `${HEADER}
uniform sampler2D uScene;
uniform sampler2D uRaw;
uniform sampler2D uFinal;
uniform sampler2D uGlow;
uniform float uBloom;
uniform float uSharp;
uniform bool uMask;
vec3 tap(ivec2 p, ivec2 size) {
  p = clamp(p, ivec2(0), size - 1);
  vec3 c = texelFetch(uScene, p, 0).rgb;
  if (uBloom > 0.0) c += uBloom * texture(uGlow, (vec2(p) + 0.5) / vec2(size)).rgb;
  return min(c, vec3(1.0));
}
void main() {
  ivec2 size = textureSize(uScene, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uMask) {
    vec3 f = texelFetch(uFinal, p, 0).rgb;
    if (any(notEqual(f, texelFetch(uRaw, p, 0).rgb))) { outColor = vec4(f, 1.0); return; }
  }
  vec3 c = tap(p, size);
  if (uSharp > 0.0) {
    vec3 a = tap(p + ivec2(0, -1), size), b = tap(p + ivec2(-1, 0), size), d = tap(p + ivec2(1, 0), size), e = tap(p + ivec2(0, 1), size);
    vec3 lo = min(c, min(min(a, b), min(d, e)));
    vec3 hi = max(c, max(max(a, b), max(d, e)));
    // The sharpening backs off where the neighbourhood is already near black or white, which keeps it from clipping.
    vec3 w = -sqrt(clamp(min(lo, 1.0 - hi) / max(hi, vec3(1e-3)), 0.0, 1.0)) * ${SHARPEN_WEIGHT.toFixed(2)} * uSharp;
    c = clamp((c + w * (a + b + d + e)) / (1.0 + 4.0 * w), 0.0, 1.0);
  }
  outColor = vec4(c, 1.0);
}
`;

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

/** The scene's depth as copied for the occlusion, and the projection that turns it into distances (see `fitProjection`). */
export interface SceneDepth extends DepthProjection {
  texture: WebGLTexture;
}

interface Level {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/** Whether `settings` ask for the ambient occlusion. */
export const occlusionOn = (settings: Pick<GfxSettings, 'ao' | 'aoStrength'>): boolean => settings.ao && settings.aoStrength > 0;

/** Whether `settings` ask for any post-processing; when not, the frame is shown by a plain copy. */
export const effectsOn = (settings: Pick<GfxSettings, 'ao' | 'aoStrength' | 'bloom' | 'sharpen' | 'bloomStrength' | 'sharpenStrength'>): boolean =>
  occlusionOn(settings) || (settings.bloom && settings.bloomStrength > 0) || (settings.sharpen && settings.sharpenStrength > 0);

export class PostFx {
  private programs: { bright: Program; down: Program; up: Program; final: Program } | null = null;
  private aoPrograms: { occlusion: Program; blur: Program; apply: Program } | null = null;
  private levels: Level[] = [];
  private levelsFor = '';
  /** The occlusion at half size (two images, for the passes of the blur) and the scene with it applied. */
  private ao: { half: [Level, Level]; lit: Level } | null = null;
  private aoFor = '';
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray()!;
  }

  /**
   * Draws `scene` to the bound canvas with the effects of `settings`. `final`: the frame with the HUD on it, when `scene` is a copy taken before the HUD was
   * drawn; null when `scene` is the whole picture. `depth`: the scene's depth, for the occlusion; null for none. Leaves the vertex array object unbound.
   */
  run(scene: WebGLTexture, final: WebGLTexture | null, depth: SceneDepth | null, width: number, height: number, settings: GfxSettings): void {
    const gl = this.gl;
    const progs = (this.programs ??= {
      bright: this.link(BRIGHT_FRAGMENT),
      down: this.link(DOWN_FRAGMENT),
      up: this.link(UP_FRAGMENT),
      final: this.link(FINAL_FRAGMENT),
    });
    const bloom = settings.bloom && settings.bloomStrength > 0;
    const raw = scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(true, true, true, true);
    if (depth && occlusionOn(settings)) scene = this.occlude(scene, depth, width, height, settings);
    if (bloom) this.blur(scene, width, height, progs, settings);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    const fin = progs.final;
    gl.useProgram(fin.program);
    this.bind(0, scene);
    this.bind(1, final ?? scene);
    this.bind(2, bloom ? this.levels[0]!.texture : scene);
    this.bind(3, raw);
    gl.uniform1i(this.uniform(fin, 'uScene'), 0);
    gl.uniform1i(this.uniform(fin, 'uFinal'), 1);
    gl.uniform1i(this.uniform(fin, 'uGlow'), 2);
    gl.uniform1i(this.uniform(fin, 'uRaw'), 3);
    gl.uniform1f(this.uniform(fin, 'uBloom'), bloom ? (settings.bloomStrength / 100) * BLOOM_GAIN : 0);
    gl.uniform1f(this.uniform(fin, 'uSharp'), settings.sharpen ? settings.sharpenStrength / 100 : 0);
    gl.uniform1i(this.uniform(fin, 'uMask'), final ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Returns `scene` darkened by the ambient occlusion of its depth: the occlusion at half size, blurred along both axes, then applied at full size. */
  private occlude(scene: WebGLTexture, depth: SceneDepth, width: number, height: number, settings: GfxSettings): WebGLTexture {
    const gl = this.gl;
    const progs = (this.aoPrograms ??= { occlusion: this.link(OCCLUSION_FRAGMENT), blur: this.link(BLUR_FRAGMENT), apply: this.link(APPLY_FRAGMENT) });
    const { half, lit } = this.allocateOcclusion(width, height);
    gl.disable(gl.BLEND);
    const pass = (program: Program, into: Level, inputs: Record<string, WebGLTexture>, set: () => void): void => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.viewport(0, 0, into.width, into.height);
      gl.useProgram(program.program);
      this.bind(0, depth.texture);
      gl.uniform1i(this.uniform(program, 'uDepth'), 0);
      gl.uniform2f(this.uniform(program, 'uProj'), depth.a, depth.b);
      gl.uniform2f(this.uniform(program, 'uTan'), AO_TAN_HALF_FOV * (width / height), AO_TAN_HALF_FOV);
      Object.entries(inputs).forEach(([name, texture], i) => {
        this.bind(1 + i, texture);
        gl.uniform1i(this.uniform(program, name), 1 + i);
      });
      set();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(progs.occlusion, half[0], {}, () => gl.uniform1f(this.uniform(progs.occlusion, 'uRadius'), AO_RADIUS));
    pass(progs.blur, half[1], { uAo: half[0].texture }, () => gl.uniform2i(this.uniform(progs.blur, 'uStep'), 1, 0));
    pass(progs.blur, half[0], { uAo: half[1].texture }, () => gl.uniform2i(this.uniform(progs.blur, 'uStep'), 0, 1));
    pass(progs.apply, lit, { uScene: scene, uAo: half[0].texture }, () => gl.uniform1f(this.uniform(progs.apply, 'uStrength'), (settings.aoStrength / 100) * AO_GAIN));
    return lit.texture;
  }

  private allocateOcclusion(width: number, height: number): NonNullable<PostFx['ao']> {
    const gl = this.gl;
    const key = `${width}x${height}`;
    if (!this.ao || key !== this.aoFor) {
      this.disposeOcclusion();
      const w = Math.ceil(width / 2), h = Math.ceil(height / 2);
      this.ao = { half: [this.level(w, h, gl.R8, gl.RED), this.level(w, h, gl.R8, gl.RED)], lit: this.level(width, height, gl.RGBA8, gl.RGBA) };
      this.aoFor = key;
    }
    return this.ao;
  }

  /** An image of 8-bit channels that is read texel by texel. */
  private level(width: number, height: number, internal: number, format: number): Level {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }

  private disposeOcclusion(): void {
    if (!this.ao) return;
    for (const l of [...this.ao.half, this.ao.lit]) {
      this.gl.deleteTexture(l.texture);
      this.gl.deleteFramebuffer(l.framebuffer);
    }
    this.ao = null;
    this.aoFor = '';
  }

  /** Fills `levels[0]` (half the scene's size) with the blurred highlights of the scene. */
  private blur(scene: WebGLTexture, width: number, height: number, progs: NonNullable<PostFx['programs']>, settings: GfxSettings): void {
    const gl = this.gl;
    this.allocate(width, height);
    // The radius is the number of levels blurred and added back, one to LEVELS.
    const used = 1 + Math.round((settings.bloomRadius / 100) * (LEVELS - 1));
    const knee = settings.bloomKnee / 100, threshold = settings.bloomThreshold / 100;
    const pass = (program: Program, src: WebGLTexture, srcW: number, srcH: number, into: Level): void => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.viewport(0, 0, into.width, into.height);
      gl.useProgram(program.program);
      this.bind(0, src);
      gl.uniform1i(this.uniform(program, 'uSrc'), 0);
      gl.uniform2f(this.uniform(program, 'uTexel'), 1 / srcW, 1 / srcH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.disable(gl.BLEND);
    gl.useProgram(progs.bright.program);
    gl.uniform2f(this.uniform(progs.bright, 'uEdge'), Math.max(0, threshold - knee / 2), Math.max(threshold + knee / 2, 0.001));
    pass(progs.bright, scene, width, height, this.levels[0]!);
    for (let i = 1; i < used; i++) pass(progs.down, this.levels[i - 1]!.texture, this.levels[i - 1]!.width, this.levels[i - 1]!.height, this.levels[i]!);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    // The texel of the upsample is half a texel of the smaller level.
    for (let i = used - 1; i > 0; i--) pass(progs.up, this.levels[i]!.texture, this.levels[i]!.width * 2, this.levels[i]!.height * 2, this.levels[i - 1]!);
    gl.disable(gl.BLEND);
  }

  private allocate(width: number, height: number): void {
    const key = `${width}x${height}`;
    if (key === this.levelsFor) return;
    this.dispose();
    const gl = this.gl;
    for (let i = 1; i <= LEVELS; i++) {
      const w = Math.max(1, width >> i), h = Math.max(1, height >> i);
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      this.levels.push({ texture, framebuffer, width: w, height: h });
    }
    this.levelsFor = key;
  }

  /** Frees the images of the passes (the size changed or the context is going away). */
  dispose(): void {
    this.disposeOcclusion();
    for (const l of this.levels) {
      this.gl.deleteTexture(l.texture);
      this.gl.deleteFramebuffer(l.framebuffer);
    }
    this.levels = [];
    this.levelsFor = '';
  }

  private bind(unit: number, texture: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }

  private uniform(p: Program, name: string): WebGLUniformLocation | null {
    let loc = p.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(p.program, name);
      p.uniforms.set(name, loc);
    }
    return loc;
  }

  private link(fragment: string): Program {
    const gl = this.gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, FULLSCREEN_VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`post-process shader compile failed: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`post-process shader link failed: ${gl.getProgramInfoLog(program)}`);
    return { program, uniforms: new Map() };
  }
}
