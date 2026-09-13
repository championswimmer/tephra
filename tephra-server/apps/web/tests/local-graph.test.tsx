import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/client';
import type { GraphResponse } from '../src/api/types';
import { GraphView } from '../src/components/GraphView';
import { LocalGraph } from '../src/components/LocalGraph';
import { ThemeProvider } from '../src/theme/ThemeContext';

vi.mock('../src/api/client', () => ({ api: { graph: vi.fn() } }));

const hoisted = vi.hoisted(() => ({
  instances: [] as {
    model: { nodes: { id: string }[] };
    groupColors: Array<string | null>;
    selectedId: string | null;
    seed: number;
    onNodeClick: (id: string) => void;
    onNodeHover: (id: string | null) => void;
    onReady: () => void;
  }[],
}));

// The canvas renderer needs a real 2D context + ResizeObserver, neither of
// which exists under jsdom — so the stub renders a focusable <canvas> per
// instance and records every mounted instance's props.
vi.mock('@tephra/graph-renderer', () => ({
  TephraGraph: (props: {
    model: { nodes: { id: string }[] };
    groupColors: Array<string | null>;
    selectedId: string | null;
    seed: number;
    onNodeClick: (id: string) => void;
    onNodeHover: (id: string | null) => void;
    onReady: () => void;
  }) => {
    hoisted.instances.push(props);
    React.useEffect(() => {
      props.onReady?.();
    }, []);
    return <canvas data-testid="tephra-graph-canvas" tabIndex={0} />;
  },
}));

// Chain a—b—c—d plus isolated e.
const chainFixture: GraphResponse = {
  revision: 5,
  truncated: false,
  nodes: [
    { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: [], createdAt: 1 },
    { id: 'b', path: 'b.md', title: 'Beta', kind: 'note', tags: ['x'], createdAt: 2 },
    { id: 'c', path: 'c.md', title: 'Gamma', kind: 'note', tags: [], createdAt: 3 },
    { id: 'd', path: 'd.md', title: 'Delta', kind: 'note', tags: [], createdAt: 4 },
    { id: 'e', path: 'e.md', title: 'Epsilon', kind: 'note', tags: [], createdAt: 5 },
  ],
  edges: [
    { s: 0, t: 1, count: 1, embeds: 0 },
    { s: 1, t: 2, count: 1, embeds: 0 },
    { s: 2, t: 3, count: 1, embeds: 0 },
  ],
};

function renderLocal(node: React.ReactElement) {
  return render(<ThemeProvider>{node}</ThemeProvider>);
}

async function ready(count = 1) {
  await waitFor(() => expect(hoisted.instances.length).toBeGreaterThanOrEqual(count));
}

function lastPushedIds(): string[] {
  const last = hoisted.instances[hoisted.instances.length - 1];
  return (last?.model.nodes.map((node) => node.id) ?? []).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.instances.length = 0;
  window.localStorage.clear();
});

describe('LocalGraph', () => {
  it('restricts the view to the root neighbourhood at depth 1', async () => {
    vi.mocked(api.graph).mockResolvedValue(chainFixture);
    renderLocal(<LocalGraph vaultId="vault-1" fileId="b" onOpen={vi.fn()} />);
    await ready();
    expect(lastPushedIds()).toEqual(['a', 'b', 'c']);
    expect(screen.getByText('2 neighbours within depth 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Local graph' })).toBeInTheDocument();
    // The hand-rolled renderer mounts a focusable canvas per instance.
    expect(screen.getByTestId('tephra-graph-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('tephra-graph-canvas')).toHaveAttribute('tabindex', '0');
  });

  it('honours the persisted local depth without touching global settings', async () => {
    window.localStorage.setItem(
      'tephra:graph:vault-1:local',
      JSON.stringify({ depth: 2, showTags: false }),
    );
    vi.mocked(api.graph).mockResolvedValue(chainFixture);
    renderLocal(<LocalGraph vaultId="vault-1" fileId="b" onOpen={vi.fn()} />);
    await ready();
    expect(lastPushedIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('3 neighbours within depth 2')).toBeInTheDocument();
    expect(window.localStorage.getItem('tephra:graph:vault-1:global')).toBeNull();
  });

  it('shows a neighbourless empty state with a retry', async () => {
    const user = userEvent.setup();
    vi.mocked(api.graph).mockResolvedValue(chainFixture);
    renderLocal(<LocalGraph vaultId="vault-1" fileId="e" onOpen={vi.fn()} />);
    expect(await screen.findByText('No local graph yet')).toBeInTheDocument();
    expect(hoisted.instances).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(vi.mocked(api.graph)).toHaveBeenCalledTimes(2));
  });

  it('shows the empty state for an unknown root', async () => {
    vi.mocked(api.graph).mockResolvedValue(chainFixture);
    renderLocal(<LocalGraph vaultId="vault-1" fileId="missing" onOpen={vi.fn()} />);
    expect(await screen.findByText('No local graph yet')).toBeInTheDocument();
  });

  it('applies local groups and opens neighbours but never synthesized nodes', async () => {
    window.localStorage.setItem(
      'tephra:graph:vault-1:local',
      JSON.stringify({ showTags: true, groups: [{ query: 'tag:#x', color: '#ff0000' }] }),
    );
    const fixture: GraphResponse = {
      ...chainFixture,
      nodes: [
        ...chainFixture.nodes,
        { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [], createdAt: 2 },
      ],
      edges: [...chainFixture.edges, { s: 1, t: 5, count: 1, embeds: 0 }],
    };
    vi.mocked(api.graph).mockResolvedValue(fixture);
    const onOpen = vi.fn();
    renderLocal(<LocalGraph vaultId="vault-1" fileId="b" onOpen={onOpen} />);
    await ready();
    expect(lastPushedIds()).toEqual(['a', 'b', 'c', 'tag:x']);
    const last = hoisted.instances[hoisted.instances.length - 1];
    expect(last?.groupColors).toContain('#ff0000');

    last?.onNodeClick('tag:x');
    expect(onOpen).not.toHaveBeenCalled();
    last?.onNodeClick('a');
    expect(onOpen).toHaveBeenCalledWith('a.md');
  });

  it('coexists with the global graph without cross-talk', async () => {
    const user = userEvent.setup();
    vi.mocked(api.graph).mockResolvedValue(chainFixture);
    renderLocal(
      <>
        <GraphView vaultId="vault-1" onOpen={vi.fn()} />
        <LocalGraph vaultId="vault-1" fileId="b" onOpen={vi.fn()} />
      </>,
    );
    await ready(2);
    const sizes = hoisted.instances.map((instance) => instance.model.nodes.length);
    // Global hides the isolated `e` by default; local shows b's depth-1 hood.
    expect(sizes).toContain(4);
    expect(sizes).toContain(3);
    // Changing the global panel persists only under the global key.
    const toggles = screen.getAllByRole('button', { name: 'Graph settings' });
    await user.click(toggles[0]!);
    const globalPanel = document.getElementById('graph-settings-panel-global');
    expect(globalPanel).not.toBeNull();
    fireEvent.click(within(globalPanel!).getByLabelText('Tags'));
    await waitFor(() =>
      expect(window.localStorage.getItem('tephra:graph:vault-1:global')).toContain(
        '"showTags":true',
      ),
    );
    expect(window.localStorage.getItem('tephra:graph:vault-1:local')).toBeNull();
  });
});
