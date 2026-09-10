/**
 * PixiJS graph renderer (plan 011 §8): sprite nodes from one shared circle
 * texture (single batched draw call), links rebuilt into one `PIXI.Graphics`
 * per frame, arrows as a second batched pass, a pooled + viewport-culled
 * label layer, `d3-quadtree` hover hit-testing, and a `d3-zoom` camera with
 * Obsidian's keyboard bindings. Framework-free; owned by `GraphView`.
 */
import { quadtree, type Quadtree } from 'd3-quadtree';
import { select, type Selection } from 'd3-selection';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import * as PIXI from 'pixi.js';

import { nodeRadius, type GraphModel } from '../model';
import type { GraphPalette } from './palette';

export interface RendererDisplaySettings {
  showArrows: boolean;
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
}

export interface RendererCallbacks {
  onNodeClick: (id: string) => void;
  onNodeHover: (id: string | null) => void;
  onDragStart: (index: number) => void;
  onDragMove: (index: number, x: number, y: number) => void;
  onDragEnd: (index: number) => void;
}

export interface GraphRenderer {
  setModel: (model: GraphModel, groupColors: Array<string | null>) => void;
  setPositions: (positions: Float32Array) => void;
  setSettings: (settings: RendererDisplaySettings) => void;
  setTheme: (palette: GraphPalette) => void;
  setActive: (id: string | null) => void;
  zoomToFit: () => void;
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  destroy: () => void;
}

const CIRCLE_RADIUS = 16;
const LABEL_POOL_SIZE = 250;
const DIM_ALPHA = 0.2;
const HOVER_FIND_RADIUS = 14;
const ARROW_MIN_ZOOM = 0.6;
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif';

type QuadPoint = { x: number; y: number; i: number };

export async function createGraphRenderer(
  host: HTMLElement,
  callbacks: RendererCallbacks,
): Promise<GraphRenderer> {
  const app = new PIXI.Application();
  // Throws when WebGL context creation fails; the caller renders the
  // accessible fallback instead (no canvas-fallback renderer, per §11).
  await app.init({
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    resizeTo: host,
  });
  app.canvas.style.display = 'block';
  app.canvas.style.touchAction = 'none';
  host.appendChild(app.canvas);

  const world = new PIXI.Container();
  const linkLayer = new PIXI.Graphics();
  const arrowLayer = new PIXI.Graphics();
  const nodeLayer = new PIXI.Container();
  const labelLayer = new PIXI.Container();
  world.addChild(linkLayer, arrowLayer, nodeLayer, labelLayer);
  app.stage.addChild(world);

  const circleTexture = app.renderer.generateTexture(
    new PIXI.Graphics().circle(0, 0, CIRCLE_RADIUS).fill({ color: 0xffffff }),
  );

  const labelPool: PIXI.Text[] = Array.from({ length: LABEL_POOL_SIZE }, () => {
    const text = new PIXI.Text({
      text: '',
      style: { fontSize: 12, fontFamily: FONT_FAMILY, fill: '#000000' },
    });
    text.anchor.set(0.5, 1);
    text.visible = false;
    labelLayer.addChild(text);
    return text;
  });

  let model: GraphModel = { nodes: [], links: [], adjacency: [], indexById: new Map() };
  let groupColors: Array<string | null> = [];
  let positions = new Float32Array(0);
  let positionsVersion = 0;
  let settings: RendererDisplaySettings = {
    showArrows: false,
    textFadeThreshold: 0.3,
    nodeSize: 1,
    linkThickness: 1,
  };
  let palette: GraphPalette = {
    node: '#000000',
    tag: '#7f6df2',
    attachment: '#d669bc',
    unresolved: '#999999',
    focused: '#ff0000',
    line: '#d1d1d1',
    label: '#2e3338',
  };
  const sprites: PIXI.Sprite[] = [];
  let activeId: string | null = null;
  let hovered: number | null = null;
  let hoverSet = new Set<number>();
  let quad: Quadtree<QuadPoint> | null = null;
  let quadVersion = -1;
  let dirty = true;
  let destroyed = false;

  // Camera state mirrors the d3-zoom transform.
  let camX = 0;
  let camY = 0;
  let camK = 1;

  const kindColor = (index: number): string => {
    const group = groupColors[index];
    if (group) return group;
    const kind = model.nodes[index]!.kind;
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
  };

  const markDirty = () => {
    if (destroyed) return;
    dirty = true;
    if (!app.ticker.started) app.ticker.start();
  };

  const rebuildQuad = () => {
    const count = model.nodes.length;
    const points: QuadPoint[] = new Array(count);
    for (let index = 0; index < count; index += 1)
      points[index] = { x: positions[index * 2]!, y: positions[index * 2 + 1]!, i: index };
    quad = quadtree<QuadPoint>().x((p) => p.x).y((p) => p.y).addAll(points);
    quadVersion = positionsVersion;
  };

  const hitTest = (sx: number, sy: number): number => {
    if (quadVersion !== positionsVersion) rebuildQuad();
    if (!quad || model.nodes.length === 0) return -1;
    const worldPoint = screenToWorld(sx, sy);
    const found = quad.find(worldPoint.x, worldPoint.y, HOVER_FIND_RADIUS / camK);
    return found ? found.i : -1;
  };

  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - camX) / camK, y: (sy - camY) / camK };
  }

  const setHovered = (index: number | null) => {
    if (index === hovered) return;
    hovered = index;
    hoverSet = new Set<number>();
    if (index !== null) {
      hoverSet.add(index);
      for (const neighbour of model.adjacency[index] ?? []) hoverSet.add(neighbour);
    }
    callbacks.onNodeHover(index === null ? null : (model.nodes[index]?.id ?? null));
    markDirty();
  };

  const draw = () => {
    const count = model.nodes.length;
    const dimming = hovered !== null;

    linkLayer.clear();
    arrowLayer.clear();
    if (count > 0) {
      for (const link of model.links) {
        const x1 = positions[link.source * 2]!;
        const y1 = positions[link.source * 2 + 1]!;
        const x2 = positions[link.target * 2]!;
        const y2 = positions[link.target * 2 + 1]!;
        const highlighted = !dimming || (hoverSet.has(link.source) && hoverSet.has(link.target));
        linkLayer.moveTo(x1, y1).lineTo(x2, y2);
        linkLayer.stroke({
          width: settings.linkThickness * (1 + Math.log2(link.count)),
          color: palette.line,
          alpha: highlighted ? 1 : DIM_ALPHA,
        });
      }
      if (settings.showArrows && camK >= ARROW_MIN_ZOOM) {
        for (const link of model.links) {
          const highlighted = !dimming || (hoverSet.has(link.source) && hoverSet.has(link.target));
          if (!highlighted) continue;
          const x1 = positions[link.source * 2]!;
          const y1 = positions[link.source * 2 + 1]!;
          const x2 = positions[link.target * 2]!;
          const y2 = positions[link.target * 2 + 1]!;
          const dx = x2 - x1;
          const dy = y2 - y1;
          const length = Math.hypot(dx, dy);
          if (length < 1e-6) continue;
          const targetRadius = nodeRadius(model.nodes[link.target]!.degree, settings.nodeSize);
          const size = Math.min(10, 3 + targetRadius * 0.35);
          const ux = dx / length;
          const uy = dy / length;
          const tipX = x2 - ux * (targetRadius + 1);
          const tipY = y2 - uy * (targetRadius + 1);
          arrowLayer
            .moveTo(tipX, tipY)
            .lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55)
            .lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55)
            .closePath()
            .fill({ color: palette.line, alpha: 1 });
        }
      }
    }

    for (let index = 0; index < sprites.length; index += 1) {
      const sprite = sprites[index]!;
      const radius = nodeRadius(model.nodes[index]!.degree, settings.nodeSize);
      sprite.position.set(positions[index * 2]!, positions[index * 2 + 1]!);
      sprite.scale.set(radius / CIRCLE_RADIUS);
      const isActive = activeId !== null && model.nodes[index]!.id === activeId;
      sprite.tint = isActive ? palette.focused : kindColor(index);
      sprite.alpha = !dimming || hoverSet.has(index) ? 1 : DIM_ALPHA;
    }

    // Labels: pooled, viewport-culled, fade-thresholded; hover always labeled.
    for (const text of labelPool) text.visible = false;
    const width = app.canvas.clientWidth || 1;
    const height = app.canvas.clientHeight || 1;
    const threshold = settings.textFadeThreshold;
    const fadeStart = threshold * 0.5;
    const zoomAlpha = threshold <= 0 ? 1 : camK <= fadeStart ? 0 : Math.min(1, (camK - fadeStart) / (threshold - fadeStart || 1));
    if (count > 0 && (zoomAlpha > 0 || hovered !== null)) {
      const candidates: number[] = [];
      for (let index = 0; index < count; index += 1) {
        if (index === hovered) continue;
        const sx = positions[index * 2]! * camK + camX;
        const sy = positions[index * 2 + 1]! * camK + camY;
        if (sx < -50 || sy < -20 || sx > width + 50 || sy > height + 20) continue;
        candidates.push(index);
      }
      candidates.sort((a, b) => model.nodes[b]!.degree - model.nodes[a]!.degree);
      let slot = 0;
      const place = (index: number, alpha: number) => {
        if (slot >= labelPool.length) return;
        const text = labelPool[slot++]!;
        const node = model.nodes[index]!;
        const radius = nodeRadius(node.degree, settings.nodeSize);
        text.text = node.title ?? node.path;
        text.position.set(positions[index * 2]!, positions[index * 2 + 1]! - radius - 4);
        text.alpha = alpha;
        text.style.fill = palette.label;
        text.visible = true;
      };
      if (hovered !== null) place(hovered, 1);
      if (zoomAlpha > 0)
        for (const index of candidates) {
          if (slot >= labelPool.length) break;
          const isNeighbour = dimming && hoverSet.has(index);
          place(index, isNeighbour ? 1 : zoomAlpha);
        }
    }
  };

  app.ticker.add(() => {
    if (destroyed) return;
    if (!dirty) {
      // Idle graph: stop the ticker until the next dirty event.
      if (hovered === null) app.ticker.stop();
      return;
    }
    dirty = false;
    draw();
  });

  // d3-zoom camera.
  const canvasSelection: Selection<HTMLCanvasElement, unknown, null, undefined> = select(app.canvas);
  const zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([0.05, 10])
    .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
      camX = event.transform.x;
      camY = event.transform.y;
      camK = event.transform.k;
      world.position.set(camX, camY);
      world.scale.set(camK);
      markDirty();
    });
  canvasSelection.call(zoomBehavior);

  const zoomToFit = () => {
    const count = model.nodes.length;
    const width = app.canvas.clientWidth || 1;
    const height = app.canvas.clientHeight || 1;
    if (count === 0) {
      zoomBehavior.transform(canvasSelection, zoomIdentity.translate(width / 2, height / 2));
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < count; index += 1) {
      const x = positions[index * 2]!;
      const y = positions[index * 2 + 1]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const k = Math.min(2, Math.min((width * 0.9) / spanX, (height * 0.9) / spanY));
    zoomBehavior.transform(
      canvasSelection,
      zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-(minX + maxX) / 2, -(minY + maxY) / 2),
    );
  };

  // Drag-to-pin vs click-to-open, distinguished by a movement threshold.
  let dragIndex: number | null = null;
  let downAt: { x: number; y: number } | null = null;
  let moved = false;

  const canvasPoint = (event: PointerEvent) => {
    const rect = app.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    app.canvas.setPointerCapture?.(event.pointerId);
    const point = canvasPoint(event);
    downAt = point;
    moved = false;
    const hit = hitTest(point.x, point.y);
    if (hit >= 0) {
      dragIndex = hit;
      callbacks.onDragStart(hit);
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    const point = canvasPoint(event);
    if (dragIndex !== null) {
      if (downAt && Math.hypot(point.x - downAt.x, point.y - downAt.y) > 4) moved = true;
      if (moved) {
        const worldPoint = screenToWorld(point.x, point.y);
        callbacks.onDragMove(dragIndex, worldPoint.x, worldPoint.y);
      }
      return;
    }
    const hit = hitTest(point.x, point.y);
    setHovered(hit >= 0 ? hit : null);
  };
  const onPointerUp = () => {
    if (dragIndex !== null) {
      const finished = dragIndex;
      const wasClick = !moved;
      dragIndex = null;
      downAt = null;
      callbacks.onDragEnd(finished);
      if (wasClick) {
        const id = model.nodes[finished]?.id;
        if (id !== undefined) callbacks.onNodeClick(id);
      }
      return;
    }
    downAt = null;
  };
  const onPointerLeave = () => {
    if (dragIndex === null) setHovered(null);
  };

  app.canvas.addEventListener('pointerdown', onPointerDown);
  app.canvas.addEventListener('pointermove', onPointerMove);
  app.canvas.addEventListener('pointerup', onPointerUp);
  app.canvas.addEventListener('pointerleave', onPointerLeave);

  // Obsidian's keyboard camera bindings on the focusable host.
  host.tabIndex = 0;
  const onKeyDown = (event: KeyboardEvent) => {
    const step = (event.shiftKey ? 200 : 40) / camK;
    let handled = true;
    switch (event.key) {
      case '+':
      case '=':
        zoomBehavior.scaleBy(canvasSelection, 1.25);
        break;
      case '-':
      case '_':
        zoomBehavior.scaleBy(canvasSelection, 1 / 1.25);
        break;
      case 'ArrowLeft':
        zoomBehavior.translateBy(canvasSelection, step * camK, 0);
        break;
      case 'ArrowRight':
        zoomBehavior.translateBy(canvasSelection, -step * camK, 0);
        break;
      case 'ArrowUp':
        zoomBehavior.translateBy(canvasSelection, 0, step * camK);
        break;
      case 'ArrowDown':
        zoomBehavior.translateBy(canvasSelection, 0, -step * camK);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };
  host.addEventListener('keydown', onKeyDown);

  const resizeObserver = new ResizeObserver(() => markDirty());
  resizeObserver.observe(host);

  return {
    setModel(next, colors) {
      model = next;
      groupColors = colors;
      // Sync the sprite pool with the node count.
      while (sprites.length < model.nodes.length) {
        const sprite = new PIXI.Sprite(circleTexture);
        sprite.anchor.set(0.5);
        nodeLayer.addChild(sprite);
        sprites.push(sprite);
      }
      while (sprites.length > model.nodes.length) {
        const sprite = sprites.pop()!;
        nodeLayer.removeChild(sprite);
        sprite.destroy();
      }
      hovered = null;
      hoverSet = new Set();
      quadVersion = -1;
      markDirty();
    },
    setPositions(next) {
      if (positions.length !== next.length) positions = new Float32Array(next.length);
      positions.set(next);
      positionsVersion += 1;
      markDirty();
    },
    setSettings(next) {
      settings = next;
      markDirty();
    },
    setTheme(next) {
      palette = next;
      markDirty();
    },
    setActive(id) {
      activeId = id;
      markDirty();
    },
    zoomToFit,
    screenToWorld,
    destroy() {
      destroyed = true;
      resizeObserver.disconnect();
      host.removeEventListener('keydown', onKeyDown);
      app.canvas.removeEventListener('pointerdown', onPointerDown);
      app.canvas.removeEventListener('pointermove', onPointerMove);
      app.canvas.removeEventListener('pointerup', onPointerUp);
      app.canvas.removeEventListener('pointerleave', onPointerLeave);
      canvasSelection.on('.zoom', null);
      app.destroy(true, { children: true });
    },
  };
}
