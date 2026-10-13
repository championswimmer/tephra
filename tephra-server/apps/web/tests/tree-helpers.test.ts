import { describe, expect, it } from 'vitest';
import type { VaultFile } from '../src/api/types';
import { buildTree, collectFolderPaths, toggleFolder } from '../src/vault/tree';
import {
  loadExpandedFolders,
  pruneExpanded,
  sanitizeExpanded,
  saveExpandedFolders,
} from '../src/vault/tree-state';

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
    const added = toggleFolder(start, 'b');
    expect([...added].sort()).toEqual(['a', 'b']);
    expect([...toggleFolder(added, 'a')]).toEqual(['b']);
    expect([...start]).toEqual(['a']);
  });
});

describe('tree expansion state', () => {
  it('prunes unknown paths and keeps identity when nothing is stale', () => {
    const folders = new Set(['a', 'a/b']);
    const clean = new Set(['a']);
    expect(pruneExpanded(clean, folders)).toBe(clean);
    expect([...pruneExpanded(new Set(['a', 'x', 'a/b/c']), folders)]).toEqual(['a']);
  });

  it('sanitizes untrusted stored values', () => {
    expect([...sanitizeExpanded({ expanded: ['a', 1, '', null, 'b'] })]).toEqual(['a', 'b']);
    expect(sanitizeExpanded(null).size).toBe(0);
    expect(sanitizeExpanded(['a']).size).toBe(0);
    expect(sanitizeExpanded({ expanded: 'a' }).size).toBe(0);
  });

  it('survives throwing storage', () => {
    const storage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(loadExpandedFolders('v', storage).size).toBe(0);
    expect(() => saveExpandedFolders('v', new Set(['a']), storage)).not.toThrow();
  });
});
