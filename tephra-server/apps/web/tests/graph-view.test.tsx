import * as React from 'react';
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
    onReady: () => void;
  } | null,
  lastKey: null as string | null,
}));

// The canvas renderer needs a real 2D context + ResizeObserver, neither of
// which exists under jsdom — so the mock renders a focusable <canvas> that
// records its props, fires onReady on mount, maps clicks to node 'a', and
// records keyboard events for the keyboard-pan assertion.
vi.mock('@tephra/graph-renderer', () => ({
  TephraGraph: (props: (typeof hoisted)['lastProps']) => {
    hoisted.lastProps = props;
    React.useEffect(() => {
      props?.onReady?.();
    }, []);
    return (
      <canvas
        data-testid="tephra-graph-canvas"
        tabIndex={0}
        role="img"
        aria-label="Test graph canvas"
        onClick={() => props?.onNodeClick?.('a')}
        onKeyDown={(event: React.KeyboardEvent) => {
          hoisted.lastKey = event.key;
        }}
      />
    );
  },
}));

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

const orphanFixture: GraphResponse = {
  ...graphFixture,
  nodes: [
    ...graphFixture.nodes,
    { id: 'solo', path: 'solo.md', title: 'Solo', kind: 'note', tags: [], createdAt: 9 },
  ],
};

function mockGraph(graph: GraphResponse) {
  vi.mocked(api.graph).mockResolvedValue(graph);
}

// Chained notes (each linked to the next) so none are filtered as orphans.
function bigGraphFixture(count: number): GraphResponse {
  return {
    revision: 9,
    truncated: false,
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      path: `n${i}.md`,
      title: null,
      kind: 'note',
      tags: [],
      createdAt: i,
    })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ s: i, t: i + 1, count: 1, embeds: 0 })),
  };
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
  hoisted.lastKey = null;
  window.localStorage.clear();
});

describe('GraphView shell', () => {
  it('shows the loading state while the graph loads', () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(screen.getByText('Loading graph…')).toBeInTheDocument();
  });

  it('mounts the canvas renderer with the Obsidian-default filtered model', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    // The hand-rolled renderer mounts exactly one focusable canvas.
    expect(screen.getByTestId('tephra-graph-canvas')).toBeInTheDocument();
    // Defaults hide tags and attachments; notes + unresolved survive.
    expect(pushedIds()).toEqual(['a', 'b', 'unresolved:Missing']);
    expect(hoisted.lastProps?.groupColors).toEqual([null, null, null]);
    expect(hoisted.lastProps?.seed).toBe(3);
    expect(hoisted.lastProps?.selectedId).toBeNull();
  });

  it('reports header counts matching the pushed model', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    // 3 visible nodes, 2 surviving links (a–b, b–Missing).
    expect(screen.getByText('3 notes · 2 connections')).toBeInTheDocument();
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

  it('navigates when the canvas itself is clicked', async () => {
    const user = userEvent.setup();
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await ready();
    await user.click(screen.getByTestId('tephra-graph-canvas'));
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

  it('forwards canvas keyboard events and keeps the canvas focusable', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    const canvas = screen.getByTestId('tephra-graph-canvas');
    expect(canvas).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect(hoisted.lastKey).toBe('ArrowRight');
    fireEvent.keyDown(canvas, { key: '+' });
    expect(hoisted.lastKey).toBe('+');
  });

  it('shows orphan notes when the orphan toggle is on', async () => {
    const user = userEvent.setup();
    mockGraph(orphanFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    // Orphans hidden by default: the isolated solo note is filtered out.
    expect(pushedIds()).not.toContain('solo');
    await user.click(screen.getByRole('button', { name: 'Graph settings' }));
    await user.click(screen.getByLabelText('Orphans'));
    await waitFor(() => expect(pushedIds()).toContain('solo'));
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

  it('publishes the __tephraGraph debug hook with live counts', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    await waitFor(() =>
      expect(
        (window as unknown as { __tephraGraph?: { nodeCount: number } }).__tephraGraph,
      ).toMatchObject({ nodeCount: 3 }),
    );
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

  it('shows the budget notice only when the model exceeds 500 nodes', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await ready();
    expect(screen.queryByTestId('graph-budget-notice')).toBeNull();
  });

  it('shows the budget notice for a 501-node model', async () => {
    mockGraph(bigGraphFixture(501));
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    const notice = await screen.findByTestId('graph-budget-notice');
    expect(notice).toHaveTextContent('Showing 500 of 501 — zoom in to reveal smaller nodes.');
  });
});
