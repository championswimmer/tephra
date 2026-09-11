/**
 * Graph color palette, sourced from the Obsidian CSS variables
 * (`--graph-node`, `--graph-node-tag`, …) already applied to the document
 * by the theme provider.
 */
export interface GraphPalette {
  node: string;
  tag: string;
  attachment: string;
  unresolved: string;
  focused: string;
  line: string;
  label: string;
}

export const FALLBACK_GRAPH_PALETTE: GraphPalette = {
  node: '#000000',
  tag: '#7f6df2',
  attachment: '#d669bc',
  unresolved: '#999999',
  focused: '#ff0000',
  line: '#d1d1d1',
  label: '#2e3338',
};

function readVariable(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Read the live palette from the document so theme switches re-tint without re-init. */
export function readGraphPalette(): GraphPalette {
  return {
    node: readVariable('--graph-node', FALLBACK_GRAPH_PALETTE.node),
    tag: readVariable('--graph-node-tag', FALLBACK_GRAPH_PALETTE.tag),
    attachment: readVariable('--graph-node-attachment', FALLBACK_GRAPH_PALETTE.attachment),
    unresolved: readVariable('--graph-node-unresolved', FALLBACK_GRAPH_PALETTE.unresolved),
    focused: readVariable('--graph-node-focused', FALLBACK_GRAPH_PALETTE.focused),
    line: readVariable('--graph-line', FALLBACK_GRAPH_PALETTE.line),
    label: readVariable('--text-normal', FALLBACK_GRAPH_PALETTE.label),
  };
}
