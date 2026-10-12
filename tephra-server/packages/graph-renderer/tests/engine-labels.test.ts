import { describe, expect, it } from 'vitest';

import { createLabelLayer, labelFadeOpacity, LABEL_FONT } from '../src/engine/labels';
import type { LabelFrame, SceneFrame } from '../src/engine/types';

class FakeContext {
  texts: { text: string; x: number; y: number; alpha: number }[] = [];
  measureCalls = 0;
  alphaWrites = 0;
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  fillStyle = '';
  private _alpha = 1;
  get globalAlpha(): number {
    return this._alpha;
  }
  set globalAlpha(v: number) {
    this.alphaWrites++;
    this._alpha = v;
  }
  setTransform(): void {}
  clearRect(): void {}
  measureText(text: string): { width: number } {
    this.measureCalls++;
    return { width: text.length * 6 };
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, alpha: this._alpha });
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
  const layer = createLabelLayer({ canvas });
  if (!layer) throw new Error('layer expected');
  return { ctx, canvas, layer };
}

/** Nodes on a well-spaced grid (no overlaps) in a 1000x1000 viewport. */
function makeFrames(n: number, spacing = 100): { frame: SceneFrame; labels: LabelFrame } {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const cols = Math.floor(900 / spacing);
  for (let i = 0; i < n; i++) {
    x[i] = 50 + (i % cols) * spacing;
    y[i] = 20 + Math.floor(i / cols) * 40;
  }
  const frame: SceneFrame = {
    camera: { x: 0, y: 0, k: 1 },
    viewport: { width: 1000, height: 1000 },
    dpr: 1,
    nodeCount: n,
    x,
    y,
    radius: new Float32Array(n).fill(3),
    nodeRGBA: new Float32Array(n * 4).fill(1),
    nodeRing: new Uint8Array(n),
    ringRGBA: new Float32Array(4),
    edgeCount: 0,
    edgeSource: new Uint32Array(0),
    edgeTarget: new Uint32Array(0),
    edgeWidth: new Float32Array(0),
    edgeRGBA: new Float32Array(0),
    arrows: false,
  };
  const labels: LabelFrame = {
    text: Array.from({ length: n }, (_, i) => `n${i}`),
    opacity: new Float32Array(n).fill(1),
    order: Uint32Array.from({ length: n }, (_, i) => i),
    color: '#222',
    maxLabels: 400,
  };
  return { frame, labels };
}

describe('labelFadeOpacity', () => {
  it('implements clamp((k - t) / t, 0, 1) with t = threshold * 2', () => {
    expect(labelFadeOpacity(1, 0)).toBe(0);
    expect(labelFadeOpacity(5, -1)).toBe(0);
    expect(labelFadeOpacity(0.5, 0.5)).toBe(0); // t = 1, k < t
    expect(labelFadeOpacity(1, 0.5)).toBe(0);
    expect(labelFadeOpacity(1.5, 0.5)).toBeCloseTo(0.5);
    expect(labelFadeOpacity(2, 0.5)).toBe(1);
    expect(labelFadeOpacity(8, 0.5)).toBe(1);
  });
});

describe('createLabelLayer', () => {
  it('returns null without a 2D context', () => {
    expect(createLabelLayer({ canvas: fakeCanvas(null) })).toBeNull();
  });

  it('configures a pointer-transparent overlay canvas', () => {
    const { canvas, layer } = setup();
    const style = canvas.style as unknown as Record<string, string>;
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('absolute');
    layer.resize(100, 50, 2);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
  });

  it('draws centred labels below the node rim with the configured style', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(1);
    frame.x[0] = 100;
    frame.y[0] = 200;
    frame.radius[0] = 5;
    frame.camera = { x: 10, y: 20, k: 2 };
    layer.draw(frame, labels);
    expect(ctx.font).toBe(LABEL_FONT);
    expect(ctx.textAlign).toBe('center');
    expect(ctx.textBaseline).toBe('top');
    expect(ctx.fillStyle).toBe('#222');
    expect(ctx.texts).toEqual([{ text: 'n0', x: 210, y: 420 + 10 + 4, alpha: 1 }]);
  });

  it('respects maxLabels', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(100);
    labels.maxLabels = 7;
    layer.draw(frame, labels);
    expect(ctx.texts.length).toBe(7);
    expect(ctx.texts.map((t) => t.text)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('skips near-zero opacity and sets globalAlpha only on change', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(6);
    labels.opacity.set([1, 0, 0.005, 1, 0.5, 0.5]);
    layer.draw(frame, labels);
    expect(ctx.texts.map((t) => t.text)).toEqual(['n0', 'n3', 'n4', 'n5']);
    expect(ctx.texts.map((t) => t.alpha)).toEqual([1, 1, 0.5, 0.5]);
    // 1 (first label), 0.5, then the reset to 1 at the end.
    expect(ctx.alphaWrites).toBe(3);
  });

  it('skips overlapping labels, keeping higher-priority ones', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(3);
    frame.x.set([300, 305, 600]);
    frame.y.set([300, 302, 300]);
    labels.order = Uint32Array.from([1, 0, 2]);
    layer.draw(frame, labels);
    expect(ctx.texts.map((t) => t.text)).toEqual(['n1', 'n2']);
  });

  it('skips labels whose anchor is outside the viewport', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(3);
    frame.x.set([-500, 500, 3000]);
    frame.y.set([500, 500, 500]);
    layer.draw(frame, labels);
    expect(ctx.texts.map((t) => t.text)).toEqual(['n1']);
  });

  it('caches measurements until invalidated or the node count changes', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(5);
    layer.draw(frame, labels);
    expect(ctx.measureCalls).toBe(5);
    layer.draw(frame, labels);
    expect(ctx.measureCalls).toBe(5);
    layer.invalidate();
    layer.draw(frame, labels);
    expect(ctx.measureCalls).toBe(10);
    const next = makeFrames(4);
    layer.draw(next.frame, next.labels);
    expect(ctx.measureCalls).toBe(14);
  });

  it('ellipsizes long labels', () => {
    const { ctx, layer } = setup();
    const { frame, labels } = makeFrames(1);
    labels.text = ['x'.repeat(80)];
    layer.draw(frame, labels);
    const drawn = ctx.texts[0]!.text;
    expect(drawn.length).toBe(40);
    expect(drawn.endsWith('…')).toBe(true);
  });
});
