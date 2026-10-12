/**
 * Graph renderer orchestrator (plan 018): rAF loop, interaction, camera,
 * backend selection, and the public {@link GraphRenderer} API.
 *
 * - Backend: WebGL2, else Canvas2D; a lost backend is replaced by Canvas2D
 *   at frame time. With neither (jsdom) the renderer runs headless: the
 *   simulation, picking, callbacks, and `onReady` still work.
 * - Layout: a d3-force-equivalent simulation runs live; the first model
 *   is warmed up synchronously (≤ 60 ticks / 12 ms) and the camera keeps
 *   auto-fitting until the user moves it or the layout settles.
 * - Loop: frames are requested only while something changes (simulation
 *   cooling, drag, hover fade, camera fit, or an explicit redraw), so an
 *   idle graph costs zero CPU. A steady-state frame allocates nothing.
 */

import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  createCamera,
  keyboardPan,
  keyboardZoom,
  pan,
  zoomAt,
  type CameraState,
  type ViewportSize,
} from '../camera';
import type { GraphModel } from '../model';
import type { GraphPalette } from '../palette';
import type { GraphSettings } from '../settings';
import { createCanvas2DBackend } from './canvas2d';
import { createLabelLayer } from './labels';
import { createPicker } from './picker';
import { createScene } from './scene';
import { createForceSimulation, mulberry32 } from './simulation';
import type { DrawBackend, ForceParams, ForceSimulation, LabelLayer } from './types';
import { createWebGLBackend } from './webgl';

export interface GraphRendererCallbacks {
  onNodeClick?: ((id: string) => void) | undefined;
  onNodeHover?: ((id: string | null) => void) | undefined;
  onReady?: (() => void) | undefined;
  /** Deterministic seed for the initial layout. Defaults to 1. */
  seed?: number | undefined;
}

/**
 * Internal options (tests / diagnostics). Not part of the stable API.
 */
export interface GraphRendererOptions extends GraphRendererCallbacks {
  /** Override backend creation (default: WebGL2, else Canvas2D). */
  backendFactory?: (() => DrawBackend | null) | undefined;
  /** Override label layer creation (default: overlay 2D canvas). */
  labelLayerFactory?: (() => LabelLayer | null) | undefined;
}

export interface GraphRenderer {
  setModel(
    model: GraphModel,
    groupColors: Array<string | null>,
    palette: GraphPalette,
    settings: GraphSettings,
  ): void;
  /** Reheat the simulation and restart the animation loop. */
  animate(): void;
  setSelected(id: string | null): void;
  destroy(): void;
}

/** Hard DPR cap so hidpi screens don't melt the fill-rate budget. */
export const MAX_DPR = 2;
/** Click = pointerup within 500 ms and 4 px of pointerdown. */
export const CLICK_MAX_MS = 500;
export const CLICK_MAX_PX = 4;
/** Wheel zoom feel: `factor = exp(-deltaY * WHEEL_SENSITIVITY)`. */
export const WHEEL_SENSITIVITY = 0.0015;
/** Trackpad pinch (`ctrlKey` wheel) sensitivity multiplier. */
export const PINCH_MULTIPLIER = 3;
/** Synchronous warm-up before the first paint. */
export const WARMUP_MAX_TICKS = 60;
export const WARMUP_BUDGET_MS = 12;
/** Extra ticks per frame allowed while hot and cheap. */
const MAX_TICKS_PER_FRAME = 3;
const HOT_ALPHA = 0.5;
const CHEAP_TICK_MS = 4;
/** Drag alpha target (d3 convention). */
const DRAG_ALPHA_TARGET = 0.3;
/** Camera auto-fit easing per frame and its padding. */
const FIT_EASE = 0.15;
const FIT_PADDING = 40;
/** World-unit jitter for new nodes placed next to an existing neighbour. */
const NEIGHBOUR_JITTER = 30;
/** Minimum alpha when a new simulation is seeded from a previous layout. */
const REHEAT_MIN = 0.3;
/**
 * Zoom-out floor relative to the fit-to-content zoom: large vaults lay out
 * wider than `1 / MIN_ZOOM` world units, so the floor follows the content
 * (never above {@link MIN_ZOOM}) to keep the whole graph reachable.
 */
const FIT_FLOOR_RATIO = 0.5;

/**
 * Order-sensitive id-list comparison for `setModel` change detection:
 * length + per-id `===`, so reorders count as changed. Browser-safe.
 */
export function sameIdSet(prev: readonly string[] | null, next: readonly string[]): boolean {
  if (prev === null || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

function sameLinks(a: GraphModel, b: GraphModel): boolean {
  if (a.links.length !== b.links.length) return false;
  for (let e = 0; e < a.links.length; e += 1) {
    const la = a.links[e]!;
    const lb = b.links[e]!;
    if (la.source !== lb.source || la.target !== lb.target) return false;
  }
  return true;
}

function forcesOf(settings: GraphSettings): ForceParams {
  return {
    centerForce: settings.centerForce,
    repelForce: settings.repelForce,
    linkForce: settings.linkForce,
    linkDistance: settings.linkDistance,
  };
}

function sameForces(a: GraphSettings, b: GraphSettings): boolean {
  return (
    a.centerForce === b.centerForce &&
    a.repelForce === b.repelForce &&
    a.linkForce === b.linkForce &&
    a.linkDistance === b.linkDistance
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultBackend(): DrawBackend | null {
  return createWebGLBackend() ?? createCanvas2DBackend();
}

export function createGraphRenderer(
  host: HTMLElement,
  opts: GraphRendererOptions = {},
): GraphRenderer {
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : 1;

  // — Host + layers —
  try {
    const position = getComputedStyle(host).position;
    if (position === '' || position === 'static') host.style.position = 'relative';
  } catch {
    host.style.position = 'relative';
  }
  host.tabIndex = 0;
  if (!host.hasAttribute('aria-label')) {
    host.setAttribute('aria-label', 'Graph view. Use arrow keys to pan, plus and minus to zoom.');
  }

  let backend: DrawBackend | null = (opts.backendFactory ?? defaultBackend)();
  const labelLayer: LabelLayer | null = (opts.labelLayerFactory ?? (() => createLabelLayer()))();
  if (backend) host.appendChild(backend.canvas);
  if (labelLayer) {
    labelLayer.canvas.style.pointerEvents = 'none';
    host.appendChild(labelLayer.canvas);
  }

  // — State —
  const viewport: ViewportSize = { width: 0, height: 0 };
  let dpr = 1;
  let camera: CameraState = createCamera();
  const fitTarget: CameraState = { x: 0, y: 0, k: 1 };
  /** Unclamped-below fit zoom from the last `computeFit`. */
  let fitRawK = 1;
  let cameraTouched = false;
  let autoFit = false;

  const scene = createScene();
  const picker = createPicker();
  let model: GraphModel | null = null;
  let settings: GraphSettings | null = null;
  let sim: ForceSimulation | null = null;
  let lastIds: string[] | null = null;
  let selectedId: string | null = null;
  let hovered = -1;

  let rafId = 0;
  let rafIsTimeout = false;
  let lastTs = 0;
  let destroyed = false;
  let readyPending = false;

  // Pointer state.
  let pointerId = -1;
  let dragIndex = -1;
  let dragOffX = 0;
  let dragOffY = 0;
  let dragStarted = false;
  let panning = false;
  let downTime = 0;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;

  // — Frame scheduling —
  function requestFrame(): void {
    if (destroyed || rafId !== 0) return;
    if (typeof requestAnimationFrame === 'function') {
      rafIsTimeout = false;
      rafId = requestAnimationFrame(frame);
    } else {
      rafIsTimeout = true;
      rafId = setTimeout(timeoutFrame, 16) as unknown as number;
    }
  }

  function timeoutFrame(): void {
    frame(now());
  }

  function cancelFrame(): void {
    if (rafId === 0) return;
    if (rafIsTimeout) clearTimeout(rafId);
    else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // — Camera fit (allocation-free) —
  /** Write the fit-to-content camera into `fitTarget`; false if nothing to fit. */
  function computeFit(): boolean {
    if (!sim || viewport.width <= 0 || viewport.height <= 0) return false;
    const x = sim.x;
    const y = sim.y;
    const r = scene.frame.radius;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < sim.count; i += 1) {
      const px = x[i]!;
      const py = y[i]!;
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const ri = r[i] ?? 0;
      if (px - ri < minX) minX = px - ri;
      if (py - ri < minY) minY = py - ri;
      if (px + ri > maxX) maxX = px + ri;
      if (py + ri > maxY) maxY = py + ri;
    }
    if (!Number.isFinite(minX)) return false;
    const availW = Math.max(1, viewport.width - FIT_PADDING * 2);
    const availH = Math.max(1, viewport.height - FIT_PADDING * 2);
    const raw = Math.min(availW / Math.max(maxX - minX, 1e-6), availH / Math.max(maxY - minY, 1e-6));
    fitRawK = raw;
    // Never clamp the fit above the content: big layouts need k < MIN_ZOOM.
    const k = clampZoom(raw, Math.min(MIN_ZOOM, raw), MAX_ZOOM);
    fitTarget.k = k;
    fitTarget.x = viewport.width / 2 - ((minX + maxX) / 2) * k;
    fitTarget.y = viewport.height / 2 - ((minY + maxY) / 2) * k;
    return true;
  }

  function snapFit(): void {
    if (!computeFit()) return;
    camera = { x: fitTarget.x, y: fitTarget.y, k: fitTarget.k };
  }

  /** Ease toward the fit target; returns true once converged. */
  function stepFit(): boolean {
    if (!computeFit()) return true;
    camera.x += (fitTarget.x - camera.x) * FIT_EASE;
    camera.y += (fitTarget.y - camera.y) * FIT_EASE;
    camera.k += (fitTarget.k - camera.k) * FIT_EASE;
    return (
      Math.abs(fitTarget.x - camera.x) < 0.5 &&
      Math.abs(fitTarget.y - camera.y) < 0.5 &&
      Math.abs(fitTarget.k - camera.k) < 1e-3 * fitTarget.k
    );
  }

  /** Zoom options whose floor lets the whole layout fit (see FIT_FLOOR_RATIO). */
  const zoomOpts = { min: MIN_ZOOM, max: MAX_ZOOM };
  function zoomLimits(): typeof zoomOpts {
    zoomOpts.min = computeFit() ? Math.min(MIN_ZOOM, fitRawK * FIT_FLOOR_RATIO) : MIN_ZOOM;
    return zoomOpts;
  }

  function touchCamera(): void {
    cameraTouched = true;
    autoFit = false;
  }

  // — Frame —
  function frame(ts: number): void {
    rafId = 0;
    if (destroyed) return;
    const dt = lastTs === 0 ? 16 : Math.min(100, Math.max(0, ts - lastTs));
    lastTs = ts;

    if (backend && backend.isLost()) replaceLostBackend();

    // Simulation.
    if (sim && !sim.isSettled()) {
      let t0 = now();
      sim.tick();
      let cost = now() - t0;
      let ticks = 1;
      while (ticks < MAX_TICKS_PER_FRAME && sim.alpha > HOT_ALPHA && cost < CHEAP_TICK_MS) {
        t0 = now();
        sim.tick();
        cost = now() - t0;
        ticks += 1;
      }
      picker.invalidate();
    }

    const highlightAnimating = scene.stepHighlight(dt);

    if (autoFit) {
      const converged = stepFit();
      if (converged && (!sim || sim.isSettled())) autoFit = false;
    }

    if (model) {
      scene.update(camera, viewport, dpr);
      if (viewport.width > 0 && viewport.height > 0) {
        backend?.draw(scene.frame);
        labelLayer?.draw(scene.frame, scene.labels);
      }
    }

    if (readyPending) {
      readyPending = false;
      opts.onReady?.();
    }

    const needsFrame =
      (sim !== null && !sim.isSettled()) || dragIndex !== -1 || highlightAnimating || autoFit;
    if (needsFrame) requestFrame();
    else if (rafId === 0) lastTs = 0;
  }

  function replaceLostBackend(): void {
    const lost = backend;
    if (!lost) return;
    lost.destroy();
    if (lost.canvas.parentNode === host) host.removeChild(lost.canvas);
    backend = lost.kind === 'canvas2d' ? null : createCanvas2DBackend();
    if (backend) {
      if (labelLayer && labelLayer.canvas.parentNode === host) {
        host.insertBefore(backend.canvas, labelLayer.canvas);
      } else {
        host.appendChild(backend.canvas);
      }
      backend.resize(viewport.width, viewport.height, dpr);
    }
  }

  // — Model —
  function buildSimulation(next: GraphModel, prevModel: GraphModel | null, nextSettings: GraphSettings): void {
    const n = next.nodes.length;
    const initialX = new Float32Array(n).fill(NaN);
    const initialY = new Float32Array(n).fill(NaN);
    let any = false;
    let survivors = 0;
    if (sim && prevModel) {
      for (let i = 0; i < n; i += 1) {
        const j = prevModel.indexById.get(next.nodes[i]!.id);
        if (j === undefined || j >= sim.count) continue;
        initialX[i] = sim.x[j]!;
        initialY[i] = sim.y[j]!;
        survivors += 1;
      }
      any = survivors > 0;
      if (any) {
        // New nodes start beside an already-positioned neighbour.
        const rand = mulberry32(seed ^ 0x9e3779b9);
        for (let i = 0; i < n; i += 1) {
          if (!Number.isNaN(initialX[i]!)) continue;
          const adj = next.adjacency[i];
          if (!adj) continue;
          for (let a = 0; a < adj.length; a += 1) {
            const j = adj[a]!;
            if (j === i || Number.isNaN(initialX[j]!)) continue;
            initialX[i] = initialX[j]! + (rand() - 0.5) * NEIGHBOUR_JITTER;
            initialY[i] = initialY[j]! + (rand() - 0.5) * NEIGHBOUR_JITTER;
            break;
          }
        }
      }
    }
    sim = createForceSimulation({
      count: n,
      edgeSource: scene.frame.edgeSource,
      edgeTarget: scene.frame.edgeTarget,
      radii: scene.frame.radius,
      forces: forcesOf(nextSettings),
      seed,
      initialX: any ? initialX : undefined,
      initialY: any ? initialY : undefined,
    });
    if (any) {
      // Mostly-known layout: reheat only as much as the share of new nodes
      // needs, so surviving clusters don't jump.
      const fresh = 1 - survivors / Math.max(1, n);
      sim.reheat(Math.min(1, Math.max(REHEAT_MIN, fresh)));
    }
    scene.setPositions(sim.x, sim.y);
    picker.invalidate();
  }

  function warmUp(): void {
    if (!sim) return;
    const start = now();
    for (let t = 0; t < WARMUP_MAX_TICKS && !sim.isSettled(); t += 1) {
      sim.tick();
      if (now() - start >= WARMUP_BUDGET_MS) break;
    }
  }

  function setModel(
    next: GraphModel,
    groupColors: Array<string | null>,
    palette: GraphPalette,
    nextSettings: GraphSettings,
  ): void {
    if (destroyed) return;
    const prevModel = model;
    const prevSettings = settings;
    const ids = next.nodes.map((node) => node.id);
    const sameIds = sameIdSet(lastIds, ids);
    const firstLoad = sim === null;

    if (!sameIds) {
      // Different node set: fresh simulation seeded from surviving positions.
      if (dragIndex !== -1) endDrag();
      const hoveredId = hovered >= 0 && prevModel ? (prevModel.nodes[hovered]?.id ?? null) : null;
      model = next;
      settings = nextSettings;
      lastIds = ids;
      scene.setModel(next);
      scene.setStyle(groupColors, palette, nextSettings);
      buildSimulation(next, prevModel, nextSettings);
      hovered = hoveredId !== null ? (next.indexById.get(hoveredId) ?? -1) : -1;
      scene.setHovered(hovered);
      if (hoveredId !== null && hovered === -1) opts.onNodeHover?.(null);
      readyPending = true;
      if (firstLoad) {
        warmUp();
        snapFit();
        autoFit = true;
      } else {
        autoFit = !cameraTouched;
      }
    } else {
      model = next;
      settings = nextSettings;
      const linksChanged = prevModel !== null && prevModel !== next && !sameLinks(prevModel, next);
      if (prevModel !== next) scene.setModel(next, true);
      scene.setStyle(groupColors, palette, nextSettings);
      picker.invalidate();
      if (linksChanged) {
        // Same nodes, new edges: keep every position, rebuild the forces.
        buildSimulation(next, prevModel, nextSettings);
      } else if (sim && prevSettings) {
        if (prevSettings.nodeSize !== nextSettings.nodeSize) sim.setRadii(scene.frame.radius);
        if (!sameForces(prevSettings, nextSettings)) sim.setForces(forcesOf(nextSettings));
      }
      scene.setHovered(hovered);
    }
    scene.setSelected(selectedId !== null ? (next.indexById.get(selectedId) ?? -1) : -1);
    requestFrame();
  }

  // — Hover / selection —
  function setHovered(index: number): void {
    if (index === hovered) return;
    hovered = index;
    scene.setHovered(index);
    host.style.cursor = index >= 0 ? 'pointer' : '';
    opts.onNodeHover?.(index >= 0 && model ? model.nodes[index]!.id : null);
    requestFrame();
  }

  // — Pointer —
  function localPoint(e: { clientX: number; clientY: number }): { sx: number; sy: number } {
    const rect = host.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  function pickAt(sx: number, sy: number): number {
    if (!sim || !model) return -1;
    return picker.pick(sx, sy, camera, sim.x, sim.y, scene.frame.radius, sim.count);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== undefined && e.button !== 0) return;
    try {
      host.focus({ preventScroll: true });
    } catch {
      // Focus is best-effort.
    }
    const { sx, sy } = localPoint(e);
    downTime = now();
    downX = e.clientX;
    downY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    pointerId = e.pointerId;
    const hit = pickAt(sx, sy);
    if (hit >= 0 && sim) {
      dragIndex = hit;
      dragStarted = false;
      const wx = (sx - camera.x) / camera.k;
      const wy = (sy - camera.y) / camera.k;
      dragOffX = sim.x[hit]! - wx;
      dragOffY = sim.y[hit]! - wy;
      sim.pin(hit, sim.x[hit]!, sim.y[hit]!);
      sim.setAlphaTarget(DRAG_ALPHA_TARGET);
      setHovered(hit);
    } else {
      panning = true;
    }
    try {
      host.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort (jsdom / synthetic events).
    }
    requestFrame();
  }

  function onPointerMove(e: PointerEvent): void {
    const { sx, sy } = localPoint(e);
    if (dragIndex !== -1 && sim) {
      if (!dragStarted && Math.hypot(e.clientX - downX, e.clientY - downY) >= CLICK_MAX_PX) {
        dragStarted = true;
      }
      if (dragStarted) {
        const wx = (sx - camera.x) / camera.k;
        const wy = (sy - camera.y) / camera.k;
        sim.pin(dragIndex, wx + dragOffX, wy + dragOffY);
        picker.invalidate();
      }
      requestFrame();
      return;
    }
    if (panning) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx !== 0 || dy !== 0) {
        camera = pan(camera, dx, dy);
        touchCamera();
        requestFrame();
      }
      return;
    }
    setHovered(pickAt(sx, sy));
  }

  function endDrag(): void {
    if (dragIndex !== -1 && sim) {
      sim.unpin(dragIndex);
      sim.setAlphaTarget(0);
    }
    dragIndex = -1;
    dragStarted = false;
  }

  function releaseCapture(): void {
    if (pointerId === -1) return;
    try {
      if (host.hasPointerCapture?.(pointerId)) host.releasePointerCapture(pointerId);
    } catch {
      // Best-effort.
    }
    pointerId = -1;
  }

  function onPointerUp(e: PointerEvent): void {
    const index = dragIndex;
    const id = index !== -1 && model ? (model.nodes[index]?.id ?? null) : null;
    endDrag();
    panning = false;
    releaseCapture();
    const dt = now() - downTime;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (id !== null && dt < CLICK_MAX_MS && dist < CLICK_MAX_PX) opts.onNodeClick?.(id);
    requestFrame();
  }

  function onPointerCancel(): void {
    endDrag();
    panning = false;
    releaseCapture();
    requestFrame();
  }

  function onPointerLeave(): void {
    if (dragIndex === -1 && !panning) setHovered(-1);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { sx, sy } = localPoint(e);
    const lineScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.height || 800 : 1;
    const sensitivity = WHEEL_SENSITIVITY * (e.ctrlKey ? PINCH_MULTIPLIER : 1);
    const factor = Math.exp(-e.deltaY * lineScale * sensitivity);
    camera = zoomAt(camera, sx, sy, factor, zoomLimits());
    touchCamera();
    requestFrame();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const shift = e.shiftKey;
    let next: CameraState | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = keyboardPan(camera, -1, 0, shift);
        break;
      case 'ArrowRight':
        next = keyboardPan(camera, 1, 0, shift);
        break;
      case 'ArrowUp':
        next = keyboardPan(camera, 0, -1, shift);
        break;
      case 'ArrowDown':
        next = keyboardPan(camera, 0, 1, shift);
        break;
      case '+':
      case '=':
        next = keyboardZoom(camera, 1, viewport, zoomLimits());
        break;
      case '-':
      case '_':
        next = keyboardZoom(camera, -1, viewport, zoomLimits());
        break;
      default:
        break;
    }
    if (next) {
      e.preventDefault();
      camera = next;
      touchCamera();
      requestFrame();
    }
  }

  // — Resize —
  function resize(): void {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const ratio =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio || 1
        : 1;
    const nextDpr = Math.min(MAX_DPR, Math.max(1, ratio));
    if (w === viewport.width && h === viewport.height && nextDpr === dpr) return;
    const wasEmpty = viewport.width <= 0 || viewport.height <= 0;
    viewport.width = w;
    viewport.height = h;
    dpr = nextDpr;
    backend?.resize(w, h, dpr);
    labelLayer?.resize(w, h, dpr);
    if (!cameraTouched && sim) {
      if (wasEmpty) snapFit();
      autoFit = true;
    }
    requestFrame();
  }

  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;

  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', onPointerUp);
  host.addEventListener('pointercancel', onPointerCancel);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('keydown', onKeyDown);
  resizeObserver?.observe(host);
  resize();
  camera = createCamera({ x: viewport.width / 2, y: viewport.height / 2, k: 1 });

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelFrame();
    resizeObserver?.disconnect();
    host.removeEventListener('pointerdown', onPointerDown);
    host.removeEventListener('pointermove', onPointerMove);
    host.removeEventListener('pointerup', onPointerUp);
    host.removeEventListener('pointercancel', onPointerCancel);
    host.removeEventListener('pointerleave', onPointerLeave);
    host.removeEventListener('wheel', onWheel);
    host.removeEventListener('keydown', onKeyDown);
    if (backend) {
      backend.destroy();
      if (backend.canvas.parentNode === host) host.removeChild(backend.canvas);
      backend = null;
    }
    if (labelLayer) {
      labelLayer.destroy();
      if (labelLayer.canvas.parentNode === host) host.removeChild(labelLayer.canvas);
    }
    host.style.cursor = '';
    sim = null;
    model = null;
  }

  return {
    setModel,
    animate(): void {
      if (destroyed || !sim) return;
      sim.reheat(1);
      requestFrame();
    },
    setSelected(id: string | null): void {
      selectedId = id;
      scene.setSelected(id !== null && model ? (model.indexById.get(id) ?? -1) : -1);
      requestFrame();
    },
    destroy,
  };
}
