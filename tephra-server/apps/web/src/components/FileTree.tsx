import { memo } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import type { VaultFile } from '../api/types';
import type { TreeNode } from '../vault/tree';
import { FileIcon } from './FileIcon';

export interface FileTreeProps {
  files: readonly VaultFile[];
  nodes: readonly TreeNode[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  forceOpen: boolean;
  collapsed: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
}

const FileRow = memo(function FileRow({
  node,
  selected,
  onSelect,
}: {
  node: Extract<TreeNode, { type: 'file' }>;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`tree-file ${selected ? 'selected' : ''}`}
        aria-current={selected ? 'page' : undefined}
        onClick={() => onSelect(node.file.path)}
      >
        <FileIcon file={node.file} />
        <span>{node.name}</span>
      </button>
    </li>
  );
});

const FolderRow = memo(function FolderRow({
  node,
  selectedPath,
  onSelect,
  forceOpen,
  collapsed,
  onToggleFolder,
}: {
  node: Extract<TreeNode, { type: 'folder' }>;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  forceOpen: boolean;
  collapsed: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
}) {
  const expanded = forceOpen || !collapsed.has(node.path);
  return (
    <li>
      <button
        className="tree-folder"
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggleFolder(node.path)}
      >
        {expanded ? (
          <ChevronDown size={14} aria-hidden="true" focusable="false" className="icon" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" focusable="false" className="icon" />
        )}
        {expanded ? (
          <FolderOpen size={14} aria-hidden="true" focusable="false" className="icon" />
        ) : (
          <Folder size={14} aria-hidden="true" focusable="false" className="icon" />
        )}
        <span>{node.name}</span>
      </button>
      {expanded && (
        <TreeBranch
          nodes={node.children}
          selectedPath={selectedPath}
          onSelect={onSelect}
          forceOpen={forceOpen}
          collapsed={collapsed}
          onToggleFolder={onToggleFolder}
        />
      )}
    </li>
  );
});

/**
 * Pure presentational tree: renders pre-built {@link TreeNode}s with
 * memoized rows so re-renders only touch changed subtrees. Tree building
 * and search filtering live in {@link FileBrowser}.
 */
export const TreeBranch = memo(function TreeBranch({
  nodes,
  selectedPath,
  onSelect,
  forceOpen,
  collapsed,
  onToggleFolder,
}: Omit<FileTreeProps, 'files'>) {
  return (
    <ul className="tree-list">
      {nodes.map((node) =>
        node.type === 'folder' ? (
          <FolderRow
            key={node.path}
            node={node}
            selectedPath={selectedPath}
            onSelect={onSelect}
            forceOpen={forceOpen}
            collapsed={collapsed}
            onToggleFolder={onToggleFolder}
          />
        ) : (
          <FileRow
            key={node.file.fileId}
            node={node}
            selected={selectedPath === node.file.path}
            onSelect={onSelect}
          />
        ),
      )}
    </ul>
  );
});

export const FileTree = memo(function FileTree({
  nodes,
  selectedPath,
  onSelect,
  forceOpen,
  collapsed,
  onToggleFolder,
}: Omit<FileTreeProps, 'files'>) {
  return (
    <TreeBranch
      nodes={nodes}
      selectedPath={selectedPath}
      onSelect={onSelect}
      forceOpen={forceOpen}
      collapsed={collapsed}
      onToggleFolder={onToggleFolder}
    />
  );
});
