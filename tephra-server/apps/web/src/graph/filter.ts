import { buildGraphModel, type GraphModel } from './model';
import { matchesQuery, parseQuery } from './query';

/** The Filters section of the graph settings panel. */
export interface FilterState {
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  /** Hide unresolved-link nodes. */
  existingOnly: boolean;
  showOrphans: boolean;
}

export interface FilteredGraph {
  model: GraphModel;
  /**
   * Old node index → new node index (or -1 when filtered out), so the
   * simulation can reposition instead of restarting on filter changes.
   */
  indexMap: Int32Array;
  removedCount: number;
}

export interface FilterOptions {
  /** Time-lapse cutoff: nodes with createdAt > cutoff are hidden (§9). */
  createdAtCutoff?: number;
}

/**
 * Apply the Filters section in Obsidian's fixed order:
 * kind toggles → search → existing-only → orphans (last, because every
 * earlier step can create new orphans).
 */
export function applyFilters(
  model: GraphModel,
  filters: FilterState,
  options: FilterOptions = {},
): FilteredGraph {
  const query = parseQuery(filters.search);
  const keep = new Uint8Array(model.nodes.length).fill(1);

  // 1. Kind toggles.
  for (let index = 0; index < model.nodes.length; index += 1) {
    const kind = model.nodes[index]!.kind;
    if (kind === 'tag' && !filters.showTags) keep[index] = 0;
    if (kind === 'attachment' && !filters.showAttachments) keep[index] = 0;
  }

  // 2. Search applies to real files only; synthesized tag/unresolved nodes
  //    survive iff they retain a visible neighbour (checked below).
  if (!query.empty) {
    for (let index = 0; index < model.nodes.length; index += 1) {
      const node = model.nodes[index]!;
      if (node.kind !== 'note' && node.kind !== 'attachment') continue;
      if (!matchesQuery(node, query)) keep[index] = 0;
    }
    // Drop synthesized nodes that no longer touch anything visible.
    for (let index = 0; index < model.nodes.length; index += 1) {
      const node = model.nodes[index]!;
      if (keep[index] === 0) continue;
      if (node.kind !== 'tag' && node.kind !== 'unresolved') continue;
      const hasVisibleNeighbour = [...model.adjacency[index]!].some((n) => keep[n] === 1);
      if (!hasVisibleNeighbour) keep[index] = 0;
    }
  }

  // 3. Existing-only hides unresolved nodes.
  if (filters.existingOnly)
    for (let index = 0; index < model.nodes.length; index += 1)
      if (model.nodes[index]!.kind === 'unresolved') keep[index] = 0;

  // 3b. Time-lapse cutoff.
  if (options.createdAtCutoff !== undefined)
    for (let index = 0; index < model.nodes.length; index += 1)
      if (model.nodes[index]!.createdAt > options.createdAtCutoff) keep[index] = 0;

  // 4. Orphans last: degree is recomputed over the surviving subgraph.
  if (!filters.showOrphans) {
    const degree = new Uint32Array(model.nodes.length);
    for (const link of model.links)
      if (keep[link.source] === 1 && keep[link.target] === 1) {
        degree[link.source]! += 1;
        degree[link.target]! += 1;
      }
    for (let index = 0; index < model.nodes.length; index += 1)
      if (keep[index] === 1 && degree[index] === 0) keep[index] = 0;
  }

  // Reindex into a fresh, compacted model.
  const indexMap = new Int32Array(model.nodes.length).fill(-1);
  const keptNodes: typeof model.nodes = [];
  for (let index = 0; index < model.nodes.length; index += 1) {
    if (keep[index] === 0) continue;
    indexMap[index] = keptNodes.length;
    keptNodes.push(model.nodes[index]!);
  }
  const keptEdges = model.links
    .filter((link) => keep[link.source] === 1 && keep[link.target] === 1)
    .map((link) => ({ s: indexMap[link.source]!, t: indexMap[link.target]!, count: link.count, embeds: link.embeds }));
  const filtered = buildGraphModel({
    nodes: keptNodes,
    edges: keptEdges,
  });
  return { model: filtered, indexMap, removedCount: model.nodes.length - keptNodes.length };
}
