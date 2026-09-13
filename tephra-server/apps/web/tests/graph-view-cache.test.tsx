import * as React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/client';
import type { CachedGraph } from '../src/api/graphCache';
import { loadGraphCache } from '../src/api/graphCache';
import type { GraphResponse } from '../src/api/types';
import { GraphView } from '../src/components/GraphView';
import { ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('../src/api/client', () => ({ api: { graph: vi.fn() } }));
vi.mock('../src/api/graphCache', () => ({
  loadGraphCache: vi.fn(),
  saveGraphCache: vi.fn(),
  clearGraphCache: vi.fn(),
}));

// The canvas renderer needs a real 2D context + ResizeObserver, neither of
// which exists under jsdom — the stub keeps these tests on the fetch /
// revalidate behavior (stale paint, revision-skip) via the fallback list,
// which renders every note regardless of canvas filters.
vi.mock('@tephra/graph-renderer', () => ({
  TephraGraph: () => <canvas data-testid="tephra-graph-canvas" />,
}));

function fixture(revision: number, title: string): GraphResponse {
  return {
    revision,
    truncated: false,
    nodes: [{ id: 'a', path: 'a.md', title, kind: 'note', tags: [], createdAt: 1 }],
    edges: [],
  };
}

function staleEntry(body: GraphResponse): CachedGraph {
  return { etag: 'W/"stale"', body, savedAt: 1 };
}

function renderGraph() {
  return render(
    <ThemeProvider>
      <GraphView vaultId="vault-1" onOpen={vi.fn()} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(loadGraphCache).mockResolvedValue(null);
});

describe('GraphView stale-while-revalidate', () => {
  it('paints the cached payload instantly, then revalidates in the background', async () => {
    vi.mocked(loadGraphCache).mockResolvedValue(staleEntry(fixture(3, 'Stale Alpha')));
    let resolveGraph!: (value: GraphResponse) => void;
    vi.mocked(api.graph).mockReturnValue(
      new Promise<GraphResponse>((resolve) => {
        resolveGraph = resolve;
      }),
    );

    renderGraph();

    // Stale paint lands while the network request is still in flight.
    expect(await screen.findByRole('button', { name: 'Stale Alpha' })).toBeInTheDocument();
    expect(vi.mocked(api.graph)).toHaveBeenCalledWith('vault-1');

    resolveGraph(fixture(4, 'Fresh Alpha'));
    expect(await screen.findByRole('button', { name: 'Fresh Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stale Alpha' })).toBeNull();
  });

  it('skips the second paint when the revision is unchanged', async () => {
    vi.mocked(loadGraphCache).mockResolvedValue(staleEntry(fixture(3, 'Stale Alpha')));
    let revalidated = false;
    vi.mocked(api.graph).mockImplementation(async () => {
      revalidated = true;
      return fixture(3, 'Fresh Alpha');
    });

    renderGraph();

    expect(await screen.findByRole('button', { name: 'Stale Alpha' })).toBeInTheDocument();
    await waitFor(() => expect(revalidated).toBe(true));
    // Flush the awaiting continuation: had the component re-painted, the
    // fresh title would be in the document by now.
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Stale Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fresh Alpha' })).toBeNull();
  });

  it('loads normally with a loading state when no cache entry exists', async () => {
    vi.mocked(loadGraphCache).mockResolvedValue(null);
    vi.mocked(api.graph).mockResolvedValue(fixture(4, 'Fresh Alpha'));

    renderGraph();

    expect(screen.getByText('Loading graph…')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Fresh Alpha' })).toBeInTheDocument();
  });

  it('surfaces revalidation errors when no stale payload exists', async () => {
    vi.mocked(loadGraphCache).mockResolvedValue(null);
    vi.mocked(api.graph).mockRejectedValue(new Error('boom'));

    renderGraph();

    expect(await screen.findByText(/unable to load/i)).toBeInTheDocument();
  });
});
