import type { GraphNodeKind } from '@tephra/protocol';
import Graph from 'graphology';
import { nodeRadius, type GraphModel } from './model';
import type { GraphPalette } from './palette';

export interface GraphologyNodeAttributes {
  label: string;
  size: number;
  color: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
}

export interface GraphologyEdgeAttributes {
  size: number;
  color: string;
}

export interface GraphologyBuildOptions {
  nodeSize: number;
  linkThickness: number;
  groupColors: ReadonlyArray<string | null>;
  palette: GraphPalette;
  /** Seed for deterministic initial positions (e.g. the graph revision). */
  seed?: number | undefined;
}

/** Deterministic PRNG so initial positions are stable for a given seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sigma renders `size` in world units that shrink fast under the default
 * camera, so the Obsidian radius is scaled up to stay visible at rest zoom.
 * Labels key off rendered size (see `LABEL_SIZE_THRESHOLD` in the
 * component), so this multiplier also controls label visibility.
 */
export const SIGMA_SIZE_SCALE = 3;

function kindColor(kind: GraphNodeKind, palette: GraphPalette): string {
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

/**
 * Adapt a Tephra {@link GraphModel} to a `graphology` directed graph for
 * Sigma. Group colors win over kind colors (first-match-wins, resolved by
 * the caller). Nodes start on a seeded circle with jitter so ForceAtlas2
 * has a deterministic, overlap-free initial state.
 */
export function buildGraphologyGraph(
  model: GraphModel,
  options: GraphologyBuildOptions,
): Graph<GraphologyNodeAttributes, GraphologyEdgeAttributes> {
  const graph = new Graph<GraphologyNodeAttributes, GraphologyEdgeAttributes>({ type: 'directed' });
  const random = mulberry32(options.seed ?? 1);
  const count = model.nodes.length;
  for (let index = 0; index < count; index += 1) {
    const node = model.nodes[index]!;
    const angle = count === 0 ? 0 : (index / Math.max(1, count)) * Math.PI * 2;
    const radius = 100 + random() * 50;
    graph.addNode(node.id, {
      label: node.title ?? node.path,
      size: nodeRadius(node.degree, options.nodeSize) * SIGMA_SIZE_SCALE,
      color: options.groupColors[index] ?? kindColor(node.kind, options.palette),
      kind: node.kind,
      x: Math.cos(angle) * radius + (random() - 0.5) * 20,
      y: Math.sin(angle) * radius + (random() - 0.5) * 20,
    });
  }
  for (const link of model.links) {
    const source = model.nodes[link.source]?.id;
    const target = model.nodes[link.target]?.id;
    if (source === undefined || target === undefined) continue;
    if (source === target || graph.hasDirectedEdge(source, target)) continue;
    graph.addDirectedEdge(source, target, {
      size: options.linkThickness * (1 + Math.log2(Math.max(1, link.count))),
      color: options.palette.line,
    });
  }
  return graph;
}
