import { buildGraphModel, type GraphModel } from './model';

/**
 * Undirected BFS from `rootId`, returning the set of node indices within
 * `depth` hops (the root itself included). Used by the local graph.
 */
export function nodesWithinDepth(model: GraphModel, rootId: string, depth: number): Set<number> {
  const root = model.indexById.get(rootId);
  if (root === undefined) return new Set();
  const visited = new Set<number>([root]);
  let frontier = [root];
  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: number[] = [];
    for (const index of frontier)
      for (const neighbour of model.adjacency[index]!)
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.push(neighbour);
        }
    frontier = next;
  }
  return visited;
}

/** Restrict a model to a subset of node indices, re-indexed compactly. */
export function subgraph(model: GraphModel, include: ReadonlySet<number>): GraphModel {
  const oldIndices = [...include].sort((a, b) => a - b);
  const newIndex = new Map(oldIndices.map((old, position) => [old, position]));
  return buildGraphModel({
    nodes: oldIndices.map((old) => model.nodes[old]!),
    edges: model.links
      .filter((link) => include.has(link.source) && include.has(link.target))
      .map((link) => ({
        s: newIndex.get(link.source)!,
        t: newIndex.get(link.target)!,
        count: link.count,
        embeds: link.embeds,
      })),
  });
}
