import type { GraphSettings } from './settings';
import { SETTINGS_LIMITS } from './settings';

export interface ForceAtlas2Settings {
  gravity: number;
  scalingRatio: number;
  edgeWeightInfluence: number;
  slowDown: number;
  barnesHutOptimize: boolean;
}

type ForceSliders = Pick<
  GraphSettings,
  'centerForce' | 'repelForce' | 'linkForce' | 'linkDistance'
>;

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Map the Obsidian-style Forces sliders onto ForceAtlas2 worker settings.
 * Monotonic in every input: more center → more gravity, more repel/distance
 * → more spread, more link force → stronger edge weighting.
 */
export function forcesToFA2Settings(forces: ForceSliders): ForceAtlas2Settings {
  const distanceNorm = normalize(
    forces.linkDistance,
    SETTINGS_LIMITS.linkDistance.min,
    SETTINGS_LIMITS.linkDistance.max,
  );
  return {
    gravity: forces.centerForce * 2,
    scalingRatio: 1 + forces.repelForce * 2 + distanceNorm * 4,
    edgeWeightInfluence: forces.linkForce,
    slowDown: 10,
    barnesHutOptimize: true,
  };
}
