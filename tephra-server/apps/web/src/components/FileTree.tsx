import { useMemo, useState } from 'react';
import type { VaultFile } from '../api/types';
import { buildTree, filterTree, type TreeNode } from '../vault/tree';

function Branch({
  nodes,
  selectedPath,
  onSelect,
  forceOpen,
}: {
  nodes: readonly TreeNode[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  forceOpen: boolean;
}) {
  return (
    <ul className="tree-list">
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <Folder
            key={node.path}
            node={node}
            selectedPath={selectedPath}
            onSelect={onSelect}
            forceOpen={forceOpen}
          />
        ) : (
          <li key={node.file.fileId}>
            <button
              type="button"
              className={`tree-file ${selectedPath === node.file.path ? 'selected' : ''}`}
              aria-current={selectedPath === node.file.path ? 'page' : undefined}
              onClick={() => onSelect(node.file.path)}
            >
              <span aria-hidden="true">{node.file.kind === 'markdown' ? '▧' : '◫'}</span>
              <span>{node.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
function Folder({
  node,
  selectedPath,
  onSelect,
  forceOpen,
}: {
  node: Extract<TreeNode, { type: 'folder' }>;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(true);
  const expanded = forceOpen || open;
  return (
    <li>
      <button
        className="tree-folder"
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {node.name}
      </button>
      {expanded && (
        <Branch
          nodes={node.children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={forceOpen}
        />
      )}
    </li>
  );
}
export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: readonly VaultFile[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const nodes = useMemo(
    () =>
      filterTree(
        buildTree(files.filter((file) => !file.path.split('/').includes('.obsidian'))),
        query,
      ),
    [files, query],
  );
  return (
    <div className="file-browser">
      <label className="tree-search">
        <span className="sr-only">Search files</span>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          placeholder="Search files"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {nodes.length ? (
        <Branch
          nodes={nodes}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={query.trim().length > 0}
        />
      ) : (
        <p className="tree-empty">No files match “{query}”.</p>
      )}
    </div>
  );
}
