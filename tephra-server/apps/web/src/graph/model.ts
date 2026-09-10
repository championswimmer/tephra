import type { GraphNodeKind, GraphResponse } from '../api/types';

/** A node in the renderable graph, with degree precomputed once at build time. */
export interface RenderNode {
  /** File id for note/attachment nodes; `tag:<name>` / `unresolved:<path>` otherwise. */
  id: string;
  path: string;
  title: string | null;
  kind: GraphNodeKind;
  tags: string[];
  createdAt: number;
  degree: number;
}

/** An aggregated link. Endpoints are indices into {@link GraphModel.nodes}. */
export interface RenderLink {
  source: number;
  target: number;
  count: number;
  embeds: number;
}

export interface GraphModel {
  nodes: RenderNode[];
  links: RenderLink[];
  /** Undirected neighbour indices per node, for BFS and hover highlighting. */
  adjacency: Uint32Array[];
  indexById: Map<string, number>;
}

/** Build the render model from a payload-v2 graph response. */
export function buildGraphModel(payload: Pick<GraphResponse, 'nodes' | 'edges'>): GraphModel {
  const nodes: RenderNode[] = payload.nodes.map((node) => ({
    id: node.id,
    path: node.path,
    title: node.title,
    kind: node.kind,
    tags: node.tags,
    createdAt: node.createdAt,
    degree: 0,
  }));
  const links: RenderLink[] = [];
  for (const edge of payload.edges) {
    if (edge.s >= nodes.length || edge.t >= nodes.length) continue;
    links.push({ source: edge.s, target: edge.t, count: edge.count, embeds: edge.embeds });
  }
  const adjacencyLists: number[][] = nodes.map(() => []);
  for (const link of links) {
    nodes[link.source]!.degree += link.count;
    nodes[link.target]!.degree += link.count;
    adjacencyLists[link.source]!.push(link.target);
    if (link.target !== link.source) adjacencyLists[link.target]!.push(link.source);
  }
  return {
    nodes,
    links,
    adjacency: adjacencyLists.map((list) => Uint32Array.from(list)),
    indexById: new Map(nodes.map((node, index) => [node.id, index])),
  };
}

/**
 * Node radius for a given degree, per Quartz/Obsidian: `2 + sqrt(degree)`,
 * scaled by the node-size slider multiplier.
 */
export function nodeRadius(degree: number, nodeSize: number): number {
  return nodeSize * (2 + Math.sqrt(Math.max(0, degree)));
}
