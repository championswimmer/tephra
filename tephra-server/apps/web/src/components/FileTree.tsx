import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileText, Search } from 'lucide-react';
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
              {node.file.kind === 'markdown' ? (
                <FileText size={14} aria-hidden="true" focusable="false" className="icon" />
              ) : (
                <File size={14} aria-hidden="true" focusable="false" className="icon" />
              )}
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
        {expanded ? (
          <ChevronDown size={14} aria-hidden="true" focusable="false" className="icon" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" focusable="false" className="icon" />
        )}
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
        <Search size={14} aria-hidden="true" focusable="false" className="icon" />
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
