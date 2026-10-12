// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_ZOOM } from '../src/camera';
import { createGraphRenderer, type GraphRendererOptions } from '../src/engine/renderer';
import type { DrawBackend, LabelLayer, SceneFrame } from '../src/engine/types';
import { buildGraphModel, type GraphInput, type GraphModel } from '../src/model';
import { FALLBACK_GRAPH_PALETTE } from '../src/palette';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from '../src/settings';

// — Fake rAF —
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafNext = 1;
let rafTime = 0;
const cancelSpy = vi.fn();

function flush(maxFrames = 1): number {
  let ran = 0;
  while (ran < maxFrames && rafQueue.length > 0) {
    const batch = rafQueue;
    rafQueue = [];
    rafTime += 16;
    for (const { cb } of batch) cb(rafTime);
    ran += 1;
  }
  return ran;
}

beforeEach(() => {
  rafQueue = [];
  rafNext = 1;
  rafTime = 0;
  cancelSpy.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = rafNext++;
    rafQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    cancelSpy(id);
    rafQueue = rafQueue.filter((f) => f.id !== id);
  });
  // jsdom has no canvas implementation: make every context request fail
  // quietly so default backends resolve to null (headless).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// — Fixtures —
function payload(ids: string[], edges: Array<[number, number]>): GraphInput {
  return {
    nodes: ids.map((id) => ({ id, path: `${id}.md`, title: null, kind: 'note' as const, tags: [] })),
    edges: edges.map(([s, t]) => ({ s, t, count: 1, embeds: 0 })),
  };
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 3],
  [3, 4],
  [4, 5],
];

function graph(): GraphModel {
  return buildGraphModel(payload(IDS, EDGES));
}

const settings: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS };
const colors = (m: GraphModel): Array<string | null> => m.nodes.map(() => null);

function makeHost(): HTMLDivElement {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 600 });
  document.body.appendChild(host);
  return host;
}

interface FakeBackend extends DrawBackend {
  last: SceneFrame | null;
  draws: number;
  lost: boolean;
  destroyed: boolean;
}

function fakeBackend(): FakeBackend {
  const canvas = document.createElement('canvas');
  const b: FakeBackend = {
    kind: 'webgl2',
    canvas,
    last: null,
    draws: 0,
    lost: false,
    destroyed: false,
    resize: vi.fn(),
    draw(frame: SceneFrame) {
      b.last = frame;
      b.draws += 1;
    },
    isLost: () => b.lost,
    destroy() {
      b.destroyed = true;
    },
  };
  return b;
}

function fakeLabels(): LabelLayer & { draws: number } {
  const canvas = document.createElement('canvas');
  const l = {
    canvas,
    draws: 0,
    resize: vi.fn(),
    draw: () => {
      l.draws += 1;
    },
    invalidate: vi.fn(),
    destroy: vi.fn(),
  };
  return l;
}

function setup(extra: GraphRendererOptions = {}) {
  const host = makeHost();
  const backend = fakeBackend();
  const labels = fakeLabels();
  const onReady = vi.fn();
  const onNodeClick = vi.fn();
  const onNodeHover = vi.fn();
  const renderer = createGraphRenderer(host, {
    seed: 7,
    onReady,
    onNodeClick,
    onNodeHover,
    backendFactory: () => backend,
    labelLayerFactory: () => labels,
    ...extra,
  });
  return { host, backend, labels, renderer, onReady, onNodeClick, onNodeHover };
}

function screenOf(frame: SceneFrame, i: number): { x: number; y: number } {
  return {
    x: frame.x[i]! * frame.camera.k + frame.camera.x,
    y: frame.y[i]! * frame.camera.k + frame.camera.y,
  };
}

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  host.dispatchEvent(
    new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
  );
}

describe('graph renderer (headless)', () => {
  it('runs without WebGL or 2D and fires onReady after the first frame', () => {
    const host = makeHost();
    const onReady = vi.fn();
    const renderer = createGraphRenderer(host, { onReady });
    expect(host.tabIndex).toBe(0);
    expect(host.getAttribute('aria-label')).toMatch(/Graph view/);
    expect(host.style.position).toBe('relative');
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    renderer.setModel(graph(), colors(graph()), FALLBACK_GRAPH_PALETTE, settings);
    expect(onReady).not.toHaveBeenCalled();
    flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    renderer.setSelected('a');
    renderer.animate();
    flush(5);
    renderer.destroy();
    expect(rafQueue).toHaveLength(0);
  });
});

describe('graph renderer with a fake backend', () => {
  it('stacks backend + label canvases and draws frame data', () => {
    const { host, backend, labels, renderer, onReady } = setup();
    expect(host.children[0]).toBe(backend.canvas);
    expect(host.children[1]).toBe(labels.canvas);
    expect(labels.canvas.style.pointerEvents).toBe('none');
    expect(backend.resize).toHaveBeenCalledWith(800, 600, 1);
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(backend.draws).toBe(1);
    expect(labels.draws).toBe(1);
    const f = backend.last!;
    expect(f.nodeCount).toBe(6);
    expect(f.edgeCount).toBe(5);
    expect(f.viewport).toEqual({ width: 800, height: 600 });
    // Warm-up ran before the first paint: nodes have left the origin.
    expect(Number.isFinite(f.x[0])).toBe(true);
    // Auto-fit keeps every node on screen.
    for (let i = 0; i < 6; i += 1) {
      const p = screenOf(f, i);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
    }
    renderer.destroy();
  });

  it('stops requesting frames once settled and idles until a redraw', () => {
    const { backend, renderer } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    const frames = flush(5000);
    expect(frames).toBeLessThan(5000);
    expect(rafQueue).toHaveLength(0);
    const draws = backend.draws;
    renderer.setSelected('b');
    expect(flush(10)).toBe(1);
    expect(backend.draws).toBe(draws + 1);
    expect(backend.last!.nodeRing[1]).toBe(1);
    renderer.animate();
    expect(flush(3)).toBe(3);
    renderer.destroy();
  });

  it('keeps the simulation on same-id setModel and settings-only changes', () => {
    const { backend, renderer, onReady } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(20);
    const x = backend.last!.x;
    const before = Array.from(x);
    // Same ids, new model object, new palette, new group colours.
    const m2 = graph();
    renderer.setModel(
      m2,
      m2.nodes.map(() => '#ff0000'),
      { ...FALLBACK_GRAPH_PALETTE, line: '#123456' },
      { ...settings, showArrows: true, textFadeThreshold: 1 },
    );
    expect(Array.from(x)).toEqual(before);
    flush();
    expect(backend.last!.x).toBe(x);
    expect(backend.last!.arrows).toBe(true);
    expect(Array.from(backend.last!.nodeRGBA.slice(0, 4))).toEqual([1, 0, 0, 1]);
    // Size + force sliders: positions stay, no rebuild.
    const mid = Array.from(backend.last!.x);
    renderer.setModel(m2, colors(m2), FALLBACK_GRAPH_PALETTE, {
      ...settings,
      nodeSize: 2,
      repelForce: 5,
    });
    expect(Array.from(backend.last!.x)).toEqual(mid);
    flush();
    expect(backend.last!.x).toBe(x);
    expect(onReady).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('seeds a new simulation from surviving positions when ids change', () => {
    const { backend, renderer, onReady } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const old = backend.last!;
    const ax = old.x[0]!;
    const ay = old.y[0]!;
    const oldX = old.x;
    const m2 = buildGraphModel(payload(['a', 'g', 'b'], [[0, 1], [0, 2]]));
    renderer.setModel(m2, colors(m2), FALLBACK_GRAPH_PALETTE, settings);
    // Before any frame: the new simulation started from a's old position.
    flush();
    const f = backend.last!;
    expect(f.x).not.toBe(oldX);
    expect(f.nodeCount).toBe(3);
    expect(Math.abs(f.x[0]! - ax)).toBeLessThan(25);
    expect(Math.abs(f.y[0]! - ay)).toBeLessThan(25);
    // The new node g started next to its neighbour a, not at the origin spiral.
    expect(Math.hypot(f.x[1]! - f.x[0]!, f.y[1]! - f.y[0]!)).toBeLessThan(60);
    expect(onReady).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it('clicks, hovers, and drags nodes', () => {
    const { host, backend, renderer, onNodeClick, onNodeHover } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const f = backend.last!;
    const p = screenOf(f, 3);

    pointer(host, 'pointermove', p.x, p.y);
    expect(onNodeHover).toHaveBeenLastCalledWith('d');
    expect(host.style.cursor).toBe('pointer');
    host.dispatchEvent(new PointerEvent('pointerleave'));
    expect(onNodeHover).toHaveBeenLastCalledWith(null);

    pointer(host, 'pointerdown', p.x, p.y);
    pointer(host, 'pointerup', p.x + 1, p.y);
    expect(onNodeClick).toHaveBeenCalledWith('d');
    flush(5000);

    // Drag: node follows the pointer (in world space) while pinned.
    const before = backend.last!;
    const q = screenOf(before, 3);
    const startX = before.x[3]!;
    const startY = before.y[3]!;
    const k = before.camera.k;
    pointer(host, 'pointerdown', q.x, q.y);
    pointer(host, 'pointermove', q.x + 80, q.y + 40);
    expect(backend.last!.x[3]).toBeCloseTo(startX + 80 / k, 3);
    expect(backend.last!.y[3]).toBeCloseTo(startY + 40 / k, 3);
    flush(3);
    // Still pinned while the simulation runs hot (alphaTarget 0.3).
    expect(backend.last!.x[3]).toBeCloseTo(startX + 80 / k, 3);
    expect(backend.last!.y[3]).toBeCloseTo(startY + 40 / k, 3);
    expect(rafQueue).toHaveLength(1);
    pointer(host, 'pointerup', q.x + 80, q.y + 40);
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    // Released: forces move it again.
    const pinnedX = backend.last!.x[3]!;
    const pinnedY = backend.last!.y[3]!;
    flush(30);
    const moved =
      backend.last!.x[3]! !== pinnedX || backend.last!.y[3]! !== pinnedY;
    expect(moved).toBe(true);
    expect(flush(5000)).toBeLessThan(5000);
    renderer.destroy();
  });

  it('wheel zooms at the cursor and stops auto-fit', () => {
    const { host, backend, renderer } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const k0 = backend.last!.camera.k;
    const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, cancelable: true });
    host.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    flush();
    const k1 = backend.last!.camera.k;
    expect(k1).toBeCloseTo(Math.min(8, k0 * Math.exp(0.15)), 5);
    const pinch = new WheelEvent('wheel', {
      deltaY: 10,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
      cancelable: true,
    });
    host.dispatchEvent(pinch);
    flush();
    expect(backend.last!.camera.k).toBeCloseTo(k1 * Math.exp(-0.045), 5);
    // Keyboard zoom out.
    host.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }));
    flush();
    expect(backend.last!.camera.k).toBeLessThan(k1);
    renderer.destroy();
  });

  it('fits layouts wider than 1 / MIN_ZOOM and lets wheel zoom out to them', () => {
    // A tiny viewport forces the fit zoom below MIN_ZOOM (0.1), just like a
    // multi-thousand-note vault does in a normal-sized viewport.
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 90 });
    document.body.appendChild(host);
    const backend = fakeBackend();
    const renderer = createGraphRenderer(host, {
      seed: 7,
      backendFactory: () => backend,
      labelLayerFactory: () => fakeLabels(),
    });
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const f = backend.last!;
    expect(f.camera.k).toBeLessThan(MIN_ZOOM);
    for (let i = 0; i < 6; i += 1) {
      const p = screenOf(f, i);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(90);
    }
    // Wheel zoom-out is not clamped back up to MIN_ZOOM.
    const fitK = f.camera.k;
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, clientX: 50, clientY: 45, cancelable: true }));
    flush();
    expect(backend.last!.camera.k).toBeLessThan(fitK);
    expect(backend.last!.camera.k).toBeGreaterThanOrEqual(fitK * 0.5 - 1e-9);
    renderer.destroy();
  });

  it('background drag pans the camera', () => {
    const { host, backend, renderer } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const { x, y } = backend.last!.camera;
    pointer(host, 'pointerdown', 2, 2);
    pointer(host, 'pointermove', 32, 12);
    pointer(host, 'pointerup', 32, 12);
    flush();
    expect(backend.last!.camera.x).toBeCloseTo(x + 30);
    expect(backend.last!.camera.y).toBeCloseTo(y + 10);
    renderer.destroy();
  });

  it('falls back when the backend is lost', () => {
    const { host, backend, renderer } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush();
    backend.lost = true;
    renderer.setSelected('a');
    expect(() => flush(3)).not.toThrow();
    expect(backend.destroyed).toBe(true);
    expect(backend.canvas.parentNode).toBeNull();
    // Canvas2D is unavailable here too, so the renderer keeps going headless.
    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    renderer.destroy();
  });

  it('destroy removes listeners, canvases, and pending frames', () => {
    const { host, backend, labels, renderer, onNodeClick, onNodeHover } = setup();
    const m = graph();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    flush(5000);
    const p = screenOf(backend.last!, 0);
    renderer.animate();
    expect(rafQueue.length).toBe(1);
    renderer.destroy();
    expect(cancelSpy).toHaveBeenCalled();
    expect(rafQueue).toHaveLength(0);
    expect(backend.destroyed).toBe(true);
    expect(labels.destroy).toHaveBeenCalled();
    expect(host.querySelectorAll('canvas')).toHaveLength(0);
    onNodeHover.mockClear();
    pointer(host, 'pointermove', p.x, p.y);
    pointer(host, 'pointerdown', p.x, p.y);
    pointer(host, 'pointerup', p.x, p.y);
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onNodeHover).not.toHaveBeenCalled();
    renderer.setModel(m, colors(m), FALLBACK_GRAPH_PALETTE, settings);
    expect(rafQueue).toHaveLength(0);
  });
});
