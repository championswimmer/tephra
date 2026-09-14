import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FileBreadcrumb } from '../src/components/FileBreadcrumb';

describe('FileBreadcrumb', () => {
  it('shows the full vault + path breadcrumb', () => {
    render(<FileBreadcrumb vaultName="demo" path="Notes/Target Note.md" />);
    const nav = screen.getByRole('navigation', { name: 'File path' });
    expect(nav).toHaveTextContent('demo');
    expect(nav).toHaveTextContent('Notes');
    expect(nav).toHaveTextContent('Target Note.md');
    expect(screen.getByText('Target Note.md')).toHaveAttribute('aria-current', 'page');
  });

  it('copies the vault-relative path to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    try {
      render(<FileBreadcrumb vaultName="demo" path="Notes/Target Note.md" />);
      await user.click(screen.getByRole('button', { name: 'Copy file path' }));
      expect(writeText).toHaveBeenCalledWith('Notes/Target Note.md');
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    } finally {
      // Remove the instance override so the prototype getter shines through.
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});
