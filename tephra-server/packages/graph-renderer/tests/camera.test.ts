import { describe, expect, it } from 'vitest';

import {
  createCamera,
  clampZoom,
  fitView,
  keyboardPan,
  keyboardZoom,
  KEYBOARD_PAN_STEP,
  KEYBOARD_PAN_STEP_SHIFT,
  MAX_ZOOM,
  MIN_ZOOM,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '../src/camera';

describe('worldToScreen / screenToWorld', () => {
  it('round-trips through the camera transform', () => {
    const cam = createCamera({ x: 100, y: -50, k: 2 });
    const s = worldToScreen(10, 20, cam);
    expect(s).toEqual({ x: 120, y: -10 });
    expect(screenToWorld(s.x, s.y, cam)).toEqual({ x: 10, y: 20 });
  });

  it('defaults to identity (origin, k=1)', () => {
    expect(createCamera()).toEqual({ x: 0, y: 0, k: 1 });
    expect(worldToScreen(5, 7, createCamera())).toEqual({ x: 5, y: 7 });
  });
});

describe('pan', () => {
  it('shifts the offset by the screen-pixel delta', () => {
    expect(pan(createCamera({ x: 1, y: 2, k: 3 }), 10, -4)).toEqual({
      x: 11,
      y: -2,
      k: 3,
    });
  });

  it('does not mutate the input camera', () => {
    const cam = createCamera();
    pan(cam, 5, 5);
    expect(cam).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe('keyboardPan', () => {
  it('steps 40px per arrow press', () => {
    expect(KEYBOARD_PAN_STEP).toBe(40);
    expect(keyboardPan(createCamera(), 1, 0)).toEqual({ x: 40, y: 0, k: 1 });
    expect(keyboardPan(createCamera(), 0, -1)).toEqual({ x: 0, y: -40, k: 1 });
  });

  it('steps 120px with Shift', () => {
    expect(KEYBOARD_PAN_STEP_SHIFT).toBe(120);
    expect(keyboardPan(createCamera(), -1, 1, true)).toEqual({
      x: -120,
      y: 120,
      k: 1,
    });
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const cam = createCamera({ x: 100, y: 100, k: 1 });
    const before = screenToWorld(200, 150, cam);
    const after = zoomAt(cam, 200, 150, 2);
    expect(after.k).toBe(2);
    expect(screenToWorld(200, 150, after)).toEqual(before);
  });

  it('zooms out symmetrically', () => {
    const cam = createCamera({ x: 0, y: 0, k: 2 });
    const before = screenToWorld(60, 80, cam);
    const after = zoomAt(cam, 60, 80, 0.5);
    expect(after.k).toBe(1);
    expect(screenToWorld(60, 80, after)).toEqual(before);
  });

  it('clamps to the zoom limits', () => {
    expect(zoomAt(createCamera(), 0, 0, 1000).k).toBe(MAX_ZOOM);
    expect(zoomAt(createCamera(), 0, 0, 1e-6).k).toBe(MIN_ZOOM);
    expect(zoomAt(createCamera({ k: MAX_ZOOM }), 5, 5, 2).k).toBe(MAX_ZOOM);
  });

  it('ignores non-finite or non-positive factors', () => {
    const cam = createCamera({ x: 3, y: 4, k: 2 });
    expect(zoomAt(cam, 0, 0, 0)).toEqual(cam);
    expect(zoomAt(cam, 0, 0, -1)).toEqual(cam);
    expect(zoomAt(cam, 0, 0, Number.NaN)).toEqual(cam);
  });
});

describe('clampZoom', () => {
  it('clamps and falls back for non-finite input', () => {
    expect(clampZoom(999)).toBe(MAX_ZOOM);
    expect(clampZoom(-5)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(2, 1, 3)).toBe(2);
  });
});

describe('keyboardZoom', () => {
  it('zooms around the viewport center', () => {
    const viewport = { width: 800, height: 600 };
    const cam = createCamera({ x: 0, y: 0, k: 1 });
    const before = screenToWorld(400, 300, cam);
    const zoomed = keyboardZoom(cam, 1, viewport);
    expect(zoomed.k).toBeGreaterThan(1);
    expect(screenToWorld(400, 300, zoomed)).toEqual(before);
    const backOut = keyboardZoom(zoomed, -1, viewport);
    expect(backOut.k).toBeCloseTo(1, 10);
  });
});

describe('fitView', () => {
  it('centers the bounding box and fills the viewport', () => {
    const cam = fitView(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      0,
      { width: 800, height: 600 },
      { padding: 0 },
    );
    // min(w/100, h/100) = 6 -> k=6, center (50,50) maps to (400,300).
    expect(cam.k).toBe(6);
    expect(worldToScreen(50, 50, cam)).toEqual({ x: 400, y: 300 });
  });

  it('accepts interleaved Float32Array positions plus per-node radii', () => {
    const cam = fitView(
      new Float32Array([0, 0, 100, 0]),
      [10, 10],
      { width: 220, height: 100 },
      { padding: 0 },
    );
    // Box spans -10..110 x, -10..10 y -> k = min(220/120, 100/20) = 1.833..
    expect(cam.k).toBeCloseTo(220 / 120, 10);
    const center = worldToScreen(50, 0, cam);
    expect(center.x).toBeCloseTo(110, 10);
    expect(center.y).toBeCloseTo(50, 10);
  });

  it('expands the box by a uniform radius', () => {
    const noPad = fitView([{ x: 0, y: 0 }], 0, { width: 200, height: 200 }, { padding: 0 });
    const withR = fitView([{ x: 0, y: 0 }], 50, { width: 200, height: 200 }, { padding: 0 });
    // Uniform radius widens the single-point box, so zoom is smaller.
    expect(withR.k).toBeLessThan(noPad.k);
    expect(withR.k).toBeCloseTo(2, 10); // 200/100
  });

  it('returns a centered fallback for empty input', () => {
    expect(fitView([], 0, { width: 800, height: 600 })).toEqual({
      x: 400,
      y: 300,
      k: 1,
    });
  });

  it('clamps extreme zooms', () => {
    const far = fitView(
      [
        { x: -1e6, y: -1e6 },
        { x: 1e6, y: 1e6 },
      ],
      0,
      { width: 800, height: 600 },
    );
    expect(far.k).toBe(MIN_ZOOM);
  });
});
