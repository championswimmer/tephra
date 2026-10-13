import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from '../src/components/FileBrowser';
import type { VaultFile } from '../src/api/types';
const files: VaultFile[] = [
  { fileId: '1', path: 'Projects/Tephra.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: '2', path: 'Journal/Today.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: '3', path: 'cover.png', kind: 'attachment', mimeType: 'image/png', size: 10, mtime: 1 },
];
beforeEach(() => window.localStorage.clear());
describe('FileBrowser', () => {
  it('searches full paths while retaining matching folders', async () => {
    const user = userEvent.setup();
    render(<FileBrowser files={files} onSelect={vi.fn()} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'tephra');
    expect(screen.getByRole('button', { name: /Tephra\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Projects/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Today\.md/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cover\.png/ })).not.toBeInTheDocument();
  });

  it('calls onSelect with the file path when a file is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<FileBrowser files={files} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: /Journal/ }));
    await user.click(screen.getByRole('button', { name: /Today\.md/ }));
    expect(onSelect).toHaveBeenCalledWith('Journal/Today.md');
  });

  it('starts with every folder collapsed', () => {
    render(<FileBrowser files={files} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Journal/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: /Today\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cover\.png/ })).toBeInTheDocument();
  });

  it('expands and collapses all folders', async () => {
    const user = userEvent.setup();
    render(<FileBrowser files={files} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('button', { name: /Today\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tephra\.md/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('button', { name: /Today\.md/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tephra\.md/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Journal/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('persists expanded folders per vault across remounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Journal/ }));
    expect(JSON.parse(window.localStorage.getItem('tephra:tree:v1') ?? '{}')).toEqual({
      expanded: ['Journal'],
    });
    unmount();
    render(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Today\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tephra\.md/ })).not.toBeInTheDocument();
  });

  it('keeps vaults isolated and reloads state when the vault changes', () => {
    window.localStorage.setItem('tephra:tree:v1', JSON.stringify({ expanded: ['Journal'] }));
    const { rerender } = render(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Today\.md/ })).toBeInTheDocument();
    rerender(<FileBrowser files={files} vaultId="v2" onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Today\.md/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('tephra:tree:v1')).toContain('Journal');
  });

  it('silently prunes stored folders that no longer exist', () => {
    window.localStorage.setItem(
      'tephra:tree:v1',
      JSON.stringify({ expanded: ['Journal', 'Deleted', 'Projects/Gone', 42, null] }),
    );
    render(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Today\.md/ })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('tephra:tree:v1') ?? '{}')).toEqual({
      expanded: ['Journal'],
    });
  });

  it('does not prune stored state while the file list is still empty', () => {
    window.localStorage.setItem('tephra:tree:v1', JSON.stringify({ expanded: ['Journal'] }));
    const { rerender } = render(<FileBrowser files={[]} vaultId="v1" onSelect={vi.fn()} />);
    rerender(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Today\.md/ })).toBeInTheDocument();
  });

  it.each(['not json', '"string"', '[1,2]', '{"expanded":"Journal"}', 'null'])(
    'falls back to all-collapsed for malformed stored state %s',
    (raw) => {
      window.localStorage.setItem('tephra:tree:v1', raw);
      render(<FileBrowser files={files} vaultId="v1" onSelect={vi.fn()} />);
      expect(screen.getByRole('button', { name: /Journal/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    },
  );
});
