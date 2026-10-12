/**
 * Canvas2D draw backend (plan 018): the fallback when WebGL2 is unavailable
 * or lost. Draw calls are batched so the number of `stroke()` / `fill()`
 * calls scales with the number of distinct colours/widths, not with the
 * number of nodes or edges:
 *
 * - edges are bucketed by (quantised RGBA, quantised width) → one path and
 *   one `stroke()` per bucket;
 * - nodes are bucketed by quantised RGBA → one path of arcs (or `rect`s for
 *   sub-1.5 px nodes) and one `fill()` per bucket;
 * - focus rings share one stroke; arrow heads are bucketed by colour.
 *
 * All per-frame storage (screen coordinates, bucket counters and index
 * lists, CSS strings keyed by packed 32-bit RGBA) is reused across frames, so
 * a steady-state frame performs no heap allocation.
 */

import type { DrawBackend, SceneFrame } from './types';

export interface Canvas2DBackendOptions {
  /** Canvas to draw on (defaults to a new `<canvas>` from `document`). */
  canvas?: HTMLCanvasElement | undefined;
  /** Context to draw with (defaults to `canvas.getContext('2d')`). */
  context?: CanvasRenderingContext2D | null | undefined;
}

/** Bucket tables are rebuilt when they exceed this many distinct keys. */
const MAX_BUCKETS = 2048;
/** CSS-string cache bound (keyed by packed RGBA). */
const MAX_CSS_CACHE = 4096;
/** Nodes smaller than this screen radius are drawn as squares. */
const TINY_NODE_RADIUS = 1.5;
const TAU = Math.PI * 2;

/**
 * Groups element indices by an integer key with a counting sort.
 * Keys map to stable bucket ids across frames; only counters are reset.
 */
class Buckets {
  private readonly ids = new Map<number, number>();
  private keys = new Float64Array(16);
  private stamp = new Int32Array(16);
  private counts = new Int32Array(16);
  private starts = new Int32Array(16);
  private cursor = new Int32Array(16);
  /** Bucket ids touched this frame, in first-use order. */
  used = new Int32Array(16);
  usedCount = 0;
  /** Accepted element indices and their bucket ids. */
  private elems = new Int32Array(64);
  private elemBucket = new Int32Array(64);
  private elemCount = 0;
  /** Element indices grouped by bucket (valid after `finish`). */
  order = new Int32Array(64);
  private frame = 0;

  begin(capacity: number): void {
    if (this.elems.length < capacity) {
      const n = Math.max(capacity, this.elems.length * 2);
      this.elems = new Int32Array(n);
      this.elemBucket = new Int32Array(n);
      this.order = new Int32Array(n);
    }
    if (this.ids.size > MAX_BUCKETS) {
      this.ids.clear();
      this.stamp.fill(0);
    }
    this.frame++;
    if (this.frame > 0x3fffffff) {
      this.frame = 1;
      this.stamp.fill(0);
    }
    this.usedCount = 0;
    this.elemCount = 0;
  }

  add(key: number, elem: number): void {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.ids.size;
      if (id >= this.keys.length) this.grow(id + 1);
      this.ids.set(key, id);
      this.keys[id] = key;
      this.stamp[id] = 0;
    }
    if (this.stamp[id] !== this.frame) {
      this.stamp[id] = this.frame;
      this.counts[id] = 0;
      if (this.usedCount >= this.used.length) {
        const next = new Int32Array(this.used.length * 2);
        next.set(this.used);
        this.used = next;
      }
      this.used[this.usedCount++] = id;
    }
    this.counts[id]!++;
    this.elems[this.elemCount] = elem;
    this.elemBucket[this.elemCount] = id;
    this.elemCount++;
  }

  /** Scatter accepted elements into `order`, grouped by bucket. */
  finish(): void {
    let offset = 0;
    for (let u = 0; u < this.usedCount; u++) {
      const id = this.used[u]!;
      this.starts[id] = offset;
      this.cursor[id] = offset;
      offset += this.counts[id]!;
    }
    for (let e = 0; e < this.elemCount; e++) {
      const id = this.elemBucket[e]!;
      this.order[this.cursor[id]!++] = this.elems[e]!;
    }
  }

  key(id: number): number {
    return this.keys[id]!;
  }
  start(id: number): number {
    return this.starts[id]!;
  }
  count(id: number): number {
    return this.counts[id]!;
  }

  private grow(min: number): void {
    const n = Math.max(min, this.keys.length * 2);
    const keys = new Float64Array(n);
    keys.set(this.keys);
    this.keys = keys;
    const stamp = new Int32Array(n);
    stamp.set(this.stamp);
    this.stamp = stamp;
    const counts = new Int32Array(n);
    counts.set(this.counts);
    this.counts = counts;
    this.starts = new Int32Array(n);
    this.cursor = new Int32Array(n);
  }
}

/** Pack float RGBA [0,1] at `rgba[o..o+3]` into an unsigned 32-bit int. */
function packRGBA(rgba: Float32Array, o: number): number {
  const r = Math.round(Math.min(1, Math.max(0, rgba[o]!)) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgba[o + 1]!)) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgba[o + 2]!)) * 255);
  const a = Math.round(Math.min(1, Math.max(0, rgba[o + 3]!)) * 255);
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Create the Canvas2D backend. Returns null when no 2D context is available
 * (e.g. jsdom without the `canvas` package, or no DOM at all).
 */
export function createCanvas2DBackend(options: Canvas2DBackendOptions = {}): DrawBackend | null {
  let canvas = options.canvas;
  if (!canvas) {
    if (typeof document === 'undefined') return null;
    canvas = document.createElement('canvas');
  }
  let ctx: CanvasRenderingContext2D | null;
  if (options.context !== undefined) {
    ctx = options.context;
  } else {
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return null;
  const c: CanvasRenderingContext2D = ctx;
  const el: HTMLCanvasElement = canvas;

  const style = (el as { style?: CSSStyleDeclaration }).style;
  if (style) {
    style.display = 'block';
    style.position = 'absolute';
    style.inset = '0';
    style.width = '100%';
    style.height = '100%';
  }

  const cssCache = new Map<number, string>();
  function css(packed: number): string {
    let s = cssCache.get(packed);
    if (s === undefined) {
      if (cssCache.size >= MAX_CSS_CACHE) cssCache.clear();
      const r = packed >>> 24;
      const g = (packed >>> 16) & 255;
      const b = (packed >>> 8) & 255;
      const a = Math.round(((packed & 255) / 255) * 1000) / 1000;
      s = `rgba(${r},${g},${b},${a})`;
      cssCache.set(packed, s);
    }
    return s;
  }

  // Per-node screen-space cache, grown on demand.
  let sx = new Float32Array(0);
  let sy = new Float32Array(0);
  let sr = new Float32Array(0);
  const edgeBuckets = new Buckets();
  const nodeBuckets = new Buckets();
  const arrowBuckets = new Buckets();

  function ensureNodeArrays(n: number): void {
    if (sx.length >= n) return;
    const cap = Math.max(n, sx.length * 2);
    sx = new Float32Array(cap);
    sy = new Float32Array(cap);
    sr = new Float32Array(cap);
  }

  function draw(frame: SceneFrame): void {
    const { camera, viewport, dpr } = frame;
    const k = camera.k;
    const cx = camera.x;
    const cy = camera.y;
    const W = viewport.width;
    const H = viewport.height;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.width, el.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    const n = frame.nodeCount;
    const m = frame.edgeCount;
    if (n === 0) return;
    ensureNodeArrays(n);
    const { x, y, radius, nodeRGBA, edgeRGBA, edgeSource, edgeTarget, edgeWidth } = frame;

    for (let i = 0; i < n; i++) {
      sx[i] = x[i]! * k + cx;
      sy[i] = y[i]! * k + cy;
      sr[i] = Math.max(1, radius[i]! * k);
    }

    // — Edges: bucket by (colour, width) —
    edgeBuckets.begin(m);
    for (let e = 0; e < m; e++) {
      const s = edgeSource[e]!;
      const t = edgeTarget[e]!;
      if (s === t || s >= n || t >= n) continue;
      const o = e * 4;
      if (edgeRGBA[o + 3]! <= 0.002) continue;
      const w = edgeWidth[e]!;
      const ax = sx[s]!;
      const ay = sy[s]!;
      const bx = sx[t]!;
      const by = sy[t]!;
      if (
        (ax < -w && bx < -w) ||
        (ax > W + w && bx > W + w) ||
        (ay < -w && by < -w) ||
        (ay > H + w && by > H + w)
      ) {
        continue;
      }
      const wq = Math.min(255, Math.max(1, Math.round(w * 4)));
      edgeBuckets.add(packRGBA(edgeRGBA, o) * 256 + wq, e);
    }
    edgeBuckets.finish();
    c.lineCap = 'round';
    for (let u = 0; u < edgeBuckets.usedCount; u++) {
      const id = edgeBuckets.used[u]!;
      const key = edgeBuckets.key(id);
      c.strokeStyle = css(Math.floor(key / 256));
      c.lineWidth = (key % 256) / 4;
      c.beginPath();
      const start = edgeBuckets.start(id);
      const end = start + edgeBuckets.count(id);
      for (let j = start; j < end; j++) {
        const e = edgeBuckets.order[j]!;
        const s = edgeSource[e]!;
        const t = edgeTarget[e]!;
        c.moveTo(sx[s]!, sy[s]!);
        c.lineTo(sx[t]!, sy[t]!);
      }
      c.stroke();
    }

    // — Nodes: bucket by colour —
    nodeBuckets.begin(n);
    let rings = 0;
    for (let i = 0; i < n; i++) {
      const px = sx[i]!;
      const py = sy[i]!;
      const r = sr[i]!;
      if (px + r < 0 || px - r > W || py + r < 0 || py - r > H) {
        continue;
      }
      if (frame.nodeRing[i] === 1) rings++;
      const o = i * 4;
      if (nodeRGBA[o + 3]! <= 0.002) continue;
      nodeBuckets.add(packRGBA(nodeRGBA, o), i);
    }
    nodeBuckets.finish();
    for (let u = 0; u < nodeBuckets.usedCount; u++) {
      const id = nodeBuckets.used[u]!;
      c.fillStyle = css(nodeBuckets.key(id));
      c.beginPath();
      const start = nodeBuckets.start(id);
      const end = start + nodeBuckets.count(id);
      for (let j = start; j < end; j++) {
        const i = nodeBuckets.order[j]!;
        const px = sx[i]!;
        const py = sy[i]!;
        const r = sr[i]!;
        if (r < TINY_NODE_RADIUS) {
          c.rect(px - r, py - r, r * 2, r * 2);
        } else {
          c.moveTo(px + r, py);
          c.arc(px, py, r, 0, TAU);
        }
      }
      c.fill();
    }

    // — Focus rings: one stroke —
    if (rings > 0) {
      c.strokeStyle = css(packRGBA(frame.ringRGBA, 0));
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i < n; i++) {
        if (frame.nodeRing[i] !== 1) continue;
        const px = sx[i]!;
        const py = sy[i]!;
        const r = sr[i]! + 3;
        if (px + r < 0 || px - r > W || py + r < 0 || py - r > H) continue;
        c.moveTo(px + r, py);
        c.arc(px, py, r, 0, TAU);
      }
      c.stroke();
    }

    // — Arrow heads: bucket by edge colour —
    if (!frame.arrows || m === 0) return;
    const size = Math.min(12, Math.max(4, 6 * k));
    arrowBuckets.begin(m);
    for (let e = 0; e < m; e++) {
      const s = edgeSource[e]!;
      const t = edgeTarget[e]!;
      if (s === t || s >= n || t >= n) continue;
      const o = e * 4;
      if (edgeRGBA[o + 3]! <= 0.002) continue;
      const bx = sx[t]!;
      const by = sy[t]!;
      const reach = sr[t]! + 2 + size;
      if (bx + reach < 0 || bx - reach > W || by + reach < 0 || by - reach > H) continue;
      arrowBuckets.add(packRGBA(edgeRGBA, o), e);
    }
    arrowBuckets.finish();
    const half = size * 0.5;
    for (let u = 0; u < arrowBuckets.usedCount; u++) {
      const id = arrowBuckets.used[u]!;
      c.fillStyle = css(arrowBuckets.key(id));
      c.beginPath();
      const start = arrowBuckets.start(id);
      const end = start + arrowBuckets.count(id);
      for (let j = start; j < end; j++) {
        const e = arrowBuckets.order[j]!;
        const s = edgeSource[e]!;
        const t = edgeTarget[e]!;
        const ax = sx[s]!;
        const ay = sy[s]!;
        const bx = sx[t]!;
        const by = sy[t]!;
        const dx = bx - ax;
        const dy = by - ay;
        const d = Math.sqrt(dx * dx + dy * dy);
        const rim = sr[t]! + 2;
        if (d <= rim + 1e-6) continue;
        const ux = dx / d;
        const uy = dy / d;
        const tipX = bx - ux * rim;
        const tipY = by - uy * rim;
        const baseX = tipX - ux * size;
        const baseY = tipY - uy * size;
        c.moveTo(tipX, tipY);
        c.lineTo(baseX - uy * half, baseY + ux * half);
        c.lineTo(baseX + uy * half, baseY - ux * half);
        c.closePath();
      }
      c.fill();
    }
  }

  return {
    kind: 'canvas2d',
    canvas: el,
    resize(width: number, height: number, dpr: number): void {
      el.width = Math.max(1, Math.round(width * dpr));
      el.height = Math.max(1, Math.round(height * dpr));
    },
    draw,
    isLost(): boolean {
      return false;
    },
    destroy(): void {
      el.parentNode?.removeChild(el);
      sx = new Float32Array(0);
      sy = new Float32Array(0);
      sr = new Float32Array(0);
      cssCache.clear();
    },
  };
}
