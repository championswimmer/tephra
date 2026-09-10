import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphSettingsPanel, GRAPH_SEARCH_DEBOUNCE_MS } from '../src/components/GraphSettingsPanel';
import { DEFAULT_GRAPH_SETTINGS, type GraphSettings } from '../src/graph/settings';

function renderPanel(overrides: Partial<GraphSettings> = {}) {
  const onChange = vi.fn();
  const onRestoreDefaults = vi.fn();
  const settings = { ...DEFAULT_GRAPH_SETTINGS, ...overrides };
  const view = render(
    <GraphSettingsPanel
      id="graph-settings-panel"
      scope="global"
      settings={settings}
      onChange={onChange}
      onRestoreDefaults={onRestoreDefaults}
    />,
  );
  return { onChange, onRestoreDefaults, view };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GraphSettingsPanel', () => {
  it('toggles filter checkboxes through onChange', () => {
    const { onChange } = renderPanel();
    fireEvent.click(screen.getByLabelText('Tags'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showTags: true }));
    fireEvent.click(screen.getByLabelText('Existing files only'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ existingOnly: true }));
  });

  it('debounces the search box before reporting', async () => {
    const { onChange } = renderPanel();
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'alpha' } });
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(
      () => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'alpha' })),
      { timeout: GRAPH_SEARCH_DEBOUNCE_MS + 1000 },
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('adopts externally imposed search text', () => {
    const { view } = renderPanel();
    expect(screen.getByLabelText('Search')).toHaveValue('');
    view.rerender(
      <GraphSettingsPanel
        id="graph-settings-panel"
        scope="global"
        settings={{ ...DEFAULT_GRAPH_SETTINGS, search: 'tag:#x' }}
        onChange={vi.fn()}
        onRestoreDefaults={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Search')).toHaveValue('tag:#x');
  });

  it('adds, edits, and removes color groups', () => {
    const { onChange, view } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ groups: [{ query: '', color: expect.any(String) }] }),
    );
    view.unmount();

    const second = renderPanel({ groups: [{ query: 'tag:#x', color: '#ff0000' }] });
    fireEvent.change(screen.getByLabelText('Group 1 query'), { target: { value: 'path:docs' } });
    expect(second.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ groups: [{ query: 'path:docs', color: '#ff0000' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove group 1' }));
    expect(second.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groups: [] }));
  });

  it('reports display and force slider changes as numbers', () => {
    const { onChange } = renderPanel();
    fireEvent.change(screen.getByLabelText('Node size'), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ nodeSize: 2 }));
    fireEvent.change(screen.getByLabelText('Repel force'), { target: { value: '1.5' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ repelForce: 1.5 }));
  });

  it('shows the depth slider only for the local scope', () => {
    const { view } = renderPanel();
    expect(within(view.container).queryByLabelText('Depth')).not.toBeInTheDocument();
    view.unmount();
    const local = render(
      <GraphSettingsPanel
        id="graph-settings-local"
        scope="local"
        settings={DEFAULT_GRAPH_SETTINGS}
        onChange={vi.fn()}
        onRestoreDefaults={vi.fn()}
        depthVisible
      />,
    );
    expect(within(local.container as HTMLElement).getByLabelText('Depth')).toBeInTheDocument();
  });

  it('restores defaults through the parent handler', () => {
    const { onRestoreDefaults } = renderPanel({ showTags: true });
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(onRestoreDefaults).toHaveBeenCalledTimes(1);
  });
});
