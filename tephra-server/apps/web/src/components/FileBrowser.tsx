import { memo, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { VaultFile } from '../api/types';
import { buildTree, filterTree } from '../vault/tree';
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
  const { nodes, filtering } = useMemo(() => {
    const trimmed = query.trim();
    const visible = files.filter((file) => !file.path.split('/').includes('.obsidian'));
    return { nodes: filterTree(buildTree(visible), query), filtering: trimmed.length > 0 };
  }, [files, query]);

  return (
    <div className="file-browser">
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
        />
      ) : (
        <p className="tree-empty">No files match “{query}”.</p>
      )}
    </div>
  );
});
