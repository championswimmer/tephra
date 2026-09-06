import { render, screen } from '@testing-library/react';
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
});
