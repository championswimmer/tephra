import type { VaultFile } from '../api/types';
export interface FolderNode {
  type: 'folder';
  name: string;
  path: string;
  children: TreeNode[];
}
export interface FileNode {
  type: 'file';
  name: string;
  path: string;
  file: VaultFile;
}
export type TreeNode = FolderNode | FileNode;
const compare = (left: TreeNode, right: TreeNode) =>
  left.type === right.type
    ? left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    : left.type === 'folder'
      ? -1
      : 1;
export function buildTree(files: readonly VaultFile[]): TreeNode[] {
  const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let folder = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        folder.children.push({ type: 'file', name: part, path: file.path, file });
        return;
      }
      let child = folder.children.find(
        (node): node is FolderNode => node.type === 'folder' && node.name === part,
      );
      if (!child) {
        child = {
          type: 'folder',
          name: part,
          path: folder.path ? `${folder.path}/${part}` : part,
          children: [],
        };
        folder.children.push(child);
      }
      folder = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(compare);
    for (const node of nodes) if (node.type === 'folder') sort(node.children);
  };
  sort(root.children);
  return root.children;
}
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [...nodes];
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'file') {
      if (node.path.toLocaleLowerCase().includes(term)) result.push(node);
    } else {
      const children = filterTree(node.children, term);
      if (children.length || node.path.toLocaleLowerCase().includes(term))
        result.push({ ...node, children: children.length ? children : node.children });
    }
  }
  return result;
}
