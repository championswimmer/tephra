import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/client';
import type { GraphResponse } from '../src/api/types';
import { GraphView } from '../src/components/GraphView';
import { ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('../src/api/client', () => ({ api: { graph: vi.fn() } }));

const hoisted = vi.hoisted(() => {
  const rendererStub = {
    setModel: vi.fn(),
    setPositions: vi.fn(),
    setSettings: vi.fn(),
    setTheme: vi.fn(),
    setActive: vi.fn(),
    zoomToFit: vi.fn(),
    screenToWorld: vi.fn(),
    destroy: vi.fn(),
  };
  const hostStub = {
    workerBacked: false,
    setGraph: vi.fn(),
    setFilteredGraph: vi.fn(),
    setForces: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    reheat: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    rendererStub,
    hostStub,
    createGraphRenderer: vi.fn(async (_host: unknown, _callbacks: unknown) => rendererStub),
    createSimulationHost: vi.fn((_events: unknown) => hostStub),
    callbacks: {} as Record<string, (...args: never[]) => void>,
  };
});

vi.mock('../src/graph/renderer/renderer', () => ({
  createGraphRenderer: (host: unknown, callbacks: unknown) => {
    hoisted.callbacks = (callbacks ?? {}) as Record<string, (...args: never[]) => void>;
    return hoisted.createGraphRenderer(host, callbacks);
  },
}));
vi.mock('../src/graph/worker/host', () => ({
  createSimulationHost: (events: unknown) => hoisted.createSimulationHost(events),
}));

const graphFixture: GraphResponse = {
  revision: 3,
  truncated: false,
  nodes: [
    { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: ['x'], createdAt: 1 },
    { id: 'b', path: 'b.md', title: null, kind: 'note', tags: [], createdAt: 2 },
    { id: 'img', path: 'img.png', title: null, kind: 'attachment', tags: [], createdAt: 3 },
    { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [], createdAt: 1 },
    { id: 'unresolved:Missing', path: 'Missing', title: 'Missing', kind: 'unresolved', tags: [], createdAt: 2 },
  ],
  edges: [
    { s: 0, t: 1, count: 1, embeds: 0 },
    { s: 0, t: 3, count: 1, embeds: 0 },
    { s: 0, t: 2, count: 1, embeds: 1 },
    { s: 1, t: 4, count: 1, embeds: 0 },
  ],
};

function mockGraph(graph: GraphResponse) {
  vi.mocked(api.graph).mockResolvedValue(graph);
}

function renderGraph(node: React.ReactElement) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

async function ready() {
  await waitFor(() => expect(hoisted.createGraphRenderer).toHaveBeenCalled());
  await waitFor(() => expect(hoisted.rendererStub.setModel).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('GraphView shell', () => {
  it('shows the loading state while the graph loads', () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(screen.getByText('Loading graph…')).toBeInTheDocument();
  });

  it('pushes the Obsidian-default filtered model to the renderer and simulation', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    // Defaults hide tags and attachments; notes + unresolved survive.
    const model = hoisted.rendererStub.setModel.mock.calls[0]![0] as {
      nodes: { id: string }[];
    };
    expect(model.nodes.map((node: { id: string }) => node.id).sort()).toEqual(['a', 'b', 'unresolved:Missing']);
    const colors = hoisted.rendererStub.setModel.mock.calls[0]![1];
    expect(colors).toEqual([null, null, null]);
    expect(hoisted.hostStub.setGraph).toHaveBeenCalledTimes(1);
    expect(hoisted.hostStub.setGraph.mock.calls[0]![0]).toMatchObject({ nodeCount: 3 });
  });

  it('opens notes on node click but ignores synthesized nodes', async () => {
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await ready();
    (hoisted.callbacks.onNodeClick as (id: string) => void)('unresolved:Missing');
    expect(onOpen).not.toHaveBeenCalled();
    (hoisted.callbacks.onNodeClick as (id: string) => void)('a');
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('shows the selection bar for the hovered node', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    (hoisted.callbacks.onNodeHover as (id: string | null) => void)('a');
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open note' })).toBeInTheDocument();
  });

  it('marks the open note active in the renderer', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} selectedId="b" />);
    await ready();
    expect(hoisted.rendererStub.setActive).toHaveBeenCalledWith('b');
  });

  it('falls back to the note list with an explanation when WebGL fails', async () => {
    hoisted.createGraphRenderer.mockRejectedValueOnce(new Error('no webgl'));
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(await screen.findByText(/needs WebGL/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('reports an empty graph and surfaces load errors', async () => {
    mockGraph({ revision: 1, truncated: false, nodes: [], edges: [] });
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(await screen.findByText('The graph is empty')).toBeInTheDocument();

    vi.mocked(api.graph).mockRejectedValueOnce(new Error('boom'));
    const { unmount } = renderGraph(<GraphView vaultId="vault-2" onOpen={vi.fn()} />);
    expect(await screen.findByText(/unable to load/i)).toBeInTheDocument();
    unmount();
  });

  it('opens fallback-list notes and flags the selected one', async () => {
    const user = userEvent.setup();
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} selectedId="a" />);
    const button = await screen.findByRole('button', { name: 'b.md' });
    await user.click(button);
    expect(onOpen).toHaveBeenCalledWith('b.md');
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-current', 'true');
  });

  it('toggles the settings panel and applies tag visibility live', async () => {
    const user = userEvent.setup();
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    const toggle = screen.getByRole('button', { name: 'Graph settings' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByLabelText('Tags'));
    await waitFor(() => {
      const calls = hoisted.rendererStub.setModel.mock.calls;
      const last = calls[calls.length - 1]![0] as { nodes: { id: string }[] };
      expect(last.nodes.map((node) => node.id)).toContain('tag:x');
    });
    // The change persists per vault.
    const stored = JSON.parse(localStorage.getItem('tephra:graph:vault-1:global') ?? '{}');
    expect(stored.showTags).toBe(true);
    // Escape closes the panel and returns focus to the toggle.
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });
});
