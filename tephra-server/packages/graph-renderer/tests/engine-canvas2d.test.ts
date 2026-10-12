import { describe, expect, it } from 'vitest';

import { createCanvas2DBackend } from '../src/engine/canvas2d';
import type { SceneFrame } from '../src/engine/types';

/** Minimal recording stand-in for CanvasRenderingContext2D. */
class FakeContext {
  calls: Record<string, number> = {};
  strokeStyles: string[] = [];
  fillStyles: string[] = [];
  arcs: [number, number, number][] = [];
  rects = 0;
  moves = 0;
  transforms: number[][] = [];
  lineCap = 'butt';
  lineWidth = 1;
  private _stroke = '';
  private _fill = '';
  get strokeStyle(): string {
    return this._stroke;
  }
  set strokeStyle(v: string) {
    this._stroke = v;
  }
  get fillStyle(): string {
    return this._fill;
  }
  set fillStyle(v: string) {
    this._fill = v;
  }
  private bump(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  count(name: string): number {
    return this.calls[name] ?? 0;
  }
  reset(): void {
    this.calls = {};
    this.strokeStyles = [];
    this.fillStyles = [];
    this.arcs = [];
    this.rects = 0;
    this.moves = 0;
    this.moveList = [];
    this.transforms = [];
  }
  setTransform(...args: number[]): void {
    this.transforms.push(args);
  }
  clearRect(): void {
    this.bump('clearRect');
  }
  beginPath(): void {
    this.bump('beginPath');
  }
  closePath(): void {
    this.bump('closePath');
  }
  moveList: [number, number][] = [];
  moveTo(x: number, y: number): void {
    this.moves++;
    this.moveList.push([x, y]);
  }
  lineTo(): void {
    this.bump('lineTo');
  }
  arc(x: number, y: number, r: number): void {
    this.arcs.push([x, y, r]);
  }
  rect(): void {
    this.rects++;
  }
  stroke(): void {
    this.bump('stroke');
    this.strokeStyles.push(this._stroke);
  }
  fill(): void {
    this.bump('fill');
    this.fillStyles.push(this._fill);
  }
}

function fakeCanvas(ctx: FakeContext | null): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {},
    parentNode: null,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

function setup() {
  const ctx = new FakeContext();
  const canvas = fakeCanvas(ctx);
  const backend = createCanvas2DBackend({ canvas });
  if (!backend) throw new Error('backend expected');
  return { ctx, canvas, backend };
}

const PALETTE = [
  [1, 0, 0, 1],
  [0, 1, 0, 1],
  [0, 0, 1, 1],
] as const;

/** Grid of nodes within a 1000x1000 viewport at k=1, 3 colours. */
function makeFrame(nodeCount: number, edgeCount: number): SceneFrame {
  const x = new Float32Array(nodeCount);
  const y = new Float32Array(nodeCount);
  const radius = new Float32Array(nodeCount).fill(4);
  const nodeRGBA = new Float32Array(nodeCount * 4);
  const side = Math.ceil(Math.sqrt(nodeCount));
  for (let i = 0; i < nodeCount; i++) {
    x[i] = 10 + (i % side) * (980 / side);
    y[i] = 10 + Math.floor(i / side) * (980 / side);
    nodeRGBA.set(PALETTE[i % 3]!, i * 4);
  }
  const edgeSource = new Uint32Array(edgeCount);
  const edgeTarget = new Uint32Array(edgeCount);
  const edgeWidth = new Float32Array(edgeCount);
  const edgeRGBA = new Float32Array(edgeCount * 4);
  for (let e = 0; e < edgeCount; e++) {
    edgeSource[e] = e % nodeCount;
    edgeTarget[e] = (e * 7 + 1) % nodeCount;
    edgeWidth[e] = 1;
    edgeRGBA.set(PALETTE[e % 3]!, e * 4);
  }
  return {
    camera: { x: 0, y: 0, k: 1 },
    viewport: { width: 1000, height: 1000 },
    dpr: 2,
    nodeCount,
    x,
    y,
    radius,
    nodeRGBA,
    nodeRing: new Uint8Array(nodeCount),
    ringRGBA: new Float32Array([1, 0, 0, 1]),
    edgeCount,
    edgeSource,
    edgeTarget,
    edgeWidth,
    edgeRGBA,
    arrows: false,
  };
}

describe('createCanvas2DBackend', () => {
  it('returns null when getContext returns null', () => {
    expect(createCanvas2DBackend({ canvas: fakeCanvas(null) })).toBeNull();
    expect(
      createCanvas2DBackend({ canvas: fakeCanvas(new FakeContext()), context: null }),
    ).toBeNull();
  });

  it('styles its canvas, resizes by dpr and never reports lost', () => {
    const { canvas, backend } = setup();
    expect(backend.kind).toBe('canvas2d');
    expect(backend.canvas).toBe(canvas);
    const style = canvas.style as unknown as Record<string, string>;
    expect(style.position).toBe('absolute');
    expect(style.display).toBe('block');
    expect(style.width).toBe('100%');
    backend.resize(300, 200, 2);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(400);
    expect(backend.isLost()).toBe(false);
  });

  it('batches 1 000 nodes / 2 000 edges into one call per colour', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(1000, 2000);
    backend.draw(frame);
    // One stroke per edge colour (all widths equal), one fill per node colour.
    expect(ctx.count('stroke')).toBe(3);
    expect(ctx.count('fill')).toBe(3);
    expect(ctx.count('beginPath')).toBe(6);
    expect(ctx.count('lineTo')).toBe(2000);
    expect(ctx.arcs.length).toBe(1000);
    expect(ctx.transforms).toContainEqual([2, 0, 0, 2, 0, 0]);

    // Steady-state redraw: same batching.
    ctx.reset();
    backend.draw(frame);
    expect(ctx.count('stroke')).toBe(3);
    expect(ctx.count('fill')).toBe(3);
  });

  it('splits edge buckets by width', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(10, 20);
    frame.edgeRGBA.fill(1);
    for (let e = 0; e < 20; e++) frame.edgeWidth[e] = e % 2 === 0 ? 1 : 3;
    backend.draw(frame);
    expect(ctx.count('stroke')).toBe(2);
  });

  it('culls off-screen nodes and edges', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(4, 2);
    frame.x.set([100, 200, -500, -600]);
    frame.y.set([100, 200, 100, 200]);
    frame.edgeSource.set([0, 2]);
    frame.edgeTarget.set([1, 3]);
    backend.draw(frame);
    expect(ctx.arcs.length).toBe(2);
    expect(ctx.count('lineTo')).toBe(1);
  });

  it('applies the camera transform inline', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(1, 0);
    frame.x[0] = 10;
    frame.y[0] = 20;
    frame.radius[0] = 5;
    frame.camera = { x: 50, y: 60, k: 2 };
    backend.draw(frame);
    expect(ctx.arcs).toEqual([[70, 100, 10]]);
  });

  it('draws tiny nodes as rects and skips transparent ones', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(3, 0);
    frame.radius.set([0.1, 4, 4]);
    frame.nodeRGBA[2 * 4 + 3] = 0;
    backend.draw(frame);
    expect(ctx.rects).toBe(1);
    expect(ctx.arcs.length).toBe(1);
  });

  it('strokes all focus rings at once', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(30, 0);
    frame.nodeRGBA.fill(1);
    frame.nodeRing[0] = 1;
    frame.nodeRing[5] = 1;
    backend.draw(frame);
    expect(ctx.count('fill')).toBe(1);
    expect(ctx.count('stroke')).toBe(1);
    const ringArcs = ctx.arcs.filter(([, , r]) => r === 7);
    expect(ringArcs.length).toBe(2);
  });

  it('batches arrow heads by colour with the tip at the target rim', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(300, 600);
    frame.arrows = true;
    backend.draw(frame);
    // 3 node fills + 3 arrow fills.
    expect(ctx.count('fill')).toBe(6);
    expect(ctx.count('closePath')).toBeGreaterThan(0);
    expect(ctx.count('closePath')).toBeLessThanOrEqual(600);
  });

  it('places a single arrow tip at target screen radius + 2', () => {
    const { ctx, backend } = setup();
    const frame = makeFrame(2, 1);
    frame.x.set([100, 200]);
    frame.y.set([100, 100]);
    frame.radius.set([4, 5]);
    frame.edgeSource[0] = 0;
    frame.edgeTarget[0] = 1;
    frame.arrows = true;
    frame.camera = { x: 0, y: 0, k: 2 };
    frame.x.set([50, 100]);
    frame.y.set([50, 50]);
    backend.draw(frame);
    // Target at screen (200, 100), radius 10 → tip at x = 200 - 12.
    expect(ctx.moveList).toContainEqual([188, 100]);
  });
});
