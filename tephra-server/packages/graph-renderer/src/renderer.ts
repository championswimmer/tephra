/**
 * Canvas-2D graph renderer: imperative, dependency-free, Obsidian-flavoured.
 *
 * Owns a single `<canvas>` inside the given host element. Draw order per
 * frame is links → nodes → arrows → labels. The force simulation ticks in
 * the same rAF loop and the loop idles (0 CPU) once the layout settles;
 * any `setModel` / drag / zoom reheats it.
 *
 * No sigma / graphology / pixi / d3 imports — hand-rolled on purpose.
 */

import {
  createCamera,
  fitView,
  keyboardPan,
  keyboardZoom,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type CameraState,
} from './camera';
import { nodeRadius, type GraphModel } from './model';
import { createNodePicker, isNodeInViewport } from './picking';
import { MAX_VISIBLE_NODES, visibleNodeBudget } from './visibility';
import { createSimulation, type Simulation } from './simulation';
import type { GraphPalette } from './palette';
import type { GraphSettings } from './settings';

export interface GraphRendererCallbacks {
  onNodeClick?: ((id: string) => void) | undefined;
  onNodeHover?: ((id: string | null) => void) | undefined;
  onReady?: (() => void) | undefined;
  /** Deterministic seed for the initial layout. Defaults to 1. */
  seed?: number | undefined;
}

export interface GraphRenderer {
  setModel(
    model: GraphModel,
    groupColors: Array<string | null>,
    palette: GraphPalette,
    settings: GraphSettings,
  ): void;
  setSelected(id: string | null): void;
  destroy(): void;
}

/** Max simulation ticks per reheat before the rAF loop idles. */
const MAX_TICKS = 300;
/** Hard DPR cap so hidpi screens don't melt the fill-rate budget. */
const MAX_DPR = 2;
/** Max node labels drawn per frame (top nodes by degree). */
const MAX_LABELS = 250;
/** Alpha for non-neighbourhood nodes while hovering. */
const HOVER_DIM = 0.15;
/** Click = pointerup within 500 ms and 4 px of pointerdown. */
const CLICK_MAX_MS = 500;
const CLICK_MAX_PX = 4;
/** Wheel zoom feel: `factor = exp(-deltaY * WHEEL_SENSITIVITY)`. */
const WHEEL_SENSITIVITY = 0.0015;
/** Extra screen-pixel tolerance for hit-testing tiny nodes. */
const HIT_SLOP_PX = 3;

function linkWidth(count: number, linkThickness: number): number {
  return linkThickness * (1 + Math.log2(Math.max(1, count)));
}

function baseNodeColor(kind: string, palette: GraphPalette): string {
  switch (kind) {
    case 'tag':
      return palette.tag;
    case 'attachment':
      return palette.attachment;
    case 'unresolved':
      return palette.unresolved;
    default:
      return palette.node;
  }
}

export function createGraphRenderer(
  host: HTMLElement,
  opts: GraphRendererCallbacks = {},
): GraphRenderer {
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : 1;

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  host.tabIndex = 0;
  if (!host.hasAttribute('aria-label')) {
    host.setAttribute(
      'aria-label',
      'Graph view. Use arrow keys to pan, plus and minus to zoom.',
    );
  }

  let camera: CameraState = createCamera({
    x: host.clientWidth / 2,
    y: host.clientHeight / 2,
    k: 1,
  });
  const viewport = { width: host.clientWidth, height: host.clientHeight };
  let dpr = 1;

  let model: GraphModel | null = null;
  let groupColors: Array<string | null> = [];
  let palette: GraphPalette | null = null;
  let settings: GraphSettings | null = null;
  let sim: Simulation | null = null;
  let radii: number[] = [];
  /** Node indices sorted by degree desc — drives the label cap. */
  let labelOrder: number[] = [];
  /** Signature of the current node id-set; a change means fresh layout + fit. */
  let idSignature: string | null = null;
  /** Previous positions by id, kept across setModel so slider tweaks don't jump. */
  const prevPositions = new Map<string, { x: number; y: number }>();

  let hoveredId: string | null = null;
  let selectedId: string | null = null;
  /** Ids at full alpha while hovering (hovered + its neighbours). */
  let activeSet = new Set<string>();

  const picker = createNodePicker();

  let rafId = 0;
  let running = false;
  let dirty = true;
  let tickCount = 0;
  let settled = true;
  let readyPending = false;

  // Drag / pan / click state.
  let dragIndex = -1;
  let downTime = 0;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let panning = false;

  function signatureFor(m: GraphModel): string {
    return `${m.nodes.length}:${m.nodes.map((n) => n.id).join('\n')}`;
  }

  /**
   * Rebuild the hit-test index from the frame's visible nodes only, so the
   * picker agrees with the canvas (plan 015): invisible nodes are neither
   * drawn nor clickable. `visible` must be the same set `draw` uses.
   */
  function rebuildPicker(visible: Uint8Array | null): void {
    if (!sim) return;
    const all = sim.nodes;
    if (!visible) {
      picker.rebuild(all.map((n) => ({ id: n.id, x: n.x, y: n.y, r: n.r })));
      return;
    }
    const kept: Array<{ id: string; x: number; y: number; r: number }> = [];
    for (let i = 0; i < all.length; i += 1) {
      if (visible[i] !== 1) continue;
      const n = all[i]!;
      kept.push({ id: n.id, x: n.x, y: n.y, r: n.r });
    }
    picker.rebuild(kept);
  }

  /**
   * Per-frame visible set: viewport predicate (same bounds as the node
   * pass) applied in degree-desc `labelOrder`, capped at
   * `MAX_VISIBLE_NODES`, with selected + hovered force-included.
   * Render-only: simulation, counts, and model are untouched.
   */
  function computeVisible(): Uint8Array | null {
    if (!model || !sim) return null;
    const nodes = sim.nodes;
    const force = new Set<number>();
    if (selectedId !== null) {
      const si = model.indexById.get(selectedId);
      if (si !== undefined) force.add(si);
    }
    if (hoveredId !== null) {
      const hi = model.indexById.get(hoveredId);
      if (hi !== undefined) force.add(hi);
    }
    const isInView = (index: number): boolean => {
      const n = nodes[index]!;
      const p = worldToScreen(n.x, n.y, camera);
      const sr = Math.max(1, radii[index]! * camera.k);
      return !(
        p.x + sr < 0 ||
        p.x - sr > viewport.width ||
        p.y + sr < 0 ||
        p.y - sr > viewport.height
      );
    };
    return visibleNodeBudget(model, isInView, MAX_VISIBLE_NODES, force, labelOrder)
      .visible;
  }

  function setHovered(next: string | null): void {
    if (next === hoveredId) return;
    hoveredId = next;
    activeSet = new Set<string>();
    if (next !== null && model) {
      activeSet.add(next);
      const idx = model.indexById.get(next);
      if (idx !== undefined) {
        for (const nb of model.adjacency[idx] ?? []) {
          activeSet.add(model.nodes[nb]!.id);
        }
      }
    }
    opts.onNodeHover?.(hoveredId);
    requestFrame();
  }

  function requestFrame(): void {
    dirty = true;
    if (!running) {
      running = true;
      rafId = requestAnimationFrame(frame);
    }
  }

  function reheatAndKick(alpha = 1): void {
    sim?.reheat(alpha);
    tickCount = 0;
    settled = false;
    requestFrame();
  }

  function setModel(
    next: GraphModel,
    colors: Array<string | null>,
    nextPalette: GraphPalette,
    nextSettings: GraphSettings,
  ): void {
    model = next;
    groupColors = colors;
    palette = nextPalette;
    settings = nextSettings;

    radii = next.nodes.map((n) => nodeRadius(n.degree, nextSettings.nodeSize));
    labelOrder = next.nodes
      .map((_, i) => i)
      .sort((a, b) => next.nodes[b]!.degree - next.nodes[a]!.degree);

    const sig = signatureFor(next);
    const sameIds = sig === idSignature;
    idSignature = sig;

    sim = createSimulation(
      next.nodes.map((n, i) => {
        const prev = sameIds ? prevPositions.get(n.id) : undefined;
        return {
          id: n.id,
          x: prev?.x,
          y: prev?.y,
          r: radii[i],
        };
      }),
      next.links.map((l) => ({ s: l.source, t: l.target })),
      {
        centerForce: nextSettings.centerForce,
        repelForce: nextSettings.repelForce,
        linkForce: nextSettings.linkForce,
        linkDistance: nextSettings.linkDistance,
      },
      { seed },
    );

    if (!sameIds && viewport.width > 0 && viewport.height > 0) {
      camera = fitView(sim.positions(), radii, viewport);
    }
    // Keep the hover neighbourhood consistent across model swaps.
    if (hoveredId !== null && !next.indexById.has(hoveredId)) {
      hoveredId = null;
      activeSet = new Set<string>();
    }
    readyPending = true;
    reheatAndKick(1);
  }

  function draw(visible: Uint8Array): void {
    if (!ctx || !model || !palette || !settings) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    if (!sim) return;
    const nodes = sim.nodes;
    const hovering = hoveredId !== null;

    // — Links —
    ctx.lineCap = 'round';
    for (const link of model.links) {
      if (visible[link.source] !== 1 || visible[link.target] !== 1) continue;
      if (hovering) {
        const s = model.nodes[link.source]!.id;
        const t = model.nodes[link.target]!.id;
        if (!activeSet.has(s) || !activeSet.has(t)) continue;
      }
      const a = nodes[link.source]!;
      const b = nodes[link.target]!;
      const pa = worldToScreen(a.x, a.y, camera);
      const pb = worldToScreen(b.x, b.y, camera);
      // Skip fully off-screen links.
      if (
        (pa.x < -50 && pb.x < -50) ||
        (pa.x > viewport.width + 50 && pb.x > viewport.width + 50) ||
        (pa.y < -50 && pb.y < -50) ||
        (pa.y > viewport.height + 50 && pb.y > viewport.height + 50)
      ) {
        continue;
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = Math.max(0.5, linkWidth(link.count, settings.linkThickness));
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // — Nodes —
    // The `visible` set already encodes the viewport predicate (same bounds
    // as the old cull here), plus budget + force-include — one gate only.
    for (let i = 0; i < nodes.length; i += 1) {
      if (visible[i] !== 1) continue;
      const n = nodes[i]!;
      const m = model.nodes[i]!;
      const p = worldToScreen(n.x, n.y, camera);
      const sr = Math.max(1, radii[i]! * camera.k);
      ctx.globalAlpha = hovering && !activeSet.has(m.id) ? HOVER_DIM : 1;
      ctx.fillStyle = groupColors[i] ?? baseNodeColor(m.kind, palette);
      ctx.beginPath();
      ctx.arc(p.x, p.y, sr, 0, Math.PI * 2);
      ctx.fill();
      if (m.id === selectedId || m.id === hoveredId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = palette.focused;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sr + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // — Arrows —
    if (settings.showArrows) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.line;
      for (const link of model.links) {
        if (link.source === link.target) continue;
        if (visible[link.source] !== 1 || visible[link.target] !== 1) continue;
        if (hovering) {
          const s = model.nodes[link.source]!.id;
          const t = model.nodes[link.target]!.id;
          if (!activeSet.has(s) || !activeSet.has(t)) continue;
        }
        const a = nodes[link.source]!;
        const b = nodes[link.target]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) continue;
        const ux = dx / d;
        const uy = dy / d;
        // Tip sits at the target rim; arrow size scales with zoom.
        const tipR = radii[link.target]! + 2;
        const size = Math.max(4, Math.min(12, 6 * camera.k));
        const tx = b.x - ux * tipR;
        const ty = b.y - uy * tipR;
        const tp = worldToScreen(tx, ty, camera);
        const ang = Math.atan2(camera.k * uy, camera.k * ux);
        ctx.beginPath();
        ctx.moveTo(tp.x + Math.cos(ang) * size, tp.y + Math.sin(ang) * size);
        ctx.lineTo(
          tp.x + Math.cos(ang + (Math.PI * 2) / 3) * size,
          tp.y + Math.sin(ang + (Math.PI * 2) / 3) * size,
        );
        ctx.lineTo(
          tp.x + Math.cos(ang - (Math.PI * 2) / 3) * size,
          tp.y + Math.sin(ang - (Math.PI * 2) / 3) * size,
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    // — Labels —
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.label;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const threshold = settings.textFadeThreshold;
    const showAll =
      threshold > 0 && camera.k >= threshold * 4;
    let drawn = 0;
    const drawLabel = (index: number): void => {
      if (visible[index] !== 1) return;
      const n = nodes[index]!;
      const m = model!.nodes[index]!;
      if (
        !isNodeInViewport(
          { id: m.id, x: n.x, y: n.y, r: radii[index]! },
          camera,
          viewport,
        )
      ) {
        return;
      }
      const label = m.title ?? m.path ?? m.id;
      if (label.length === 0) return;
      const p = worldToScreen(n.x, n.y, camera);
      ctx.fillText(label, p.x + radii[index]! * camera.k + 4, p.y);
      drawn += 1;
    };
    if (hoveredId !== null) {
      const hi = model.indexById.get(hoveredId);
      if (hi !== undefined) {
        drawLabel(hi);
        drawn = 0; // Hovered label is free; the cap applies to the rest.
      }
    }
    if (showAll) {
      for (const index of labelOrder) {
        if (drawn >= MAX_LABELS) break;
        if (model.nodes[index]!.id === hoveredId) continue;
        const before = drawn;
        drawLabel(index);
        if (drawn === before) continue;
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(): void {
    rafId = 0;
    let moved = false;
    if (sim && tickCount < MAX_TICKS) {
      moved = sim.tick();
      tickCount += 1;
      if (!moved) settled = true;
      // Remember positions so settings-only setModel calls don't jump.
      if (model) {
        for (const n of sim.nodes) prevPositions.set(n.id, { x: n.x, y: n.y });
      }
    } else {
      settled = true;
    }
    // One visible set per frame, shared by picker + canvas so hit-testing
    // agrees with what is drawn (plan 015).
    const visible = computeVisible();
    rebuildPicker(visible);
    if (visible) draw(visible);
    dirty = false;
    if (readyPending) {
      readyPending = false;
      opts.onReady?.();
    }
    if ((!settled && tickCount < MAX_TICKS) || dirty || dragIndex !== -1) {
      rafId = requestAnimationFrame(frame);
    } else {
      running = false;
    }
  }

  function resize(): void {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) return;
    viewport.width = w;
    viewport.height = h;
    dpr = Math.min(
      MAX_DPR,
      Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio || 1 : 1,
    );
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    requestFrame();
  }

  function eventPosition(e: PointerEvent | WheelEvent): { sx: number; sy: number } {
    const rect = canvas.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent): void {
    host.focus({ preventScroll: true });
    const { sx, sy } = eventPosition(e);
    downTime = performance.now();
    downX = e.clientX;
    downY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    const hit = sim ? picker.hitTest(sx, sy, camera, HIT_SLOP_PX / camera.k) : null;
    if (hit !== null && hit !== undefined && model && sim) {
      const index = model.indexById.get(hit);
      if (index !== undefined) {
        dragIndex = index;
        const w = screenToWorld(sx, sy, camera);
        sim.pin(index, w.x, w.y);
        setHovered(hit);
        reheatAndKick(1);
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // Ignore: capture is best-effort (mouse already tracks the canvas).
        }
        return;
      }
    }
    panning = true;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore: see above.
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const { sx, sy } = eventPosition(e);
    if (dragIndex !== -1 && sim) {
      const w = screenToWorld(sx, sy, camera);
      sim.pin(dragIndex, w.x, w.y);
      reheatAndKick(1);
      return;
    }
    if (panning) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx !== 0 || dy !== 0) {
        camera = pan(camera, dx, dy);
        requestFrame();
      }
      return;
    }
    if (!sim) return;
    const hit = picker.hitTest(sx, sy, camera, HIT_SLOP_PX / camera.k);
    setHovered(hit);
    canvas.style.cursor = hit ? 'pointer' : 'default';
  }

  function onPointerUp(e: PointerEvent): void {
    const wasDrag = dragIndex !== -1;
    const id = wasDrag && model ? model.nodes[dragIndex]!.id : null;
    if (wasDrag && sim) sim.unpin(dragIndex);
    dragIndex = -1;
    panning = false;
    const dt = performance.now() - downTime;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (id !== null && dt < CLICK_MAX_MS && dist < CLICK_MAX_PX) {
      opts.onNodeClick?.(id);
    } else if (wasDrag) {
      reheatAndKick(0.5);
    } else {
      requestFrame();
    }
  }

  function onPointerLeave(): void {
    if (dragIndex === -1 && !panning) setHovered(null);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { sx, sy } = eventPosition(e);
    const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
    camera = zoomAt(camera, sx, sy, factor);
    requestFrame();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const shift = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        camera = keyboardPan(camera, -1, 0, shift);
        break;
      case 'ArrowRight':
        camera = keyboardPan(camera, 1, 0, shift);
        break;
      case 'ArrowUp':
        camera = keyboardPan(camera, 0, -1, shift);
        break;
      case 'ArrowDown':
        camera = keyboardPan(camera, 0, 1, shift);
        break;
      case '+':
      case '=':
        camera = keyboardZoom(camera, 1, viewport);
        break;
      case '-':
      case '_':
        camera = keyboardZoom(camera, -1, viewport);
        break;
      default:
        handled = false;
        break;
    }
    if (handled) {
      e.preventDefault();
      requestFrame();
    }
  }

  function destroy(): void {
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    running = false;
    resizeObserver.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    host.removeEventListener('keydown', onKeyDown);
    canvas.remove();
  }

  const resizeObserver = new ResizeObserver(resize);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  host.addEventListener('keydown', onKeyDown);
  resizeObserver.observe(host);
  resize();

  return {
    setModel,
    setSelected(id: string | null): void {
      selectedId = id;
      requestFrame();
    },
    destroy,
  };
}
