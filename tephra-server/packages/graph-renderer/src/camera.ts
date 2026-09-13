/**
 * Camera: pure world<->screen transform for the Canvas 2D graph renderer.
 *
 * Convention: `screen = world * k + offset`, where `offset` (`x`, `y`) is in
 * screen pixels and already includes viewport centering. All functions are
 * pure (no DOM) and return a new {@link CameraState} instead of mutating.
 */

export interface CameraState {
  /** Screen-pixel x offset: `screenX = worldX * k + x`. */
  x: number;
  /** Screen-pixel y offset: `screenY = worldY * k + y`. */
  y: number;
  /** Zoom scale (world units -> screen pixels). */
  k: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

/** Hard zoom limits applied by `zoomAt` / `fitView`. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** Keyboard pan step in screen pixels (arrow keys). */
export const KEYBOARD_PAN_STEP = 40;
/** Keyboard pan step with `Shift` held. */
export const KEYBOARD_PAN_STEP_SHIFT = 120;

/** Multiplicative zoom per keyboard `+`/`-` press. */
export const KEYBOARD_ZOOM_FACTOR = 1.2;

export function createCamera(init: Partial<CameraState> = {}): CameraState {
  return { x: init.x ?? 0, y: init.y ?? 0, k: init.k ?? 1 };
}

/** Clamp a zoom value into `[min, max]`. */
export function clampZoom(k: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(max, Math.max(min, k));
}

/** World -> screen using the camera transform. */
export function worldToScreen(
  wx: number,
  wy: number,
  camera: CameraState,
): WorldPoint {
  return { x: wx * camera.k + camera.x, y: wy * camera.k + camera.y };
}

/** Screen -> world (inverse of {@link worldToScreen}). */
export function screenToWorld(
  sx: number,
  sy: number,
  camera: CameraState,
): WorldPoint {
  const k = camera.k === 0 ? 1 : camera.k;
  return { x: (sx - camera.x) / k, y: (sy - camera.y) / k };
}

/**
 * Pan by a screen-pixel delta (drag movement, arrow keys). Positive `dx`
 * moves the scene right.
 */
export function pan(camera: CameraState, dx: number, dy: number): CameraState {
  return { x: camera.x + dx, y: camera.y + dy, k: camera.k };
}

/**
 * Arrow-key pan: `dirX`/`dirY` are each -1, 0, or 1. Step is 40 screen px,
 * or 120 px with `Shift` held.
 */
export function keyboardPan(
  camera: CameraState,
  dirX: -1 | 0 | 1,
  dirY: -1 | 0 | 1,
  shift = false,
): CameraState {
  const step = shift ? KEYBOARD_PAN_STEP_SHIFT : KEYBOARD_PAN_STEP;
  return pan(camera, dirX * step, dirY * step);
}

export interface ZoomOptions {
  min?: number;
  max?: number;
}

/**
 * Zoom by `factor` anchored at screen point (`cursorX`, `cursorY`): the world
 * point under the cursor stays under the cursor. `factor > 1` zooms in.
 * Resulting zoom is clamped to `[min, max]` (defaults {@link MIN_ZOOM} /
 * {@link MAX_ZOOM}).
 */
export function zoomAt(
  camera: CameraState,
  cursorX: number,
  cursorY: number,
  factor: number,
  opts: ZoomOptions = {},
): CameraState {
  if (!Number.isFinite(factor) || factor <= 0) return { ...camera };
  const min = opts.min ?? MIN_ZOOM;
  const max = opts.max ?? MAX_ZOOM;
  const k = clampZoom(camera.k * factor, min, max);
  const scale = k / camera.k;
  return {
    k,
    x: cursorX - (cursorX - camera.x) * scale,
    y: cursorY - (cursorY - camera.y) * scale,
  };
}

/**
 * Keyboard zoom centered on the viewport center. `direction` is +1 (zoom in,
 * `+` key) or -1 (zoom out, `-` key).
 */
export function keyboardZoom(
  camera: CameraState,
  direction: 1 | -1,
  viewport: ViewportSize,
  opts: ZoomOptions = {},
): CameraState {
  const factor = direction === 1 ? KEYBOARD_ZOOM_FACTOR : 1 / KEYBOARD_ZOOM_FACTOR;
  return zoomAt(camera, viewport.width / 2, viewport.height / 2, factor, opts);
}

export interface FitViewOptions extends ZoomOptions {
  /** Screen-pixel padding around the bounding box on every side. */
  padding?: number;
}

/**
 * Fit all node positions into the viewport. `positions` is either an
 * interleaved `Float32Array` (`[x0, y0, x1, y1, ...]`) or an array of
 * `{x, y}` points; `radii` is a single radius (all nodes) or per-node radii.
 * Node radii expand the fitted bounding box so rims stay visible.
 */
export function fitView(
  positions: Float32Array | readonly WorldPoint[],
  radii: number | ArrayLike<number>,
  viewport: ViewportSize,
  opts: FitViewOptions = {},
): CameraState {
  const fallback: CameraState = {
    x: viewport.width / 2,
    y: viewport.height / 2,
    k: 1,
  };
  const count =
    positions instanceof Float32Array ? positions.length / 2 : positions.length;
  if (count === 0 || viewport.width <= 0 || viewport.height <= 0) return fallback;

  const radiusAt = (i: number): number =>
    typeof radii === 'number' ? radii : (radii[i] ?? 0);
  const pointAt = (i: number): WorldPoint =>
    positions instanceof Float32Array
      ? { x: positions[i * 2]!, y: positions[i * 2 + 1]! }
      : (positions[i] as WorldPoint);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const p = pointAt(i);
    const r = radiusAt(i);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x - r < minX) minX = p.x - r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  if (!Number.isFinite(minX)) return fallback;

  const padding = opts.padding ?? 40;
  const availW = Math.max(1, viewport.width - padding * 2);
  const availH = Math.max(1, viewport.height - padding * 2);
  const boxW = Math.max(maxX - minX, 1e-6);
  const boxH = Math.max(maxY - minY, 1e-6);
  const k = clampZoom(
    Math.min(availW / boxW, availH / boxH),
    opts.min ?? MIN_ZOOM,
    opts.max ?? MAX_ZOOM,
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: viewport.width / 2 - cx * k, y: viewport.height / 2 - cy * k };
}
