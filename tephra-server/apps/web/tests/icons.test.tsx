import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from '../src/components/FileTree';
import { SettingsModal } from '../src/components/SettingsModal';
import { ThemeSelector } from '../src/components/ThemeSelector';
import { LinksPanel } from '../src/components/LinksPanel';
import { ErrorState } from '../src/components/Status';
import { GraphSettingsPanel } from '../src/components/GraphSettingsPanel';
import { ThemeProvider } from '../src/theme/ThemeContext';
import type { VaultFile } from '../src/api/types';
import { DEFAULT_GRAPH_SETTINGS } from '@tephra/graph-renderer/pure';

vi.mock('@tephra/graph-renderer/pure', async () => {
  const settings = await import('../../../packages/graph-renderer/src/settings');
  return { ...settings };
});

/**
 * Icon-pack regression test: every UI-chrome icon must be a Lucide SVG
 * (`svg.lucide`, decorative) rather than a unicode glyph, and must not
 * disturb the accessible names of its control.
 */
describe('Lucide icon pack', () => {
  it('renders the file-tree search, folder, and file icons as Lucide SVGs', () => {
    const files: VaultFile[] = [
      { fileId: '1', path: 'Projects/Tephra.md', kind: 'markdown', size: 10, mtime: 1 },
      {
        fileId: '2',
        path: 'cover.png',
        kind: 'attachment',
        mimeType: 'image/png',
        size: 10,
        mtime: 1,
      },
    ];
    const { container } = render(<FileTree files={files} onSelect={vi.fn()} />);
    const icons = container.querySelectorAll('svg.lucide[aria-hidden="true"]');
    // Search + folder chevron + markdown file + attachment file.
    expect(icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
    // Accessible names survive the icon swap.
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tephra\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cover\.png/ })).toBeInTheDocument();
  });

  it('renders the settings modal close button with a Lucide icon', () => {
    const { container } = render(
      <ThemeProvider>
        <SettingsModal open onClose={vi.fn()} />
      </ThemeProvider>,
    );
    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(close.querySelector('svg.lucide[aria-hidden="true"]')).toBeInTheDocument();
    expect(
      container.querySelector('button[aria-label="Close settings"] svg.lucide'),
    ).toBeInTheDocument();
  });

  it('renders the theme options with Lucide light/dark/system icons', () => {
    const { container } = render(
      <ThemeProvider>
        <ThemeSelector />
      </ThemeProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Base color scheme' })).toBeInTheDocument();
    expect(container.querySelectorAll('.theme-swatch svg.lucide').length).toBe(3);
  });

  it('renders the graph settings actions with Lucide icons', () => {
    const { container } = render(
      <MemoryRouter>
        <GraphSettingsPanel
          id="graph-settings-panel"
          scope="global"
          settings={{ ...DEFAULT_GRAPH_SETTINGS, groups: [{ query: 'tag:#x', color: '#ff0000' }] }}
          onChange={vi.fn()}
          onRestoreDefaults={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Add group' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove group 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeInTheDocument();
    expect(
      container.querySelectorAll('svg.lucide[aria-hidden="true"]').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('renders links-panel headers and the error state with Lucide icons', () => {
    const { container } = render(
      <MemoryRouter>
        <LinksPanel links={[]} backlinks={[]} onOpen={vi.fn()} />
        <ErrorState error={new Error('boom')} />
      </MemoryRouter>,
    );
    expect(
      container.querySelectorAll('svg.lucide[aria-hidden="true"]').length,
    ).toBeGreaterThanOrEqual(3);
  });
});
