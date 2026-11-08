import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { ObsidianSyncSettings } from '../src/api/types';
import { ObsidianSyncSettingsPanel } from '../src/components/ObsidianSyncSettingsPanel';
import { ObsidianVaultSyncPanel } from '../src/components/ObsidianVaultSyncPanel';

const settings: ObsidianSyncSettings = {
  vaultId: 'native-vault',
  enabled: false,
  remoteVaultId: null,
  mode: 'bidirectional',
  phase: 'pending-login',
  frequency: 'continuous',
  lastErrorCode: null,
  hasSynced: false,
  lastSyncedAt: null,
};
afterEach(() => vi.restoreAllMocks());
const renderInRouter = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);
describe('Obsidian Sync settings', () => {
  it('signs in globally without a vault and clears credentials', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: true });
    vi.spyOn(api, 'obsidianAccount').mockResolvedValue({
      account: { authenticated: false, email: null, lastErrorCode: null },
    });
    const login = vi.spyOn(api, 'obsidianAccountLogin').mockResolvedValue({
      account: { authenticated: true, email: 'obsidian@example.com', lastErrorCode: null },
    });
    renderInRouter(<ObsidianSyncSettingsPanel />);
    await user.type(await screen.findByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.type(screen.getByLabelText('Two-factor code (if enabled)'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in to Obsidian' }));
    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'obsidian@example.com',
        password: 'private-password',
        mfa: '123456',
      }),
    );
    expect(await screen.findByText('Signed in as obsidian@example.com.')).toBeInTheDocument();
    expect(screen.getByLabelText('Obsidian password')).toHaveValue('');
    expect(screen.getByLabelText('Two-factor code (if enabled)')).toHaveValue('');
    expect(screen.queryByLabelText('Manage vault')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
  });
  it('clears password and code when sign-in fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: true });
    vi.spyOn(api, 'obsidianAccount').mockResolvedValue({
      account: { authenticated: false, email: null, lastErrorCode: null },
    });
    vi.spyOn(api, 'obsidianAccountLogin').mockRejectedValue(
      new Error('Enter a current two-factor code.'),
    );
    renderInRouter(<ObsidianSyncSettingsPanel />);
    await user.type(await screen.findByLabelText('Obsidian email'), 'obsidian@example.com');
    await user.type(screen.getByLabelText('Obsidian password'), 'private-password');
    await user.type(screen.getByLabelText('Two-factor code (if enabled)'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in to Obsidian' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a current two-factor code.');
    expect(screen.getByLabelText('Obsidian password')).toHaveValue('');
    expect(screen.getByLabelText('Two-factor code (if enabled)')).toHaveValue('');
  });
  it('configures the selected vault direction and clears its encryption password', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings });
    vi.spyOn(api, 'obsidianRemotes').mockResolvedValue({
      vaults: [{ id: 'remote-1', name: 'My remote', region: 'eu' }],
    });
    const setup = vi.spyOn(api, 'obsidianSetup').mockResolvedValue({
      settings: { ...settings, remoteVaultId: 'remote-1', enabled: true, phase: 'initial-sync' },
    });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    expect(await screen.findByText('Sign in to Obsidian to continue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sign in or reauthenticate/ })).toHaveAttribute(
      'href',
      '/settings?tab=sync',
    );
    expect(screen.queryByLabelText('Obsidian password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Sync frequency')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load remote vaults' }));
    await user.type(
      await screen.findByLabelText('Vault encryption password (for end-to-end encrypted vaults)'),
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
  });
  it('pauses enabled sync', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({
      settings: { ...settings, remoteVaultId: 'remote-1', enabled: true, phase: 'running' },
    });
    const pause = vi.spyOn(api, 'obsidianEnable').mockResolvedValue({
      settings: { ...settings, remoteVaultId: 'remote-1', phase: 'stopped' },
    });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    await user.click(await screen.findByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('native-vault', false));
    expect(await screen.findByText('Sync is paused')).toBeInTheDocument();
  });
  it('shows the persisted frequency and all choices for a connected vault', async () => {
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({
      settings: {
        ...settings,
        remoteVaultId: 'remote-1',
        enabled: true,
        phase: 'running',
        frequency: '6h',
      },
    });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    expect(select).toHaveValue('6h');
    expect(
      Array.from((select as HTMLSelectElement).options).map((option) => [
        option.value,
        option.textContent,
      ]),
    ).toEqual([
      ['continuous', 'Continuous'],
      ['6h', 'Every 6 hours'],
      ['1h', 'Every hour'],
      ['30m', 'Every 30 minutes'],
      ['10m', 'Every 10 minutes'],
    ]);
  });
  it('treats a missing frequency as continuous', async () => {
    const legacy = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: true,
      phase: 'running' as const,
    };
    delete (legacy as Partial<ObsidianSyncSettings>).frequency;
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: legacy });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    expect(await screen.findByLabelText('Sync frequency')).toHaveValue('continuous');
  });
  it('saves a frequency change while enabled without changing enabled state', async () => {
    const user = userEvent.setup();
    const running = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: true,
      phase: 'running' as const,
    };
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: running });
    const update = vi.spyOn(api, 'obsidianUpdateSettings').mockResolvedValue({
      settings: { ...running, phase: 'initial-sync', frequency: '10m' },
    });
    const enable = vi.spyOn(api, 'obsidianEnable');
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    expect(select).toHaveValue('continuous');
    await user.selectOptions(select, '10m');
    await waitFor(() => expect(update).toHaveBeenCalledWith('native-vault', { frequency: '10m' }));
    expect(enable).not.toHaveBeenCalled();
    await waitFor(() => expect(select).toHaveValue('10m'));
    expect(await screen.findByText('Syncing your vault…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause sync' })).toBeInTheDocument();
  });
  it('saves a frequency change while paused without enabling sync', async () => {
    const user = userEvent.setup();
    const paused = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: false,
      phase: 'stopped' as const,
      frequency: '30m' as const,
    };
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: paused });
    const update = vi.spyOn(api, 'obsidianUpdateSettings').mockResolvedValue({
      settings: { ...paused, frequency: '1h' },
    });
    const enable = vi.spyOn(api, 'obsidianEnable');
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    expect(select).toHaveValue('30m');
    await user.selectOptions(select, '1h');
    await waitFor(() => expect(update).toHaveBeenCalledWith('native-vault', { frequency: '1h' }));
    expect(enable).not.toHaveBeenCalled();
    expect(select).toHaveValue('1h');
    expect(screen.getByText('Sync is paused')).toBeInTheDocument();
  });
  it('applies the frequency returned by the server', async () => {
    const user = userEvent.setup();
    const running = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: true,
      phase: 'running' as const,
    };
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: running });
    vi.spyOn(api, 'obsidianUpdateSettings').mockResolvedValue({
      settings: { ...running, frequency: '6h' },
    });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    await user.selectOptions(select, '10m');
    await waitFor(() => expect(select).toHaveValue('6h'));
  });
  it('disables the frequency select while saving', async () => {
    const user = userEvent.setup();
    const running = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: true,
      phase: 'running' as const,
    };
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: running });
    let resolveUpdate!: (value: { settings: ObsidianSyncSettings }) => void;
    vi.spyOn(api, 'obsidianUpdateSettings').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    await user.selectOptions(select, '10m');
    await waitFor(() => expect(select).toBeDisabled());
    await act(async () => resolveUpdate({ settings: { ...running, frequency: '10m' } }));
    await waitFor(() => expect(select).not.toBeDisabled());
  });
  it('shows a frequency update failure and keeps the previous value', async () => {
    const user = userEvent.setup();
    const running = {
      ...settings,
      remoteVaultId: 'remote-1',
      enabled: true,
      phase: 'running' as const,
    };
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings: running });
    vi.spyOn(api, 'obsidianUpdateSettings').mockRejectedValue(new Error('Invalid sync frequency.'));
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    const select = await screen.findByLabelText('Sync frequency');
    await user.selectOptions(select, '10m');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid sync frequency.');
    expect(select).toHaveValue('continuous');
  });
  it('does not let a stale poll undo a frequency change', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        ...settings,
        remoteVaultId: 'remote-1',
        enabled: true,
        phase: 'running' as const,
      };
      let resolvePoll!: (value: { settings: ObsidianSyncSettings }) => void;
      const status = vi
        .spyOn(api, 'obsidianStatus')
        .mockResolvedValueOnce({ settings: running })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePoll = resolve;
            }),
        );
      const update = vi.spyOn(api, 'obsidianUpdateSettings').mockResolvedValue({
        settings: { ...running, frequency: '10m' },
      });
      renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(status).toHaveBeenCalledTimes(2);
      const select = screen.getByLabelText('Sync frequency');
      await act(async () => {
        fireEvent.change(select, { target: { value: '10m' } });
      });
      expect(update).toHaveBeenCalledWith('native-vault', { frequency: '10m' });
      expect(select).toHaveValue('10m');
      await act(async () => resolvePoll({ settings: running }));
      expect(select).toHaveValue('10m');
    } finally {
      vi.useRealTimers();
    }
  });
  it('stops polling the vault after unmount', async () => {
    vi.useFakeTimers();
    try {
      const status = vi.spyOn(api, 'obsidianStatus').mockResolvedValue({ settings });
      const { unmount } = renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
      await act(async () => {});
      expect(status).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(status).toHaveBeenCalledTimes(2);
      unmount();
      await act(async () => vi.advanceTimersByTime(6_000));
      expect(status).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not let an older poll undo a pause or overlap another poll', async () => {
    vi.useFakeTimers();
    try {
      const running = {
        ...settings,
        remoteVaultId: 'remote-1',
        enabled: true,
        phase: 'running' as const,
      };
      let resolvePoll!: (value: { settings: ObsidianSyncSettings }) => void;
      const status = vi
        .spyOn(api, 'obsidianStatus')
        .mockResolvedValueOnce({ settings: running })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolvePoll = resolve;
            }),
        );
      vi.spyOn(api, 'obsidianEnable').mockResolvedValue({
        settings: { ...running, enabled: false, phase: 'stopped' },
      });
      renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(3_000));
      await act(async () => vi.advanceTimersByTime(9_000));
      expect(status).toHaveBeenCalledTimes(2);
      await act(async () => screen.getByRole('button', { name: 'Pause sync' }).click());
      expect(screen.getByText('Sync is paused')).toBeInTheDocument();
      await act(async () => resolvePoll({ settings: running }));
      expect(screen.getByText('Sync is paused')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it('initializes the direction from the vault', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'obsidianStatus').mockResolvedValue({
      settings: { ...settings, mode: 'pull-only' },
    });
    vi.spyOn(api, 'obsidianRemotes').mockResolvedValue({
      vaults: [{ id: 'remote-1', name: 'My remote' }],
    });
    renderInRouter(<ObsidianVaultSyncPanel vaultId="native-vault" />);
    await screen.findByText('Sign in to Obsidian to continue');
    await user.click(screen.getByRole('button', { name: 'Load remote vaults' }));
    expect(await screen.findByLabelText('Sync direction')).toHaveValue('pull-only');
  });
});
