import { describe, expect, it } from 'vitest';

import { createPicker, PICK_SLOP_PX } from '../src/engine/picker';
import { mulberry32 } from '../src/engine/simulation';

function bruteForce(
  wx: number,
  wy: number,
  x: Float32Array,
  y: Float32Array,
  r: Float32Array,
  maxDistance: number,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < x.length; i += 1) {
    const d = Math.hypot(x[i]! - wx, y[i]! - wy) - r[i]!;
    if (d <= maxDistance && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

describe('picker', () => {
  it('matches brute force across cameras', () => {
    const rand = mulberry32(42);
    const n = 300;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      x[i] = (rand() - 0.5) * 2000;
      y[i] = (rand() - 0.5) * 2000;
      r[i] = 2 + rand() * 8;
    }
    const picker = createPicker();
    const cameras = [
      { x: 400, y: 300, k: 1 },
      { x: 100, y: -50, k: 0.25 },
      { x: 600, y: 900, k: 3 },
    ];
    let hits = 0;
    for (const camera of cameras) {
      for (let q = 0; q < 400; q += 1) {
        const sx = rand() * 800;
        const sy = rand() * 600;
        const got = picker.pick(sx, sy, camera, x, y, r, n);
        const wx = (sx - camera.x) / camera.k;
        const wy = (sy - camera.y) / camera.k;
        const want = bruteForce(wx, wy, x, y, r, PICK_SLOP_PX / camera.k);
        expect(got).toBe(want);
        if (got >= 0) hits += 1;
      }
      // Exactly on a node centre always hits it.
      const sx = x[7]! * camera.k + camera.x;
      const sy = y[7]! * camera.k + camera.y;
      expect(picker.pick(sx, sy, camera, x, y, r, n)).toBe(7);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('rebuilds lazily only after invalidate()', () => {
    const x = new Float32Array([0, 100]);
    const y = new Float32Array([0, 0]);
    const r = new Float32Array([5, 5]);
    const picker = createPicker();
    const camera = { x: 0, y: 0, k: 1 };
    expect(picker.rebuilds).toBe(0);
    expect(picker.pick(0, 0, camera, x, y, r, 2)).toBe(0);
    expect(picker.pick(100, 0, camera, x, y, r, 2)).toBe(1);
    expect(picker.rebuilds).toBe(1);
    x[1] = 300;
    picker.invalidate();
    expect(picker.pick(100, 0, camera, x, y, r, 2)).toBe(-1);
    expect(picker.pick(300, 0, camera, x, y, r, 2)).toBe(1);
    expect(picker.rebuilds).toBe(2);
    expect(picker.pick(0, 0, camera, x, y, r, 0)).toBe(-1);
  });
});
