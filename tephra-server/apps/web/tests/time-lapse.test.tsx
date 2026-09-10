import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/api/client';
import type { GraphResponse } from '../src/api/types';
import { GraphView, TIME_LAPSE_DURATION_MS } from '../src/components/GraphView';
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
    createGraphRenderer: vi.fn(async () => rendererStub),
    createSimulationHost: vi.fn(() => hostStub),
  };
});

vi.mock('../src/graph/renderer/renderer', () => ({
  createGraphRenderer: hoisted.createGraphRenderer,
}));
vi.mock('../src/graph/worker/host', () => ({
  createSimulationHost: hoisted.createSimulationHost,
}));

// b and c share a creation timestamp; tag:x is hidden by default.
const fixture: GraphResponse = {
  revision: 9,
  truncated: false,
  nodes: [
    { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: [], createdAt: 1000 },
    { id: 'b', path: 'b.md', title: 'Beta', kind: 'note', tags: [], createdAt: 2000 },
    { id: 'c', path: 'c.md', title: 'Gamma', kind: 'note', tags: [], createdAt: 2000 },
    { id: 'd', path: 'd.md', title: 'Delta', kind: 'note', tags: [], createdAt: 4000 },
    { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [], createdAt: 1000 },
  ],
  edges: [
    { s: 0, t: 1, count: 1, embeds: 0 },
    { s: 1, t: 2, count: 1, embeds: 0 },
    { s: 2, t: 3, count: 1, embeds: 0 },
    { s: 0, t: 4, count: 1, embeds: 0 },
  ],
};

async function renderReady() {
  vi.mocked(api.graph).mockResolvedValue(fixture);
  render(
    <ThemeProvider>
      <GraphView vaultId="vault-1" onOpen={vi.fn()} />
    </ThemeProvider>,
  );
  await waitFor(() => expect(hoisted.createGraphRenderer).toHaveBeenCalled());
  await waitFor(() => expect(hoisted.rendererStub.setModel).toHaveBeenCalled());
  vi.useFakeTimers();
}

function pushedIds(): string[] {
  const calls = hoisted.rendererStub.setModel.mock.calls;
  const last = calls[calls.length - 1]![0] as { nodes: { id: string }[] };
  return last.nodes.map((node) => node.id).sort();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Time-lapse', () => {
  it('plays the cutoff forward and updates the status text', async () => {
    await renderReady();
    expect(pushedIds()).toEqual(['a', 'b', 'c', 'd']);
    fireEvent.click(screen.getByRole('button', { name: 'Play time-lapse' }));
    expect(screen.getByRole('button', { name: 'Pause time-lapse' })).toBeInTheDocument();

    await advance(TIME_LAPSE_DURATION_MS / 2);
    expect(pushedIds()).toEqual(['a', 'b', 'c']);
    expect(screen.getByText(/3 of 4 notes up to/)).toBeInTheDocument();

    await advance(TIME_LAPSE_DURATION_MS / 2);
    expect(pushedIds()).toEqual(['a', 'b', 'c', 'd']);
    // Playback stops itself at the end of the range.
    expect(screen.getByRole('button', { name: 'Play time-lapse' })).toBeInTheDocument();
  });

  it('pausing keeps the last cutoff without snapping back', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Play time-lapse' }));
    await advance(2000);
    const midFlight = pushedIds();
    expect(midFlight.length).toBeLessThan(4);
    fireEvent.click(screen.getByRole('button', { name: 'Pause time-lapse' }));
    await advance(TIME_LAPSE_DURATION_MS);
    expect(pushedIds()).toEqual(midFlight);
    expect(screen.getByRole('button', { name: 'Play time-lapse' })).toBeInTheDocument();
  });

  it('scrubbing pauses, filters to simultaneous timestamps, and resets', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Play time-lapse' }));
    const slider = screen.getByLabelText('Time-lapse');
    fireEvent.change(slider, { target: { value: '2000' } });
    // Manual scrub pauses playback…
    expect(screen.getByRole('button', { name: 'Play time-lapse' })).toBeInTheDocument();
    // …and nodes sharing the exact timestamp appear together.
    expect(pushedIds()).toEqual(['a', 'b', 'c']);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(pushedIds()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('All 4 notes')).toBeInTheDocument();
  });

  it('filter controls stay live while playback runs', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Play time-lapse' }));
    await advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Graph settings' }));
    fireEvent.click(screen.getByLabelText('Tags'));
    // No waitFor here: the fake clock is running, so assert on the flushed update.
    await advance(0);
    expect(pushedIds()).toContain('tag:x');
    // Playback was not disturbed by the filter change.
    expect(screen.getByRole('button', { name: 'Pause time-lapse' })).toBeInTheDocument();
  });
});
