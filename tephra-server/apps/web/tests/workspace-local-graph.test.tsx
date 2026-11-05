import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { VaultFile } from '../src/api/types';
import { VaultWorkspace } from '../src/routes/VaultWorkspace';

vi.mock('../src/components/NoteViewer', () => ({ NoteViewer: () => <p>Note content</p> }));
vi.mock('../src/components/AttachmentViewer', () => ({
  AttachmentViewer: () => <p>Attachment content</p>,
}));
vi.mock('../src/components/GraphView', () => ({
  GraphView: ({
    vaultId,
    rootId,
    selectedId,
    scope,
    onOpen,
  }: {
    vaultId: string;
    rootId?: string;
    selectedId?: string;
    scope?: string;
    onOpen: (path: string) => void;
  }) => (
    <div
      data-testid="local-graph"
      data-vault={vaultId}
      data-root={rootId}
      data-selected={selectedId}
      data-scope={scope}
    >
      <button onClick={() => onOpen('Target.md')}>Open graph neighbour</button>
    </div>
  ),
}));

const files: VaultFile[] = [
  { fileId: 'home-id', path: 'Home.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: 'target-id', path: 'Target.md', kind: 'markdown', size: 10, mtime: 1 },
  { fileId: 'image-id', path: 'image.png', kind: 'attachment', size: 10, mtime: 1 },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, 'vault').mockResolvedValue({
    vault: { id: 'vault-id', name: 'Example', latestRevision: 1 },
  });
  vi.spyOn(api, 'files').mockResolvedValue({ files, revision: 1 });
  vi.spyOn(api, 'links').mockResolvedValue({ links: [], backlinks: [] });
  vi.spyOn(api, 'resolve').mockImplementation(async (_vaultId, path) => {
    const file = files.find((entry) => entry.path === path)!;
    return { match: 'exact', requestedPath: path, canonicalPath: path, file };
  });
});

function openWorkspace(path: string) {
  return render(
    <MemoryRouter initialEntries={[`/v/Example/#/${path}`]}>
      <Routes>
        <Route path="/v/:vaultSlug/*" element={<VaultWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('workspace local graph integration', () => {
  it('shows the open note neighbourhood and navigates to neighbours by path', async () => {
    const user = userEvent.setup();
    openWorkspace('Home.md');
    const graph = await screen.findByTestId('local-graph');
    expect(screen.getByRole('region', { name: 'Local graph panel' })).toContainElement(graph);
    expect(graph).toHaveAttribute('data-vault', 'Example');
    expect(graph).toHaveAttribute('data-root', 'home-id');
    expect(graph).toHaveAttribute('data-selected', 'home-id');
    expect(graph).toHaveAttribute('data-scope', 'local');
    await user.click(screen.getByRole('button', { name: 'Open graph neighbour' }));
    await waitFor(() =>
      expect(screen.getByTestId('local-graph')).toHaveAttribute('data-root', 'target-id'),
    );
    expect(screen.getByTestId('local-graph')).toHaveAttribute('data-selected', 'target-id');
    expect(api.resolve).toHaveBeenLastCalledWith('Example', 'Target.md');
  });

  it('does not render a local graph for attachments', async () => {
    openWorkspace('image.png');
    expect(await screen.findByText('Attachment content')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Local graph panel' })).not.toBeInTheDocument();
  });
});
