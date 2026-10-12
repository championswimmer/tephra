/**
 * Label layer (plan 018): node labels drawn on an overlay 2D canvas shared by
 * both draw backends. Labels sit centred below their node
 * (`y + max(1, r*k) + 4`), are drawn in priority order, skip nodes outside
 * the viewport, and use a coarse screen-space occupancy grid so overlapping
 * labels are dropped instead of drawn on top of each other.
 *
 * `measureText` widths and ellipsized strings are cached per node index;
 * the occupancy grid is a reused stamp array keyed by a frame counter, so a
 * steady-state frame allocates nothing.
 */

import type { LabelFrame, LabelLayer, SceneFrame } from './types';

export interface LabelLayerOptions {
  /** Canvas to draw on (defaults to a new `<canvas>` from `document`). */
  canvas?: HTMLCanvasElement | undefined;
  /** Context to draw with (defaults to `canvas.getContext('2d')`). */
  context?: CanvasRenderingContext2D | null | undefined;
}

export const LABEL_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
/** Label box height in CSS px used for overlap tests. */
const LABEL_HEIGHT = 14;
/** Gap between the node rim and the top of its label, CSS px. */
const LABEL_GAP = 4;
/** Labels longer than this many characters are ellipsized. */
const LABEL_MAX_CHARS = 40;
/** Occupancy grid cell size in CSS px. */
const CELL = 8;
/** Anchors this far outside the viewport are still considered. */
const MARGIN = 64;

/**
 * Global label opacity for zoom `k` (plan §4): `t = textFadeThreshold * 2`;
 * `t <= 0` ⇒ 0, else `clamp((k - t) / t, 0, 1)`.
 */
export function labelFadeOpacity(k: number, textFadeThreshold: number): number {
  const t = textFadeThreshold * 2;
  if (!(t > 0)) return 0;
  const v = (k - t) / t;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Create the label layer. Returns null when no 2D context is available.
 */
export function createLabelLayer(options: LabelLayerOptions = {}): LabelLayer | null {
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
    style.pointerEvents = 'none';
  }

  let widths = new Float32Array(0);
  let source: (string | undefined)[] = [];
  let display: string[] = [];
  let grid = new Uint32Array(0);
  let gridCols = 0;
  let gridRows = 0;
  let stamp = 0;

  function resetCache(n: number): void {
    widths = new Float32Array(n).fill(NaN);
    source = new Array<string | undefined>(n);
    display = new Array<string>(n);
  }

  function ensureGrid(w: number, h: number): void {
    const cols = Math.max(1, Math.ceil(w / CELL));
    const rows = Math.max(1, Math.ceil(h / CELL));
    if (cols === gridCols && rows === gridRows) return;
    gridCols = cols;
    gridRows = rows;
    grid = new Uint32Array(cols * rows);
    stamp = 0;
  }

  /** Text to draw for node `i` (ellipsized + cached); measures on miss. */
  function prepare(i: number, raw: string): string {
    if (source[i] !== raw) {
      source[i] = raw;
      display[i] = raw.length > LABEL_MAX_CHARS ? `${raw.slice(0, LABEL_MAX_CHARS - 1)}…` : raw;
      widths[i] = NaN;
    }
    const text = display[i]!;
    if (Number.isNaN(widths[i]!)) widths[i] = c.measureText(text).width;
    return text;
  }

  function draw(frame: SceneFrame, labels: LabelFrame): void {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.width, el.height);
    const n = frame.nodeCount;
    if (n === 0 || labels.maxLabels <= 0) return;
    c.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
    if (widths.length !== n) resetCache(n);

    const W = frame.viewport.width;
    const H = frame.viewport.height;
    ensureGrid(W, H);
    stamp++;
    if (stamp > 0xfffffff0) {
      grid.fill(0);
      stamp = 1;
    }

    const { camera, x, y, radius } = frame;
    const k = camera.k;
    const { order, opacity, text } = labels;

    c.font = LABEL_FONT;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillStyle = labels.color;
    let alpha = -1;
    let drawn = 0;

    for (let o = 0; o < order.length; o++) {
      const i = order[o]!;
      if (i >= n) continue;
      const a = opacity[i]!;
      if (!(a > 0.01)) continue;
      const raw = text[i];
      if (raw === undefined || raw.length === 0) continue;
      const ax = x[i]! * k + camera.x;
      const ay = y[i]! * k + camera.y + Math.max(1, radius[i]! * k) + LABEL_GAP;
      if (ax < -MARGIN || ax > W + MARGIN || ay < -MARGIN || ay > H + MARGIN) continue;

      const label = prepare(i, raw);
      const half = widths[i]! / 2;
      // Occupancy test over the label rect, clipped to the grid.
      const c0 = Math.max(0, Math.floor((ax - half) / CELL));
      const c1 = Math.min(gridCols - 1, Math.floor((ax + half) / CELL));
      const r0 = Math.max(0, Math.floor(ay / CELL));
      const r1 = Math.min(gridRows - 1, Math.floor((ay + LABEL_HEIGHT) / CELL));
      let free = true;
      for (let r = r0; r <= r1 && free; r++) {
        const row = r * gridCols;
        for (let col = c0; col <= c1; col++) {
          if (grid[row + col] === stamp) {
            free = false;
            break;
          }
        }
      }
      if (!free) continue;
      for (let r = r0; r <= r1; r++) {
        const row = r * gridCols;
        for (let col = c0; col <= c1; col++) grid[row + col] = stamp;
      }

      const la = a > 1 ? 1 : a;
      if (la !== alpha) {
        c.globalAlpha = la;
        alpha = la;
      }
      c.fillText(label, ax, ay);
      if (++drawn >= labels.maxLabels) break;
    }
    if (alpha !== 1) c.globalAlpha = 1;
  }

  return {
    canvas: el,
    resize(width: number, height: number, dpr: number): void {
      el.width = Math.max(1, Math.round(width * dpr));
      el.height = Math.max(1, Math.round(height * dpr));
    },
    draw,
    invalidate(): void {
      widths.fill(NaN);
      source.fill(undefined);
    },
    destroy(): void {
      el.parentNode?.removeChild(el);
      resetCache(0);
      grid = new Uint32Array(0);
      gridCols = 0;
      gridRows = 0;
    },
  };
}
