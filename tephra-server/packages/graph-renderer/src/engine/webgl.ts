/**
 * WebGL2 draw backend for the graph engine (plan 018, lane B).
 *
 * Draws a {@link SceneFrame} with at most four instanced draw calls per
 * frame, in order: edges → nodes → rings → arrows. Browser-only (needs a DOM
 * canvas), zero dependencies.
 *
 * Data flow:
 * - Node world positions and radii are packed into one RGBA32F texture
 *   (`x, y, r, 0` per texel, {@link NODE_TEXTURE_WIDTH} texels per row) and
 *   uploaded once per frame with `texSubImage2D`. Every pass reads node data
 *   in the vertex shader with `texelFetch`, so edges only carry their
 *   `(source, target)` index pair as a `uvec2` instance attribute. That pair
 *   is diffed against a shadow copy on the CPU and only re-uploaded when the
 *   topology changes; positions are uploaded once (N texels) instead of once
 *   per edge endpoint (2E vertices).
 * - The camera transform (`screen = world * k + offset`, then `* dpr`) runs
 *   in the vertex shaders from uniforms; the CPU never transforms positions.
 * - Colours and edge widths are streamed per frame with the WebGL2
 *   `bufferSubData(target, dstOffset, src, srcOffset, length)` overload, so
 *   no typed-array views are allocated. GPU buffers and CPU scratch arrays
 *   grow geometrically ({@link growCapacity}) and are never reallocated when
 *   the size is unchanged.
 * - Shaders output premultiplied alpha; blending is `ONE, ONE_MINUS_SRC_ALPHA`
 *   onto a transparent clear.
 */

import type { DrawBackend, SceneFrame } from './types';

/** Texels per row of the node data texture. */
export const NODE_TEXTURE_WIDTH = 1024;
/** Floats per node texel (`x, y, r, 0`). */
const TEXEL_FLOATS = 4;
/** Minimum element capacity for growable buffers. */
const MIN_CAPACITY = 64;

// Attribute locations (fixed with `layout(location = N)` in the shaders).
const LOC_CORNER = 0;
const LOC_ENDS = 1;
const LOC_COLOR = 2;
const LOC_WIDTH = 3;
const LOC_INDEX = 1;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests; no DOM / GL access).
// ---------------------------------------------------------------------------

/**
 * Geometric growth: the smallest power-of-two multiple of `current` (at least
 * `min`) that fits `required`. Returns `current` unchanged when it already
 * fits, so callers can compare against it to decide whether to reallocate.
 */
export function growCapacity(current: number, required: number, min = MIN_CAPACITY): number {
  if (required <= current) return current;
  let cap = Math.max(current, min, 1);
  while (cap < required) cap *= 2;
  return cap;
}

/** Arrow head size in CSS px for zoom `k`: `clamp(6k, 4, 12)`. */
export function arrowSize(k: number): number {
  return Math.min(12, Math.max(4, 6 * k));
}

/**
 * Pack node positions/radii into texel scratch `out` (`x, y, r, 0` per node).
 * `out` must hold at least `count * 4` floats.
 */
export function packNodeTexels(
  x: Float32Array,
  y: Float32Array,
  radius: Float32Array,
  count: number,
  out: Float32Array,
): void {
  for (let i = 0, o = 0; i < count; i++, o += TEXEL_FLOATS) {
    out[o] = x[i] ?? 0;
    out[o + 1] = y[i] ?? 0;
    out[o + 2] = radius[i] ?? 0;
    out[o + 3] = 0;
  }
}

/** Texture rows needed to hold `count` node texels. */
export function nodeTextureRows(count: number, width = NODE_TEXTURE_WIDTH): number {
  return Math.max(1, Math.ceil(count / width));
}

/**
 * Write the indices of ringed nodes (`ring[i] === 1`) into `out` and return
 * how many were written. `out` must hold at least `count` entries.
 */
export function compactRingIndices(ring: Uint8Array, count: number, out: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (ring[i] === 1) out[n++] = i;
  }
  return n;
}

/**
 * Interleave edge endpoints into `shadow` (`s0, t0, s1, t1, …`) and report
 * whether any of the first `count` pairs changed. `shadow` must hold at
 * least `count * 2` entries.
 */
export function syncEdgeEndpoints(
  source: Uint32Array,
  target: Uint32Array,
  count: number,
  shadow: Uint32Array,
): boolean {
  let changed = false;
  for (let i = 0, o = 0; i < count; i++, o += 2) {
    const s = source[i] ?? 0;
    const t = target[i] ?? 0;
    if (shadow[o] !== s || shadow[o + 1] !== t) {
      shadow[o] = s;
      shadow[o + 1] = t;
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VS_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define TEX_W ${NODE_TEXTURE_WIDTH}
uniform sampler2D u_nodes;
uniform float u_k;
uniform vec2 u_offset;
uniform float u_dpr;
uniform vec2 u_resolution;
const vec4 OFFSCREEN = vec4(-2.0, -2.0, 0.0, 1.0);
vec4 nodeAt(uint i) {
  int ii = int(i);
  return texelFetch(u_nodes, ivec2(ii % TEX_W, ii / TEX_W), 0);
}
vec2 toDevice(vec2 w) { return (w * u_k + u_offset) * u_dpr; }
vec4 toClip(vec2 d) {
  vec2 c = d / u_resolution * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
float cssRadius(float r) { return max(1.0, r * u_k); }
`;

const EDGE_VS = `${VS_COMMON}
layout(location = ${LOC_CORNER}) in vec2 a_corner; // x: 0..1 along, y: -1..1 across
layout(location = ${LOC_ENDS}) in uvec2 a_ends;
layout(location = ${LOC_COLOR}) in vec4 a_color;
layout(location = ${LOC_WIDTH}) in float a_width;
out vec4 v_color;
out float v_across;
out float v_half;
void main() {
  vec2 a = toDevice(nodeAt(a_ends.x).xy);
  vec2 b = toDevice(nodeAt(a_ends.y).xy);
  vec2 d = b - a;
  float len = length(d);
  if (a_ends.x == a_ends.y || len < 1e-4) { gl_Position = OFFSCREEN; return; }
  vec2 n = vec2(-d.y, d.x) / len;
  float halfCore = max(a_width * u_dpr, 0.0) * 0.5;
  float extent = halfCore + 1.0;
  v_across = a_corner.y * extent;
  v_half = halfCore;
  v_color = a_color;
  gl_Position = toClip(mix(a, b, a_corner.x) + n * v_across);
}
`;

const EDGE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_across;
in float v_half;
out vec4 o_color;
void main() {
  float cov = clamp(v_half + 0.5 - abs(v_across), 0.0, 1.0);
  float a = v_color.a * cov;
  o_color = vec4(v_color.rgb * a, a);
}
`;

const NODE_VS = `${VS_COMMON}
layout(location = ${LOC_CORNER}) in vec2 a_corner; // -1..1 square
layout(location = ${LOC_COLOR}) in vec4 a_color;
out vec4 v_color;
out vec2 v_local;
out float v_radius;
void main() {
  vec4 node = nodeAt(uint(gl_InstanceID));
  float r = cssRadius(node.z) * u_dpr;
  v_local = a_corner * (r + 1.0);
  v_radius = r;
  v_color = a_color;
  gl_Position = toClip(toDevice(node.xy) + v_local);
}
`;

const NODE_FS = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
in float v_radius;
out vec4 o_color;
void main() {
  float cov = clamp(v_radius + 0.5 - length(v_local), 0.0, 1.0);
  float a = v_color.a * cov;
  if (a <= 0.0) discard;
  o_color = vec4(v_color.rgb * a, a);
}
`;

const RING_VS = `${VS_COMMON}
layout(location = ${LOC_CORNER}) in vec2 a_corner;
layout(location = ${LOC_INDEX}) in uint a_index;
out vec2 v_local;
out float v_radius;
out float v_half;
void main() {
  vec4 node = nodeAt(a_index);
  float r = (cssRadius(node.z) + 3.0) * u_dpr;
  float hw = u_dpr; // 2 CSS px stroke => 1 CSS px half-width
  v_local = a_corner * (r + hw + 1.0);
  v_radius = r;
  v_half = hw;
  gl_Position = toClip(toDevice(node.xy) + v_local);
}
`;

const RING_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
in vec2 v_local;
in float v_radius;
in float v_half;
out vec4 o_color;
void main() {
  float cov = clamp(v_half + 0.5 - abs(length(v_local) - v_radius), 0.0, 1.0);
  float a = u_color.a * cov;
  if (a <= 0.0) discard;
  o_color = vec4(u_color.rgb * a, a);
}
`;

const ARROW_VS = `${VS_COMMON}
layout(location = ${LOC_CORNER}) in vec2 a_corner; // (along, across) in units of size
layout(location = ${LOC_ENDS}) in uvec2 a_ends;
layout(location = ${LOC_COLOR}) in vec4 a_color;
uniform float u_arrowSize;
out vec4 v_color;
void main() {
  vec4 t = nodeAt(a_ends.y);
  vec2 a = toDevice(nodeAt(a_ends.x).xy);
  vec2 b = toDevice(t.xy);
  vec2 d = b - a;
  float len = length(d);
  if (a_ends.x == a_ends.y || len < 1e-4) { gl_Position = OFFSCREEN; return; }
  vec2 dir = d / len;
  vec2 n = vec2(-dir.y, dir.x);
  vec2 tip = b - dir * (cssRadius(t.z) + 2.0) * u_dpr;
  float s = u_arrowSize * u_dpr;
  v_color = a_color;
  gl_Position = toClip(tip + dir * (a_corner.x * s) + n * (a_corner.y * s));
}
`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 o_color;
void main() {
  o_color = vec4(v_color.rgb * v_color.a, v_color.a);
}
`;

// Static geometry. Quads are triangle strips.
const EDGE_QUAD = new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]);
const SQUARE_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const ARROW_TRI = new Float32Array([0, 0, -1, 0.5, -1, -0.5]);

// ---------------------------------------------------------------------------
// GL plumbing
// ---------------------------------------------------------------------------

interface Uniforms {
  nodes: WebGLUniformLocation | null;
  k: WebGLUniformLocation | null;
  offset: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  resolution: WebGLUniformLocation | null;
  extra: WebGLUniformLocation | null;
}

interface Program {
  program: WebGLProgram;
  u: Uniforms;
}

/** A GPU buffer with geometric growth (capacity in bytes). */
interface GrowBuffer {
  buffer: WebGLBuffer;
  bytes: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  extraUniform: string | null,
): Program | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = vs && fs ? gl.createProgram() : null;
  if (!vs || !fs || !program) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return {
    program,
    u: {
      nodes: gl.getUniformLocation(program, 'u_nodes'),
      k: gl.getUniformLocation(program, 'u_k'),
      offset: gl.getUniformLocation(program, 'u_offset'),
      dpr: gl.getUniformLocation(program, 'u_dpr'),
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      extra: extraUniform ? gl.getUniformLocation(program, extraUniform) : null,
    },
  };
}

/**
 * Create a WebGL2 backend with its own absolutely-positioned canvas, or
 * return null when WebGL2 (or shader compilation) is unavailable — e.g.
 * under jsdom or on old browsers — so the caller can fall back to Canvas2D.
 */
export function createWebGLBackend(): DrawBackend | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';

  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', {
      antialias: true,
      premultipliedAlpha: true,
      alpha: true,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  try {
    return initBackend(canvas, gl);
  } catch {
    loseContext(gl);
    return null;
  }
}

function loseContext(gl: WebGL2RenderingContext): void {
  try {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // Best effort only.
  }
}

function initBackend(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): DrawBackend | null {
  const edgeProg = linkProgram(gl, EDGE_VS, EDGE_FS, null);
  const nodeProg = linkProgram(gl, NODE_VS, NODE_FS, null);
  const ringProg = linkProgram(gl, RING_VS, RING_FS, 'u_color');
  const arrowProg = linkProgram(gl, ARROW_VS, SOLID_FS, 'u_arrowSize');
  const programs = [edgeProg, nodeProg, ringProg, arrowProg];
  if (!edgeProg || !nodeProg || !ringProg || !arrowProg) {
    for (const p of programs) if (p) gl.deleteProgram(p.program);
    loseContext(gl);
    return null;
  }

  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  const mkBuffer = (): WebGLBuffer => {
    const b = gl.createBuffer();
    if (!b) throw new Error('createBuffer failed');
    buffers.push(b);
    return b;
  };
  const mkVao = (): WebGLVertexArrayObject => {
    const v = gl.createVertexArray();
    if (!v) throw new Error('createVertexArray failed');
    vaos.push(v);
    return v;
  };
  const staticBuffer = (data: Float32Array): WebGLBuffer => {
    const b = mkBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  };
  const growBuffer = (): GrowBuffer => ({ buffer: mkBuffer(), bytes: 0 });

  const edgeQuad = staticBuffer(EDGE_QUAD);
  const squareQuad = staticBuffer(SQUARE_QUAD);
  const arrowTri = staticBuffer(ARROW_TRI);
  const edgeEnds = growBuffer();
  const edgeColor = growBuffer();
  const edgeWidth = growBuffer();
  const nodeColor = growBuffer();
  const ringIndex = growBuffer();

  const texture = gl.createTexture();
  if (!texture) throw new Error('createTexture failed');
  let textureRows = 0;

  // CPU scratch (grown geometrically, never per frame).
  let texels = new Float32Array(0);
  let endsShadow = new Uint32Array(0);
  let ringScratch = new Uint32Array(0);
  let endsForceUpload = true;

  const attrib = (
    loc: number,
    buffer: WebGLBuffer,
    size: number,
    divisor: number,
    integer = false,
  ): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    if (integer) gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_INT, 0, 0);
    else gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, divisor);
  };

  const edgeVao = mkVao();
  gl.bindVertexArray(edgeVao);
  attrib(LOC_CORNER, edgeQuad, 2, 0);
  attrib(LOC_ENDS, edgeEnds.buffer, 2, 1, true);
  attrib(LOC_COLOR, edgeColor.buffer, 4, 1);
  attrib(LOC_WIDTH, edgeWidth.buffer, 1, 1);

  const nodeVao = mkVao();
  gl.bindVertexArray(nodeVao);
  attrib(LOC_CORNER, squareQuad, 2, 0);
  attrib(LOC_COLOR, nodeColor.buffer, 4, 1);

  const ringVao = mkVao();
  gl.bindVertexArray(ringVao);
  attrib(LOC_CORNER, squareQuad, 2, 0);
  attrib(LOC_INDEX, ringIndex.buffer, 1, 1, true);

  const arrowVao = mkVao();
  gl.bindVertexArray(arrowVao);
  attrib(LOC_CORNER, arrowTri, 2, 0);
  attrib(LOC_ENDS, edgeEnds.buffer, 2, 1, true);
  attrib(LOC_COLOR, edgeColor.buffer, 4, 1);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  /** Ensure `gb` holds `bytes`; returns true if it was reallocated. */
  const ensure = (gb: GrowBuffer, bytes: number): boolean => {
    const next = growCapacity(gb.bytes, bytes, MIN_CAPACITY * 16);
    if (next === gb.bytes) return false;
    gl.bindBuffer(gl.ARRAY_BUFFER, gb.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, next, gl.DYNAMIC_DRAW);
    gb.bytes = next;
    return true;
  };

  let lost = false;
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);

  let destroyed = false;

  const setCommonUniforms = (p: Program, f: SceneFrame): void => {
    gl.useProgram(p.program);
    gl.uniform1i(p.u.nodes, 0);
    gl.uniform1f(p.u.k, f.camera.k);
    gl.uniform2f(p.u.offset, f.camera.x, f.camera.y);
    gl.uniform1f(p.u.dpr, f.dpr);
    gl.uniform2f(p.u.resolution, Math.max(1, canvas.width), Math.max(1, canvas.height));
  };

  const uploadNodes = (f: SceneFrame): void => {
    const n = f.nodeCount;
    const rows = nodeTextureRows(n);
    const floats = rows * NODE_TEXTURE_WIDTH * TEXEL_FLOATS;
    if (texels.length < floats) {
      texels = new Float32Array(growCapacity(texels.length, floats, NODE_TEXTURE_WIDTH * 4));
    }
    packNodeTexels(f.x, f.y, f.radius, n, texels);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (rows > textureRows) {
      textureRows = growCapacity(textureRows, rows, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        NODE_TEXTURE_WIDTH,
        textureRows,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
    }
    if (n > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        NODE_TEXTURE_WIDTH,
        rows,
        gl.RGBA,
        gl.FLOAT,
        texels,
        0,
      );
    }
    ensure(nodeColor, n * 16);
    if (n > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, nodeColor.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.nodeRGBA, 0, n * 4);
    }
  };

  const uploadEdges = (f: SceneFrame): void => {
    const e = f.edgeCount;
    if (e === 0) return;
    if (endsShadow.length < e * 2) {
      const next = new Uint32Array(growCapacity(endsShadow.length, e * 2));
      next.set(endsShadow);
      endsShadow = next;
    }
    if (ensure(edgeEnds, endsShadow.byteLength)) endsForceUpload = true;
    const changed = syncEdgeEndpoints(f.edgeSource, f.edgeTarget, e, endsShadow);
    if (changed || endsForceUpload) {
      gl.bindBuffer(gl.ARRAY_BUFFER, edgeEnds.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, endsShadow, 0, e * 2);
      endsForceUpload = false;
    }
    ensure(edgeColor, e * 16);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeColor.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.edgeRGBA, 0, e * 4);
    ensure(edgeWidth, e * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeWidth.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.edgeWidth, 0, e);
  };

  const uploadRings = (f: SceneFrame): number => {
    const n = f.nodeCount;
    if (ringScratch.length < n) {
      ringScratch = new Uint32Array(growCapacity(ringScratch.length, n));
    }
    const count = compactRingIndices(f.nodeRing, n, ringScratch);
    if (count > 0) {
      ensure(ringIndex, count * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, ringIndex.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ringScratch, 0, count);
    }
    return count;
  };

  const backend: DrawBackend = {
    kind: 'webgl2',
    canvas,
    resize(width: number, height: number, dpr: number): void {
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      if (!lost && !destroyed) gl.viewport(0, 0, w, h);
    },
    draw(f: SceneFrame): void {
      if (lost || destroyed) return;
      if (gl.isContextLost()) {
        lost = true;
        return;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (f.nodeCount <= 0) return;

      uploadNodes(f);
      uploadEdges(f);
      const ringCount = uploadRings(f);

      if (f.edgeCount > 0) {
        setCommonUniforms(edgeProg, f);
        gl.bindVertexArray(edgeVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.edgeCount);
      }

      setCommonUniforms(nodeProg, f);
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, f.nodeCount);

      if (ringCount > 0) {
        setCommonUniforms(ringProg, f);
        const c = f.ringRGBA;
        gl.uniform4f(ringProg.u.extra, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1);
        gl.bindVertexArray(ringVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ringCount);
      }

      if (f.arrows && f.edgeCount > 0) {
        setCommonUniforms(arrowProg, f);
        gl.uniform1f(arrowProg.u.extra, arrowSize(f.camera.k));
        gl.bindVertexArray(arrowVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, f.edgeCount);
      }

      gl.bindVertexArray(null);
    },
    isLost(): boolean {
      return lost;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      if (!lost && !gl.isContextLost()) {
        for (const v of vaos) gl.deleteVertexArray(v);
        for (const b of buffers) gl.deleteBuffer(b);
        gl.deleteTexture(texture);
        for (const p of programs) if (p) gl.deleteProgram(p.program);
        loseContext(gl);
      }
      canvas.remove();
    },
  };
  return backend;
}
