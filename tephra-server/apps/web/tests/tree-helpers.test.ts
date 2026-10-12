import { describe, expect, it } from 'vitest';
import type { VaultFile } from '../src/api/types';
import { buildTree, collectFolderPaths, toggleCollapsed } from '../src/vault/tree';

const file = (path: string): VaultFile => ({
  fileId: path,
  path,
  kind: 'markdown',
  size: 1,
  mtime: 1,
});

describe('tree collapse helpers', () => {
  it('collects every nested folder path', () => {
    const tree = buildTree([file('a/b/c.md'), file('a/d.md'), file('e/f.md'), file('root.md')]);
    expect([...collectFolderPaths(tree)].sort()).toEqual(['a', 'a/b', 'e']);
  });

  it('toggles a path without mutating the input', () => {
    const start = new Set(['a']);
    const added = toggleCollapsed(start, 'b');
    expect([...added].sort()).toEqual(['a', 'b']);
    expect([...toggleCollapsed(added, 'a')]).toEqual(['b']);
    expect([...start]).toEqual(['a']);
  });
});
