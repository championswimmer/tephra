import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { ObsidianSyncSettings } from '../src/api/types';
import { ObsidianSyncSettingsPanel } from '../src/components/ObsidianSyncSettingsPanel';

const settings: ObsidianSyncSettings = {
  vaultId: 'native-vault',
  enabled: false,
  remoteVaultId: null,
  mode: 'bidirectional',
  phase: 'pending-login',
  lastErrorCode: null,
  hasSynced: false,
  lastSyncedAt: null,
};
afterEach(() => vi.restoreAllMocks());
function prepare(existing = false) {
  vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: true });
  vi.spyOn(api, 'vaults').mockResolvedValue({
    vaults: existing
      ? [{ id: 'native-vault', name: 'My Sync', syncMode: 'obsidian', latestRevision: 0 }]
      : [],
  });
  vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings });
  render(
    <MemoryRouter>
      <ObsidianSyncSettingsPanel />
    </MemoryRouter>,
  );
}
describe('Obsidian Sync settings', () => {
  it('creates a native vault, signs in with optional MFA, clears credentials, and connects an encrypted remote', async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, 'createVault')
      .mockResolvedValue({
        vault: { id: 'native-vault', name: 'My Sync', syncMode: 'obsidian', latestRevision: 0 },
      });
    const login = vi
      .spyOn(api, 'obsidianLogin')
      .mockResolvedValue({ settings: { ...settings, phase: 'pending-remote' } });
    vi.spyOn(api, 'obsidianRemotes').mockResolvedValue({
      vaults: [{ id: 'remote-1', name: 'My remote', region: 'eu' }],
    });
    const setup = vi
      .spyOn(api, 'obsidianSetup')
      .mockResolvedValue({
        settings: { ...settings, remoteVaultId: 'remote-1', enabled: true, phase: 'initial-sync' },
      });
    prepare();
    await user.type(await screen.findByLabelText('New Tephra vault name'), 'My Sync');
    await user.click(screen.getByRole('button', { name: 'Create Obsidian Sync vault' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('My Sync', 'obsidian'));
    await user.type(await screen.findByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.type(screen.getByLabelText('Two-factor code (if enabled)'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in to Obsidian' }));
    await screen.findByLabelText('Remote vault');
    expect(login).toHaveBeenCalledWith('native-vault', {
      email: 'obsidian@example.com',
      password: 'private-password',
      mfa: '123456',
    });
    expect(screen.getByLabelText('Obsidian password')).toHaveValue('');
    expect(screen.getByLabelText('Two-factor code (if enabled)')).toHaveValue('');
    await user.type(
      screen.getByLabelText('Vault encryption password (for end-to-end encrypted vaults)'),
      'private-vault-password',
    );
    await user.selectOptions(screen.getByLabelText('Sync direction'), 'pull-only');
    await user.click(screen.getByRole('button', { name: 'Connect vault and enable sync' }));
    await waitFor(() =>
      expect(setup).toHaveBeenCalledWith('native-vault', {
        remoteVaultId: 'remote-1',
        mode: 'pull-only',
        encryptionPassword: 'private-vault-password',
      }),
    );
    expect(await screen.findByText('Syncing your vault…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open vault →' })).toHaveAttribute(
      'href',
      '/v/My%20Sync',
    );
  });
  it('shows an MFA failure without retaining the submitted password or code', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianLogin').mockRejectedValue(new Error('Enter a current two-factor code.'));
    prepare(true);
    await user.type(await screen.findByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.click(screen.getByRole('button', { name: 'Sign in to Obsidian' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a current two-factor code.');
    expect(screen.getByLabelText('Obsidian password')).toHaveValue('');
  });
  it('pauses enabled sync and displays the new persistent setting', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: true });
    vi.spyOn(api, 'vaults').mockResolvedValue({
      vaults: [{ id: 'native-vault', name: 'My Sync', syncMode: 'obsidian', latestRevision: 1 }],
    });
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({
      settings: {
        ...settings,
        remoteVaultId: 'remote-1',
        enabled: true,
        phase: 'running',
        hasSynced: true,
      },
    });
    const pause = vi
      .spyOn(api, 'obsidianEnable')
      .mockResolvedValue({
        settings: { ...settings, remoteVaultId: 'remote-1', phase: 'stopped', hasSynced: true },
      });
    render(
      <MemoryRouter>
        <ObsidianSyncSettingsPanel />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('native-vault', false));
    expect(await screen.findByText('Sync is paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable automatic sync' })).toBeInTheDocument();
  });
});
