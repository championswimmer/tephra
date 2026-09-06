import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { NoteViewer } from '../src/components/NoteViewer';
describe('NoteViewer', () => {
  it('shows loading and then server-rendered sanitized HTML', async () => {
    let finish!: (value: { html: string; title: string }) => void;
    vi.spyOn(api, 'rendered').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<NoteViewer vaultId="vault-1" fileId="file-1" onOpen={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Rendering note');
    finish({ title: 'Welcome', html: '<p>Hello <strong>Tephra</strong></p>' });
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByText('Tephra')).toHaveTextContent('Tephra');
    expect(screen.getByRole('button', { name: 'Raw source' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('navigates to the target note when a resolved in-note link is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    vi.spyOn(api, 'rendered').mockResolvedValue({
      title: 'Home',
      html: '<p><a href="#" class="tephra-link" data-link-path="Target" data-file-id="file-2">Target Note</a></p>',
    });
    render(<NoteViewer vaultId="vault-1" fileId="file-1" onOpen={onOpen} />);
    await user.click(await screen.findByRole('link', { name: 'Target Note' }));
    expect(onOpen).toHaveBeenCalledWith('file-2');
  });

  it('shows a notice instead of navigating for unresolved in-note links', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    vi.spyOn(api, 'rendered').mockResolvedValue({
      title: 'Home',
      html: '<p><a href="#" class="tephra-unresolved" data-link-path="Missing" data-unresolved-target="Missing">Missing</a></p>',
    });
    render(<NoteViewer vaultId="vault-1" fileId="file-1" onOpen={onOpen} />);
    await user.click(await screen.findByRole('link', { name: 'Missing' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Note not found: Missing');
  });
});
