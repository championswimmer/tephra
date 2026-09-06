import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { GraphResponse } from '../src/api/types';

const { captured } = vi.hoisted(() => ({
  captured: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('react-force-graph-2d', async () => {
  const React = await import('react');
  return {
    default: (props: Record<string, unknown>) => {
      captured.current = props;
      const data = props.graphData as { nodes: unknown[]; links: unknown[] };
      return React.createElement('div', {
        'data-testid': 'force-graph',
        'data-nodes': data.nodes.length,
        'data-links': data.links.length,
      });
    },
  };
});

import type { ReactElement } from 'react';
import { GraphView, hexToRgba, mapGraphToForceData } from '../src/components/GraphView';
import { ThemeProvider } from '../src/theme/ThemeContext';

function renderGraph(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

const graphFixture: GraphResponse = {
  revision: 3,
  nodes: [
    { id: 'a', path: 'a.md', title: 'Alpha' },
    { id: 'b', path: 'b.md', title: null },
    { id: 'c', path: 'c.md', title: 'Gamma' },
  ],
  edges: [
    { source: 'a', target: 'b', count: 1 },
    { source: 'b', target: 'c', count: 2 },
  ],
};

function mockGraph(result: GraphResponse) {
  vi.spyOn(api, 'graph').mockResolvedValue(result);
}

describe('mapGraphToForceData', () => {
  it('maps API nodes and edges to force-graph nodes and links', () => {
    const data = mapGraphToForceData(graphFixture);
    expect(data.nodes).toEqual([
      { id: 'a', label: 'Alpha', path: 'a.md' },
      { id: 'b', label: 'b.md', path: 'b.md' },
      { id: 'c', label: 'Gamma', path: 'c.md' },
    ]);
    expect(data.links).toEqual([
      { source: 'a', target: 'b', count: 1 },
      { source: 'b', target: 'c', count: 2 },
    ]);
  });

  it('handles an empty graph and a single node', () => {
    expect(
      mapGraphToForceData({ revision: 1, nodes: [], edges: [] }),
    ).toEqual({ nodes: [], links: [] });
    const single = mapGraphToForceData({
      revision: 1,
      nodes: [{ id: 'solo', path: 'solo.md', title: 'Solo' }],
      edges: [],
    });
    expect(single.nodes).toHaveLength(1);
    expect(single.links).toHaveLength(0);
  });
});

describe('GraphView', () => {
  it('shows a loading state while fetching', () => {
    vi.spyOn(api, 'graph').mockReturnValue(new Promise(() => {}));
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading graph');
  });

  it('shows an empty state when the graph has no nodes', async () => {
    mockGraph({ revision: 1, nodes: [], edges: [] });
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(await screen.findByText('The graph is empty')).toBeInTheDocument();
    expect(screen.queryByTestId('force-graph')).not.toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const user = userEvent.setup();
    const graph = vi.spyOn(api, 'graph');
    graph.mockRejectedValueOnce(new Error('boom'));
    graph.mockResolvedValue(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('force-graph')).toBeInTheDocument();
    expect(graph).toHaveBeenCalledTimes(2);
  });

  it('passes mapped data and interaction props to the force graph', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    const canvas = await screen.findByTestId('force-graph');
    expect(canvas).toHaveAttribute('data-nodes', '3');
    expect(canvas).toHaveAttribute('data-links', '2');
    const props = captured.current as unknown as {
      graphData: { nodes: { id: string; label: string }[] };
      nodeLabel: string;
      enableZoomInteraction: boolean;
      enablePanInteraction: boolean;
      onNodeClick: (node: { id: string }) => void;
      onNodeHover: (node: { id: string } | null) => void;
      nodeColor: (node: { id: string }) => string;
    };
    expect(props.graphData.nodes.map((node) => node.label)).toEqual([
      'Alpha',
      'b.md',
      'Gamma',
    ]);
    expect(props.nodeLabel).toBe('label');
    expect(props.enableZoomInteraction).toBe(true);
    expect(props.enablePanInteraction).toBe(true);
    expect(typeof props.onNodeClick).toBe('function');
    expect(typeof props.onNodeHover).toBe('function');
  });

  it('navigates to the note route on node click', async () => {
    const user = userEvent.setup();
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await screen.findByTestId('force-graph');
    const props = captured.current as unknown as {
      onNodeClick: (node: { id: string }) => void;
    };
    props.onNodeClick({ id: 'b' });
    expect(onOpen).toHaveBeenCalledWith('b');
    // The keyboard-focusable fallback list offers the same navigation.
    const fallback = screen.getByRole('list', { name: 'Notes in graph' });
    expect(fallback).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'b.md' }));
    expect(onOpen).toHaveBeenCalledWith('b');
  });

  it('shows the hovered note title with an Open note action', async () => {
    const user = userEvent.setup();
    mockGraph(graphFixture);
    const onOpen = vi.fn();
    renderGraph(<GraphView vaultId="vault-1" onOpen={onOpen} />);
    await screen.findByTestId('force-graph');
    const props = captured.current as unknown as {
      onNodeHover: (node: { id: string } | null) => void;
    };
    props.onNodeHover({ id: 'a' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open note' })).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Open note' }));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('highlights the currently-open note when selectedId is provided', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} selectedId="c" />);
    await screen.findByTestId('force-graph');
    const props = captured.current as unknown as {
      nodeColor: (node: { id: string }) => string;
      backgroundColor: string;
    };
    const selected = props.nodeColor({ id: 'c' });
    const neighbor = props.nodeColor({ id: 'b' });
    const distant = props.nodeColor({ id: 'a' });
    // Obsidian default light palette: accent highlight, dimmed graph-node.
    expect(selected).toBe('#7b6cd9');
    expect(neighbor).toBe('#7b6cd9');
    expect(distant).not.toBe('#7b6cd9');
    expect(props.backgroundColor).toBe('#ffffff');
    expect(
      screen.getByRole('button', { name: 'Gamma' }).getAttribute('aria-current'),
    ).toBe('true');
  });

  it('paints uniform graph-node dots when nothing is active', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    await screen.findByTestId('force-graph');
    const props = captured.current as unknown as {
      nodeColor: (node: { id: string }) => string;
      linkColor: (link: { source: string; target: string }) => string;
    };
    expect(props.nodeColor({ id: 'a' })).toBe('#000000');
    expect(props.linkColor({ source: 'a', target: 'b' })).toBe('#d1d1d1');
  });

  it('hexToRgba expands short and long hex colors', () => {
    expect(hexToRgba('#000000', 0.22)).toBe('rgba(0, 0, 0, 0.22)');
    expect(hexToRgba('#d1d1d1', 0.45)).toBe('rgba(209, 209, 209, 0.45)');
    expect(hexToRgba('#abc', 1)).toBe('rgba(170, 187, 204, 1)');
  });

  it('labels only the active node, leaving the rest unpainted', async () => {
    mockGraph(graphFixture);
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} selectedId="c" />);
    await screen.findByTestId('force-graph');
    const props = captured.current as unknown as {
      nodeCanvasObjectMode: (node: { id: string }) => string | undefined;
      nodeCanvasObject: (
        node: { id: string; x: number; y: number },
        ctx: CanvasRenderingContext2D,
        scale: number,
      ) => void;
    };
    expect(props.nodeCanvasObjectMode({ id: 'c' })).toBe('after');
    expect(props.nodeCanvasObjectMode({ id: 'a' })).toBeUndefined();
    const ctx = { font: '', textAlign: '', textBaseline: '', fillStyle: '', fillText: vi.fn() };
    props.nodeCanvasObject(
      { id: 'a', x: 0, y: 0 },
      ctx as unknown as CanvasRenderingContext2D,
      1,
    );
    expect(ctx.fillText).not.toHaveBeenCalled();
    props.nodeCanvasObject(
      { id: 'c', x: 4, y: 8 },
      ctx as unknown as CanvasRenderingContext2D,
      1,
    );
    expect(ctx.fillText).toHaveBeenCalledWith('Gamma', 10, 8);
  });

  it('renders a single-node graph without links', async () => {
    mockGraph({
      revision: 1,
      nodes: [{ id: 'solo', path: 'solo.md', title: 'Solo' }],
      edges: [],
    });
    renderGraph(<GraphView vaultId="vault-1" onOpen={vi.fn()} />);
    const canvas = await screen.findByTestId('force-graph');
    expect(canvas).toHaveAttribute('data-nodes', '1');
    expect(canvas).toHaveAttribute('data-links', '0');
    expect(screen.getByRole('button', { name: 'Solo' })).toBeInTheDocument();
  });
});
