import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { TokenManager } from '../src/components/TokenManager';
describe('TokenManager', () => {
  it('shows a newly created secret once and dismisses it', async () => {
    vi.spyOn(api, 'tokens').mockResolvedValue({ tokens: [] });
    vi.spyOn(api, 'createToken').mockResolvedValue({
      id: 'token-1',
      name: 'Laptop',
      token: 'tephra_secret_value',
      createdAt: 1,
      revokedAt: null,
    });
    const user = userEvent.setup();
    render(<TokenManager vaultId="vault-1" />);
    await screen.findByText('No upload tokens');
    await user.type(screen.getByRole('textbox', { name: 'Token name' }), 'Laptop');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('tephra_secret_value')).toBeInTheDocument();
    expect(screen.getByText('It will not be shown again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I saved it' }));
    expect(screen.queryByText('tephra_secret_value')).not.toBeInTheDocument();
    expect(screen.getByText('Laptop')).toBeInTheDocument();
  });
});
