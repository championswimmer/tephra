import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-react';
import type { VaultFile } from '../api/types';
import { buildTree, collectFolderPaths, filterTree, toggleCollapsed } from '../vault/tree';
import { FileTree } from './FileTree';

export interface FileBrowserProps {
  files: readonly VaultFile[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}

/**
 * File browser container: owns the search query, memoizes tree building +
 * filtering so typing only recomputes the visible tree, and delegates
 * rendering to the memoized {@link FileTree}. `.obsidian` system files are
 * excluded here so the tree never sees them.
 */
export const FileBrowser = memo(function FileBrowser({
  files,
  selectedPath,
  onSelect,
}: FileBrowserProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { allNodes, nodes, filtering } = useMemo(() => {
    const trimmed = query.trim();
    const visible = files.filter((file) => !file.path.split('/').includes('.obsidian'));
    const all = buildTree(visible);
    return { allNodes: all, nodes: filterTree(all, query), filtering: trimmed.length > 0 };
  }, [files, query]);
  const onToggleFolder = useCallback(
    (path: string) => setCollapsed((current) => toggleCollapsed(current, path)),
    [],
  );
  const collapseAll = () => setCollapsed(collectFolderPaths(allNodes));
  const expandAll = () => setCollapsed(new Set());

  return (
    <div className="file-browser">
      <div className="tree-actions">
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
      {nodes.length ? (
        <FileTree
          nodes={nodes}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={filtering}
          collapsed={collapsed}
          onToggleFolder={onToggleFolder}
        />
      ) : (
        <p className="tree-empty">No files match “{query}”.</p>
      )}
    </div>
  );
});
