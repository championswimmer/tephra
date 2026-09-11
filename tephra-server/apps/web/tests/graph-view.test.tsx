import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/client';
import type { GraphResponse } from '../src/api/types';
import { GraphView } from '../src/components/GraphView';
import { ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('../src/api/client', () => ({ api: { graph: vi.fn() } }));

const hoisted = vi.hoisted(() => ({
  lastProps: null as {
    model: { nodes: { id: string; path: string; title: string | null; kind: string }[] };
    groupColors: Array<string | null>;
    selectedId: string | null;
    seed: number;
    onNodeClick: (id: string) => void;
    onNodeHover: (id: string | null) => void;
    onReady: (counts: { nodeCount: number; linkCount: number }) => void;
    onWebglError: (error: unknown) => void;
  } | null,
}));

// The package barrel pulls in Sigma (WebGL) which cannot evaluate under
// jsdom (top-level `WebGL2RenderingContext` constants), so the mock loads
// the pure sources directly (model/filter/depth/settings/groups/palette —
// none touch Sigma) plus a TephraGraph stub.
vi.mock('@tephra/graph-renderer', async () => {
  const model = await import('../../../packages/graph-renderer/src/model');
  const filter = await import('../../../packages/graph-renderer/src/filter');
  const depth = await import('../../../packages/graph-renderer/src/depth');
  const settings = await import('../../../packages/graph-renderer/src/settings');
  const groups = await import('../../../packages/graph-renderer/src/groups');
  const palette = await import('../../../packages/graph-renderer/src/palette');
  return {
    ...model,
    ...filter,
    ...depth,
    ...settings,
    ...groups,
    ...palette,
    TephraGraph: (props: (typeof hoisted)['lastProps']) => {
      hoisted.lastProps = props;
      return <div data-testid="tephra-graph-stub" />;
    },
  };
});

const graphFixture: GraphResponse = {
  revision: 3,
  truncated: false,
  nodes: [
    { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: ['x'], createdAt: 1 },
    { id: 'b', path: 'b.md', title: null, kind: 'note', tags: [], createdAt: 2 },
    { id: 'img', path: 'img.png', title: null, kind: 'attachment', tags: [], createdAt: 3 },
    { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [], createdAt: 1 },
    {
      id: 'unresolved:Missing',
      path: 'Missing',
      title: 'Missing',
      kind: 'unresolved',
      tags: [],
      createdAt: 2,
    },
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
  await waitFor(() => expect(hoisted.lastProps).not.toBeNull());
}

function pushedIds(): string[] {
  return (hoisted.lastProps?.model.nodes.map((node) => node.id) ?? []).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.lastProps = null;
  window.localStorage.clear();
});

describe('GraphView shell', () => {
  it('shows the loading state while the graph loads', () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(screen.getByText('Loading graph…')).toBeInTheDocument();
  });

  it('passes the Obsidian-default filtered model and group colors to TephraGraph', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    // Defaults hide tags and attachments; notes + unresolved survive.
    expect(pushedIds()).toEqual(['a', 'b', 'unresolved:Missing']);
    expect(hoisted.lastProps?.groupColors).toEqual([null, null, null]);
    expect(hoisted.lastProps?.seed).toBe(3);
    expect(hoisted.lastProps?.selectedId).toBeNull();
  });

  it('opens notes on node click but ignores synthesized tag nodes', async () => {
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await ready();
    hoisted.lastProps?.onNodeClick('tag:x');
    expect(onOpen).not.toHaveBeenCalled();
    hoisted.lastProps?.onNodeClick('a');
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('opens attachments on node click', async () => {
    window.localStorage.setItem(
      'tephra:graph:vault-1:global',
      JSON.stringify({ showAttachments: true }),
    );
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await ready();
    expect(pushedIds()).toContain('img');
    hoisted.lastProps?.onNodeClick('img');
    expect(onOpen).toHaveBeenCalledWith('img.png');
  });

  it('shows the selection bar for the hovered node', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    hoisted.lastProps?.onNodeHover('a');
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open note' })).toBeInTheDocument();
  });

  it('passes the selected id through to TephraGraph', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} selectedId="b" />);
    await ready();
    expect(hoisted.lastProps?.selectedId).toBe('b');
  });

  it('shows the WebGL fallback notice when the renderer reports an error', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    hoisted.lastProps?.onWebglError(new Error('no webgl'));
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
    await waitFor(() => expect(pushedIds()).toContain('tag:x'));
    // The change persists per vault.
    const stored = JSON.parse(window.localStorage.getItem('tephra:graph:vault-1:global') ?? '{}');
    expect(stored.showTags).toBe(true);
    // Escape closes the panel and returns focus to the toggle.
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  it('surfaces the truncated notice for capped payloads', async () => {
    mockGraph({ ...graphFixture, truncated: true });
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(await screen.findByText(/larger than the 10 000/)).toBeInTheDocument();
  });
});
