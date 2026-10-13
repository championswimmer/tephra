import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-react';
import type { VaultFile } from '../api/types';
import { buildTree, collectFolderPaths, filterTree, toggleFolder } from '../vault/tree';
import { loadExpandedFolders, pruneExpanded, saveExpandedFolders } from '../vault/tree-state';
import { FileTree } from './FileTree';

export interface FileBrowserProps {
  files: readonly VaultFile[];
  selectedPath?: string;
  /** When set, folder expansion state is persisted per vault in localStorage. */
  vaultId?: string;
  onSelect: (path: string) => void;
}

/**
 * File browser container: owns the search query, memoizes tree building +
 * filtering so typing only recomputes the visible tree, and delegates
 * rendering to the memoized {@link FileTree}. `.obsidian` system files are
 * excluded here so the tree never sees them. Folders start collapsed; the
 * expanded set is persisted per vault and pruned to folders that still exist.
 */
export const FileBrowser = memo(function FileBrowser({
  files,
  selectedPath,
  vaultId,
  onSelect,
}: FileBrowserProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState(() => ({
    vaultId,
    expanded: (vaultId ? loadExpandedFolders(vaultId) : new Set()) as ReadonlySet<string>,
  }));
  // Switching vaults re-reads that vault's persisted state during render.
  if (state.vaultId !== vaultId)
    setState({ vaultId, expanded: vaultId ? loadExpandedFolders(vaultId) : new Set() });
  const expanded = state.expanded;
  const setExpanded = useCallback(
    (update: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
      setState((current) => {
        const next = update(current.expanded);
        return next === current.expanded ? current : { ...current, expanded: next };
      }),
    [],
  );
  const { allNodes, folderPaths } = useMemo(() => {
    const visible = files.filter((file) => !file.path.split('/').includes('.obsidian'));
    const all = buildTree(visible);
    return { allNodes: all, folderPaths: collectFolderPaths(all) };
  }, [files]);
  const filtering = query.trim().length > 0;
  const nodes = useMemo(() => filterTree(allNodes, query), [allNodes, query]);
  // Silently drop stored paths for folders that no longer exist. Skipped
  // while the file list is still empty (e.g. loading) so state isn't wiped.
  useEffect(() => {
    if (files.length) setExpanded((current) => pruneExpanded(current, folderPaths));
  }, [files.length, folderPaths, setExpanded]);
  useEffect(() => {
    if (state.vaultId) saveExpandedFolders(state.vaultId, state.expanded);
  }, [state]);
  const onToggleFolder = useCallback(
    (path: string) => setExpanded((current) => toggleFolder(current, path)),
    [setExpanded],
  );
  const collapseAll = () => setExpanded(() => new Set());
  const expandAll = () => setExpanded(() => folderPaths);

  return (
    <div className="file-browser">
      <div className="tree-toolbar">
        <label className="tree-search">
          <span className="sr-only">Search files</span>
          <Search size={14} aria-hidden="true" focusable="false" className="icon" />
          <input
            type="search"
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Collapse all"
          title="Collapse all"
          onClick={collapseAll}
        >
          <ChevronsDownUp size={14} aria-hidden="true" focusable="false" className="icon" />
        </button>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Expand all"
          title="Expand all"
          onClick={expandAll}
        >
          <ChevronsUpDown size={14} aria-hidden="true" focusable="false" className="icon" />
        </button>
      </div>
      {nodes.length ? (
        <FileTree
          nodes={nodes}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={filtering}
          expanded={expanded}
          onToggleFolder={onToggleFolder}
        />
      ) : (
        <p className="tree-empty">No files match “{query}”.</p>
      )}
    </div>
  );
});
