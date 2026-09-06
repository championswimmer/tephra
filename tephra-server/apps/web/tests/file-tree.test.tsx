import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from '../src/components/FileTree';
import type { VaultFile } from '../src/api/types';
const files: VaultFile[] = [
  { fileId: '1', path: 'Projects/Tephra.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: '2', path: 'Journal/Today.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: '3', path: 'cover.png', kind: 'attachment', mimeType: 'image/png', size: 10, mtime: 1 },
];
describe('FileTree', () => {
  it('searches full paths while retaining matching folders', async () => {
    const user = userEvent.setup();
    render(<FileTree files={files} onSelect={vi.fn()} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'tephra');
    expect(screen.getByRole('button', { name: /Tephra\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Projects/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Today\.md/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cover\.png/ })).not.toBeInTheDocument();
  });
});
