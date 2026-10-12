import type { GraphNodeKind } from '@tephra/protocol';

/**
 * Structural subset of the `/graph` payload that the renderer consumes.
 * The protocol `GraphResponse` is assignable to this input: `createdAt`
 * stays on the wire (ordering/future use) but the client no longer needs
 * it — time-lapse was removed.
 */
export interface GraphInputNode {
  /** File id for note/attachment nodes; `tag:<name>` / `unresolved:<path>` otherwise. */
  id: string;
  path: string;
  title: string | null;
  kind: GraphNodeKind;
  tags: string[];
}

export interface GraphInputEdge {
  /** Index into `nodes`. */
  s: number;
  /** Index into `nodes`. */
  t: number;
  count: number;
  embeds: number;
}

export interface GraphInput {
  nodes: readonly GraphInputNode[];
  edges: readonly GraphInputEdge[];
}

/** A node in the renderable graph, with degree precomputed once at build time. */
export interface RenderNode {
  /** File id for note/attachment nodes; `tag:<name>` / `unresolved:<path>` otherwise. */
  id: string;
  path: string;
  title: string | null;
  kind: GraphNodeKind;
  tags: string[];
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

/** Build the render model from a `/graph`-shaped payload. */
export function buildGraphModel(payload: GraphInput): GraphModel {
  // Only vault items may be nodes. Unresolved/external link placeholders
  // (e.g. from older cached payloads) are dropped along with their edges.
  const remap = new Map<number, number>();
  const nodes: RenderNode[] = [];
  payload.nodes.forEach((node, index) => {
    if (node.kind === 'unresolved') return;
    remap.set(index, nodes.length);
    nodes.push({
      id: node.id,
      path: node.path,
      title: node.title,
      kind: node.kind,
      tags: node.tags,
      degree: 0,
    });
  });
  const links: RenderLink[] = [];
  for (const edge of payload.edges) {
    const source = remap.get(edge.s);
    const target = remap.get(edge.t);
    if (source === undefined || target === undefined) continue;
    links.push({ source, target, count: edge.count, embeds: edge.embeds });
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
