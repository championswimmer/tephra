import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { VaultListPage } from '../src/routes/VaultListPage';

describe('VaultListPage', () => {
  it('requires exact vault-name confirmation before deleting', async () => {
    vi.spyOn(api, 'vaults').mockResolvedValue({
      vaults: [{ id: 'vault-1', name: 'Alpha', latestRevision: 3 }],
    });
    const deleteVault = vi.spyOn(api, 'deleteVault').mockResolvedValue();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <VaultListPage />
      </MemoryRouter>,
    );

    await screen.findByRole('link', { name: /Alpha/i });
    await user.click(screen.getByRole('button', { name: 'Delete vault' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete vault' });
    expect(dialog).toBeInTheDocument();
    const confirmation = within(dialog).getByLabelText('Vault name');
    const confirmDelete = within(dialog).getByRole('button', { name: 'Delete vault' });

    expect(confirmDelete).toBeDisabled();
    await user.type(confirmation, 'alpha');
    expect(confirmDelete).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, 'Alpha');
    expect(confirmDelete).toBeEnabled();

    await user.click(confirmDelete);

    await waitFor(() => expect(deleteVault).toHaveBeenCalledWith('vault-1', 'Alpha'));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /Alpha/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('No vaults yet')).toBeInTheDocument();
  });
});
