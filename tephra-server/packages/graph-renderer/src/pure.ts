/**
 * Sigma-free entrypoint: pure graph core (model/query/filter/depth/
 * settings/groups/palette) plus the graphology adapter and FA2 settings
 * mapping. Import from `@tephra/graph-renderer/pure` when the Sigma
 * component must stay out of the bundle (lazy-loaded separately).
 */
export { buildGraphModel, nodeRadius } from './model';
export type {
  GraphInput,
  GraphInputEdge,
  GraphInputNode,
  GraphModel,
  RenderLink,
  RenderNode,
} from './model';
export { matchesClause, matchesQuery, parseQuery, tokenizeQuery } from './query';
export type { ParsedQuery, QueryClause } from './query';
export { applyFilters } from './filter';
export type { FilterState, FilteredGraph } from './filter';
export { nodesWithinDepth, subgraph } from './depth';
export {
  DEFAULT_GRAPH_SETTINGS,
  SETTINGS_LIMITS,
  graphSettingsKey,
  loadGraphSettings,
  restoreDefaultGraphSettings,
  sanitizeGraphSettings,
  saveGraphSettings,
} from './settings';
export type { ColorGroup, GraphScope, GraphSettings } from './settings';
export { resolveGroupColors } from './groups';
export { FALLBACK_GRAPH_PALETTE, readGraphPalette } from './palette';
export type { GraphPalette } from './palette';
export { buildGraphologyGraph, mulberry32, SIGMA_SIZE_SCALE } from './graphology';
export type {
  GraphologyBuildOptions,
  GraphologyEdgeAttributes,
  GraphologyNodeAttributes,
} from './graphology';
export { forcesToFA2Settings } from './layout';
export type { ForceAtlas2Settings } from './layout';
