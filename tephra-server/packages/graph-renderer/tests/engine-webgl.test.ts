// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SceneFrame } from '../src/engine/types';
import {
  arrowSize,
  compactRingIndices,
  createWebGLBackend,
  growCapacity,
  nodeTextureRows,
  NODE_TEXTURE_WIDTH,
  packNodeTexels,
  syncEdgeEndpoints,
} from '../src/engine/webgl';

describe('pure helpers', () => {
  it('growCapacity grows geometrically and keeps capacity when it fits', () => {
    expect(growCapacity(0, 1)).toBe(64);
    expect(growCapacity(64, 64)).toBe(64);
    expect(growCapacity(64, 65)).toBe(128);
    expect(growCapacity(128, 1000)).toBe(1024);
    expect(growCapacity(0, 5, 4)).toBe(8);
  });

  it('arrowSize clamps 6k into [4, 12]', () => {
    expect(arrowSize(0.1)).toBe(4);
    expect(arrowSize(1)).toBe(6);
    expect(arrowSize(5)).toBe(12);
  });

  it('packNodeTexels interleaves x, y, r, 0', () => {
    const out = new Float32Array(12).fill(9);
    packNodeTexels(
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
      new Float32Array([7, 8, 9]),
      2,
      out,
    );
    expect(Array.from(out)).toEqual([1, 4, 7, 0, 2, 5, 8, 0, 9, 9, 9, 9]);
  });

  it('nodeTextureRows rounds up and is at least 1', () => {
    expect(nodeTextureRows(0)).toBe(1);
    expect(nodeTextureRows(NODE_TEXTURE_WIDTH)).toBe(1);
    expect(nodeTextureRows(NODE_TEXTURE_WIDTH + 1)).toBe(2);
  });

  it('compactRingIndices collects ringed node indices', () => {
    const out = new Uint32Array(5);
    expect(compactRingIndices(new Uint8Array([0, 1, 0, 1, 1]), 4, out)).toBe(2);
    expect(Array.from(out.subarray(0, 2))).toEqual([1, 3]);
  });

  it('syncEdgeEndpoints reports changes only when topology differs', () => {
    const shadow = new Uint32Array(4);
    const s = new Uint32Array([1, 2]);
    const t = new Uint32Array([3, 4]);
    expect(syncEdgeEndpoints(s, t, 2, shadow)).toBe(true);
    expect(Array.from(shadow)).toEqual([1, 3, 2, 4]);
    expect(syncEdgeEndpoints(s, t, 2, shadow)).toBe(false);
    t[1] = 0;
    expect(syncEdgeEndpoints(s, t, 2, shadow)).toBe(true);
    expect(shadow[3]).toBe(0);
  });
});

describe('createWebGLBackend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null under jsdom (no WebGL2) without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => createWebGLBackend()).not.toThrow();
    expect(createWebGLBackend()).toBeNull();
  });

  /**
   * Minimal fake WebGL2 context: every GL constant is a number, every method
   * is a recorded no-op returning an opaque object (truthy, so compile/link
   * status checks pass).
   */
  function fakeGL(): { gl: WebGL2RenderingContext; calls: Map<string, number> } {
    const calls = new Map<string, number>();
    const overrides: Record<string, unknown> = {
      isContextLost: () => false,
      getExtension: () => null,
    };
    const fns = new Map<string, (...args: unknown[]) => unknown>();
    const gl = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop in overrides) return overrides[prop];
          if (/^[A-Z0-9_]+$/.test(prop)) return 1;
          let fn = fns.get(prop);
          if (!fn) {
            fn = () => {
              calls.set(prop, (calls.get(prop) ?? 0) + 1);
              return {};
            };
            fns.set(prop, fn);
          }
          return fn;
        },
      },
    ) as WebGL2RenderingContext;
    return { gl, calls };
  }

  function frame(nodes: number, edges: number): SceneFrame {
    const edgeSource = new Uint32Array(edges);
    const edgeTarget = new Uint32Array(edges);
    for (let i = 0; i < edges; i++) {
      edgeSource[i] = i % nodes;
      edgeTarget[i] = (i + 1) % nodes;
    }
    const nodeRing = new Uint8Array(nodes);
    nodeRing[0] = 1;
    return {
      camera: { x: 0, y: 0, k: 1 },
      viewport: { width: 800, height: 600 },
      dpr: 2,
      nodeCount: nodes,
      x: new Float32Array(nodes).map((_, i) => i),
      y: new Float32Array(nodes),
      radius: new Float32Array(nodes).fill(4),
      nodeRGBA: new Float32Array(nodes * 4).fill(1),
      nodeRing,
      ringRGBA: new Float32Array([1, 0, 0, 1]),
      edgeCount: edges,
      edgeSource,
      edgeTarget,
      edgeWidth: new Float32Array(edges).fill(1),
      edgeRGBA: new Float32Array(edges * 4).fill(0.5),
      arrows: true,
    };
  }

  it('issues a constant number of draw calls (≤ 4) regardless of graph size', () => {
    const { gl, calls } = fakeGL();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      gl as unknown as RenderingContext,
    );
    const backend = createWebGLBackend();
    expect(backend).not.toBeNull();
    if (!backend) return;
    expect(backend.kind).toBe('webgl2');
    backend.resize(800, 600, 2);
    expect(backend.canvas.width).toBe(1600);
    expect(backend.canvas.height).toBe(1200);

    const draws: number[] = [];
    const bufferAllocs: number[] = [];
    for (const n of [10, 5000, 5000]) {
      calls.clear();
      backend.draw(frame(n, n * 2));
      draws.push(calls.get('drawArraysInstanced') ?? 0);
      bufferAllocs.push(calls.get('bufferData') ?? 0);
    }
    expect(draws).toEqual([4, 4, 4]);
    // Same-size frame: no buffer reallocation.
    expect(bufferAllocs[2]).toBe(0);

    document.body.appendChild(backend.canvas);
    backend.destroy();
    expect(backend.canvas.isConnected).toBe(false);
  });

  it('becomes a no-op after webglcontextlost', () => {
    const { gl, calls } = fakeGL();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      gl as unknown as RenderingContext,
    );
    const backend = createWebGLBackend();
    if (!backend) throw new Error('expected backend');
    const event = new Event('webglcontextlost', { cancelable: true });
    backend.canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(backend.isLost()).toBe(true);
    calls.clear();
    backend.draw(frame(10, 10));
    expect(calls.get('drawArraysInstanced') ?? 0).toBe(0);
    backend.destroy();
  });
});
