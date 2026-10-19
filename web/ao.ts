// Screen-space ambient occlusion from the scene's depth alone: the projection fit that turns depth-buffer values into distances, and the shaders of the
// occlusion, blur and apply passes (run by post-fx.ts).
import type { Batch } from '../tools/gfx/types.ts';
import { Geo } from '../tools/gfx/opcodes.ts';
import { OtherL } from './shader.ts';

/**
 * How depth-buffer values map to distances along the view axis: with `q = 2 * depth - 1` (the clip-space z over w), `q = a + b / w`.
 * A perspective projection makes the clip-space z an affine function of w, and the vertex shader passes z and w on unchanged (shader.ts).
 */
export interface DepthProjection {
  a: number;
  b: number;
}

/** A fitted projection and the share of the vertices of the depth-tested batches with a perspective fit that were drawn under it. */
export interface ProjectionFit extends DepthProjection {
  share: number;
}

/**
 * The projection of the scene's main draws, fitted to the vertices of the depth-tested triangle batches: each batch gives a line through its nearest and
 * farthest vertex in the (1 / w, z / w) plane, and the line shared by the most vertices wins. The projection can change between draws of a frame (a
 * first-person model, a cut-scene camera, an orthographic menu), but the world, which covers most of the depth buffer, is drawn under one projection,
 * and the distances of the other draws only need to be right where they are not too far off. Batches under an orthographic projection (w constant) give
 * no line and are ignored, and so are vertices behind the eye or in front of the near plane, whose depth is clamped. Null when no batch has a line.
 */
export function fitProjection(batches: readonly Batch[]): ProjectionFit | null {
  const votes: { a: number; b: number; vertices: number }[] = [];
  let total = 0;
  for (const batch of batches) {
    if (batch.kind !== 'triangles' || (batch.state.geometryMode & Geo.ZBUFFER) === 0) continue;
    if ((batch.state.otherModeL & (OtherL.Z_COMPARE | OtherL.Z_UPDATE)) === 0) continue;
    const p = batch.positions;
    let near = -1, far = -1, wNear = Infinity, wFar = 0;
    for (let i = 0; i + 3 < p.length; i += 4) {
      const w = p[i + 3]!, z = p[i + 2]!;
      if (!(w > 0) || z < -w || z > w) continue;
      if (w < wNear) { wNear = w; near = i; }
      if (w > wFar) { wFar = w; far = i; }
    }
    if (near < 0 || wFar < wNear * 1.05) continue;
    const qNear = p[near + 2]! / wNear, qFar = p[far + 2]! / wFar;
    const b = (qNear - qFar) / (1 / wNear - 1 / wFar);
    const a = qNear - b / wNear;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) continue;
    total += p.length / 4;
    // Fits from the float vertices of one projection differ in the last digits.
    const vote = votes.find((v) => Math.abs(v.a - a) < 1e-4 && Math.abs(v.b - b) < 1e-3 * Math.abs(v.b));
    if (vote) vote.vertices += p.length / 4;
    else votes.push({ a, b, vertices: p.length / 4 });
  }
  let best: { a: number; b: number; vertices: number } | null = null;
  for (const v of votes) if (!best || v.vertices > best.vertices) best = v;
  return best ? { a: best.a, b: best.b, share: best.vertices / total } : null;
}

/** The distance along the view axis of a depth-buffer value under `projection` (the inverse of the fit above); what the shaders below compute. */
export const distanceOf = (depth: number, projection: DepthProjection): number => projection.b / (2 * depth - 1 - projection.a);

/** Samples of the occlusion pass, and the radius (in the units of w) in which a surface can occlude a point. */
export const AO_SAMPLES = 12;
export const AO_RADIUS = 60;
/** The share of the occlusion at a strength of 100. */
export const AO_GAIN = 1.5;
/**
 * Tangent of half the vertical field of view, taken as 0.6 (about 62 degrees): the display lists carry only clip-space positions, so the focal length
 * cannot be recovered from depth. It sets the shape of the reconstructed surfaces and the size of the sampling disc in pixels, nothing else.
 */
export const AO_TAN_HALF_FOV = 0.6;

const HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDepth;
uniform vec2 uProj;
uniform vec2 uTan;
`;

// The distance along the view axis of the depth texel at p; sky (the far plane, or no sensible distance) gets 1e6.
const DEPTH_FUNCTIONS = `
float distanceAt(ivec2 p) {
  ivec2 size = textureSize(uDepth, 0);
  float d = texelFetch(uDepth, clamp(p, ivec2(0), size - 1), 0).r;
  float w = uProj.y / (2.0 * d - 1.0 - uProj.x);
  return (d >= 0.99999 || !(w > 0.0)) ? 1e6 : w;
}
vec3 viewPos(ivec2 p, float w) {
  vec2 ndc = (vec2(p) + 0.5) / vec2(textureSize(uDepth, 0)) * 2.0 - 1.0;
  return vec3(ndc * uTan * w, w);
}
`;

// Writes the visibility (1 unoccluded) of each pixel of the half-size image, from the depth texel at twice its position. The normal comes from the depth
// differences to the side that is nearer in depth on each axis; the samples are a spiral in a disc around the pixel whose radius is AO_RADIUS in world
// units, turned at random per pixel (the blur removes the noise). A sample occludes in proportion to its height over the surface, fading out with distance.
export const OCCLUSION_FRAGMENT = `${HEADER}
uniform float uRadius;
${DEPTH_FUNCTIONS}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  float w = distanceAt(p);
  outColor = vec4(1.0);
  if (w >= 1e5) return;
  float wl = distanceAt(p + ivec2(-2, 0)), wr = distanceAt(p + ivec2(2, 0)), wd = distanceAt(p + ivec2(0, -2)), wu = distanceAt(p + ivec2(0, 2));
  // An edge against the sky or a far surface has no normal worth using.
  if (min(abs(wr - w), abs(w - wl)) > 0.25 * w || min(abs(wu - w), abs(w - wd)) > 0.25 * w) return;
  vec3 c = viewPos(p, w);
  vec3 dx = abs(wr - w) < abs(w - wl) ? viewPos(p + ivec2(2, 0), wr) - c : c - viewPos(p + ivec2(-2, 0), wl);
  vec3 dy = abs(wu - w) < abs(w - wd) ? viewPos(p + ivec2(0, 2), wu) - c : c - viewPos(p + ivec2(0, -2), wd);
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, c) > 0.0) n = -n;
  float height = float(textureSize(uDepth, 0).y);
  float radiusPx = clamp(uRadius * (height * 0.5 / uTan.y) / w, 3.0, height * 0.12);
  float turn = 6.2831853 * fract(52.9829189 * fract(dot(vec2(ivec2(gl_FragCoord.xy) & 3), vec2(0.06711056, 0.00583715))));
  float occlusion = 0.0;
  for (int i = 0; i < ${AO_SAMPLES}; i++) {
    float angle = turn + float(i) * 2.39996323;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(i) + 0.5) / ${AO_SAMPLES}.0) * radiusPx;
    ivec2 q = p + ivec2(round(offset));
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, textureSize(uDepth, 0)))) continue;
    float wq = distanceAt(q);
    if (wq >= 1e5) continue;
    vec3 v = viewPos(q, wq) - c;
    float len2 = dot(v, v);
    if (len2 < 1e-6) continue;
    occlusion += max(dot(n, v) * inversesqrt(len2) - 0.1, 0.0) * clamp(1.0 - len2 / (uRadius * uRadius), 0.0, 1.0);
  }
  outColor = vec4(vec3(1.0 - clamp(occlusion * 2.5 / ${AO_SAMPLES}.0, 0.0, 1.0)), 1.0);
}
`;

// One direction of a separable blur of the half-size image; a neighbour at another distance than the pixel counts for less, so the occlusion of a
// foreground object does not spread over the surface behind it.
export const BLUR_FRAGMENT = `${HEADER}
uniform sampler2D uAo;
uniform ivec2 uStep;
${DEPTH_FUNCTIONS}
void main() {
  ivec2 h = ivec2(gl_FragCoord.xy);
  float w = distanceAt(h * 2);
  float sum = texelFetch(uAo, h, 0).r, total = 1.0;
  if (w < 1e5) {
    for (int i = -4; i <= 4; i++) {
      if (i == 0) continue;
      ivec2 q = clamp(h + uStep * i, ivec2(0), textureSize(uAo, 0) - 1);
      float wq = distanceAt(q * 2);
      float weight = exp(-float(i * i) / 8.0) * exp(-abs(wq - w) / (0.03 * w));
      sum += weight * texelFetch(uAo, q, 0).r;
      total += weight;
    }
  }
  outColor = vec4(vec3(sum / total), 1.0);
}
`;

// Darkens the scene by the occlusion, which is read from the four half-size texels around the pixel, weighted by how near their distance is to the
// pixel's. Sky gets none.
export const APPLY_FRAGMENT = `${HEADER}
uniform sampler2D uScene;
uniform sampler2D uAo;
uniform float uStrength;
${DEPTH_FUNCTIONS}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(uScene, p, 0).rgb;
  float w = distanceAt(p);
  if (w < 1e5) {
    vec2 at = (vec2(p) + 0.5) * 0.5 - 0.5;
    ivec2 base = ivec2(floor(at));
    vec2 f = fract(at);
    float sum = 0.0, total = 0.0;
    for (int k = 0; k < 4; k++) {
      ivec2 q = clamp(base + ivec2(k & 1, k >> 1), ivec2(0), textureSize(uAo, 0) - 1);
      float wq = distanceAt(q * 2);
      float weight = ((k & 1) == 1 ? f.x : 1.0 - f.x) * ((k >> 1) == 1 ? f.y : 1.0 - f.y) * exp(-abs(wq - w) / (0.03 * w)) + 1e-5;
      sum += weight * texelFetch(uAo, q, 0).r;
      total += weight;
    }
    color *= 1.0 - uStrength * (1.0 - sum / total);
  }
  outColor = vec4(color, 1.0);
}
`;
