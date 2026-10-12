/**
 * Shared contracts for the graph engine (plan 018). Every engine module
 * codes against these types so the simulation, draw backends, label layer,
 * and orchestrator can evolve independently.
 *
 * Conventions:
 * - Node and edge data live in flat typed arrays indexed like
 *   `GraphModel.nodes` / `GraphModel.links`; nothing here allocates per frame.
 * - Positions are world units; the camera maps world → CSS pixels via
 *   `screen = world * k + offset` (see `camera.ts`). Backends multiply by
 *   `dpr` themselves.
 * - Colours are linear RGBA floats in [0, 1], 4 floats per element,
 *   straight (non-premultiplied) alpha.
 */

import type { CameraState, ViewportSize } from '../camera';

/** Force sliders; mirrors the Forces section of `GraphSettings`. */
export interface ForceParams {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

export interface ForceSimulationInit {
  /** Node count. */
  count: number;
  /** Edge endpoints (indices into nodes). Self-loops are ignored by forces. */
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  /** World-unit node radii (length `count`); drives collision. */
  radii: Float32Array;
  forces: ForceParams;
  /** Seed for deterministic jitter. */
  seed: number;
  /**
   * Optional starting positions (length `count`). Entries that are NaN fall
   * back to the phyllotaxis start.
   */
  initialX?: Float32Array | undefined;
  initialY?: Float32Array | undefined;
}

export interface ForceSimulation {
  readonly count: number;
  /** Live world positions, mutated in place by `tick`. Never reallocated. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Current temperature. */
  readonly alpha: number;
  /** Advance `iterations` (default 1) steps. No-op once settled. */
  tick(iterations?: number): void;
  /** `alpha < alphaMin` and `alphaTarget < alphaMin`. */
  isSettled(): boolean;
  /** Set alpha (default 1) — e.g. the Animate button. */
  reheat(alpha?: number): void;
  /** d3 `alphaTarget`: 0.3 while dragging, 0 otherwise. */
  setAlphaTarget(target: number): void;
  /** Merge force params; gently reheats (alpha ≥ 0.3) when anything changed. */
  setForces(forces: Partial<ForceParams>): void;
  /** Replace radii (same length) without touching positions. */
  setRadii(radii: Float32Array): void;
  /** Fix a node at (x, y): zero velocity, excluded from integration. */
  pin(index: number, x: number, y: number): void;
  unpin(index: number): void;
  isPinned(index: number): boolean;
}

/** Everything a draw backend needs for one frame. Owned by the scene. */
export interface SceneFrame {
  camera: CameraState;
  viewport: ViewportSize;
  /** Device pixel ratio already capped by the orchestrator. */
  dpr: number;

  nodeCount: number;
  /** World positions (usually the simulation's live arrays). */
  x: Float32Array;
  y: Float32Array;
  /** World-unit radii. */
  radius: Float32Array;
  /** RGBA per node (length ≥ nodeCount*4), alpha already includes hover dim. */
  nodeRGBA: Float32Array;
  /**
   * Focus ring per node: 0 = none, 1 = ring. Ring colour is `ringRGBA`,
   * 2 CSS px stroke at screen radius + 3.
   */
  nodeRing: Uint8Array;
  ringRGBA: Float32Array;

  edgeCount: number;
  edgeSource: Uint32Array;
  edgeTarget: Uint32Array;
  /** Screen-space width in CSS px, already zoom-adjusted and clamped. */
  edgeWidth: Float32Array;
  /** RGBA per edge (length ≥ edgeCount*4). */
  edgeRGBA: Float32Array;
  /** Draw an arrow head at the target rim of every non-self-loop edge. */
  arrows: boolean;
}

/** A graph draw backend (WebGL2 or Canvas2D). */
export interface DrawBackend {
  readonly kind: 'webgl2' | 'canvas2d';
  /** The canvas this backend draws on (owned by the backend). */
  readonly canvas: HTMLCanvasElement;
  /** Size the backing store: CSS px * dpr. */
  resize(width: number, height: number, dpr: number): void;
  /** Clear and draw edges → nodes → rings → arrows. */
  draw(frame: SceneFrame): void;
  /** True if the backend can no longer draw (e.g. WebGL context lost). */
  isLost(): boolean;
  destroy(): void;
}

/** Per-frame label inputs (owned by the orchestrator, reused across frames). */
export interface LabelFrame {
  /** Label text per node (index-aligned with nodes). */
  text: readonly string[];
  /** Per-node label opacity in [0, 1]; 0 = skip. */
  opacity: Float32Array;
  /**
   * Draw priority order (node indices, highest priority first). Labels for
   * nodes earlier in the list win screen-space overlap tests.
   */
  order: Uint32Array;
  /** CSS colour string for label text. */
  color: string;
  /** Max labels to draw this frame. */
  maxLabels: number;
}

export interface LabelLayer {
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number, dpr: number): void;
  draw(frame: SceneFrame, labels: LabelFrame): void;
  /** Drop cached text measurements (call on model change). */
  invalidate(): void;
  destroy(): void;
}
