import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { Vault } from '../src/api/types';
import { VaultListPage } from '../src/routes/VaultListPage';

describe('VaultListPage', () => {
  beforeEach(() => { vi.spyOn(api, 'obsidianAvailable').mockResolvedValue({ available: false }); });
  it('shows headless phases instead of revisions and explains the permanent creation method', async () => {
    const phases = ['pending-login', 'pending-remote', 'installing', 'initial-sync', 'running', 'stopped', 'error', 'unavailable'] as const;
    const labels = ['Waiting for login', 'Waiting for remote vault', 'Installing', 'Initial sync in progress', 'Running', 'Stopped', 'Error', 'Unavailable'];
    const vaults: Vault[] = phases.map((phase, index) => ({
      id: `headless-${index}`, name: `Headless ${index}`, syncMode: 'obsidian', latestRevision: 9,
      obsidianSync: { enabled: true, phase, lastErrorCode: null, lastSyncedAt: null },
    }));
    vaults.push({ id: 'missing', name: 'Missing', syncMode: 'obsidian', latestRevision: 4 });
    vaults.push({ id: 'direct', name: 'Direct', syncMode: 'tephra', latestRevision: 3 });
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults });
    render(<MemoryRouter><VaultListPage /></MemoryRouter>);

    await screen.findByRole('link', { name: /^Direct/ });
    labels.forEach((label, index) => {
      const card = screen.getByRole('link', { name: new RegExp(`^Headless ${index}`) });
      expect(card).toHaveTextContent(`Obsidian Sync · ${label}`);
      expect(card).not.toHaveTextContent('Revision');
    });
    expect(screen.getByRole('link', { name: /^Missing/ })).toHaveTextContent('Status unavailable');
    expect(screen.getByRole('link', { name: /^Direct/ })).toHaveTextContent('Revision 3');
    expect(screen.getByLabelText('Vault name')).toHaveAccessibleDescription(/sync method is permanent.*cannot be changed/i);
    expect(screen.getByRole('link', { name: /Manage your Obsidian account/ })).toHaveAttribute('href', '/settings#obsidian-sync');
  });

  it('creates an official sync vault when the service is available and links to setup', async () => {
    vi.mocked(api.obsidianAvailable).mockResolvedValue({ available: true });
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [] });
    const create = vi.spyOn(api, 'createVault').mockResolvedValue({ vault: {
      id: 'native', name: 'Native vault', syncMode: 'obsidian', latestRevision: 0,
    } });
    const user = userEvent.setup();
    render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await screen.findByText('No vaults yet');
    await user.type(screen.getByLabelText('Vault name'), 'Native vault');
    await user.selectOptions(screen.getByLabelText('Sync method'), 'obsidian');
    await user.click(screen.getByRole('button', { name: 'Create vault' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Native vault', 'obsidian'));
    expect(screen.getByRole('link', { name: /Set up Obsidian Sync/ })).toHaveAttribute('href', '/v/Native%20vault/settings');
    expect(screen.getByRole('link', { name: 'Settings for Native vault' })).toHaveAttribute('href', '/v/Native%20vault/settings');
  });

  it('does not duplicate a vault seen in a refresh before creation completes', async () => {
    vi.useFakeTimers();
    const existing: Vault = { id: 'one', name: 'One', syncMode: 'obsidian', latestRevision: 0 };
    const created: Vault = { id: 'two', name: 'Two', syncMode: 'tephra', latestRevision: 0 };
    vi.spyOn(api, 'vaults').mockResolvedValueOnce({ vaults: [existing] }).mockResolvedValueOnce({ vaults: [existing, created] });
    let finish!: (value: { vault: Vault }) => void;
    vi.spyOn(api, 'createVault').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Two' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create vault' }).closest('form')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getAllByRole('link', { name: /^Two/ })).toHaveLength(1);
    await act(async () => { finish({ vault: created }); });
    expect(screen.getAllByRole('link', { name: /^Two/ })).toHaveLength(1);
    unmount();
    vi.useRealTimers();
  });

  it('locks the name and method while creation is in progress', async () => {
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [] });
    let finish!: (value: { vault: Vault }) => void;
    vi.spyOn(api, 'createVault').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await screen.findByText('No vaults yet');
    await user.type(screen.getByLabelText('Vault name'), 'Pending');
    await user.click(screen.getByRole('button', { name: 'Create vault' }));
    expect(screen.getByLabelText('Vault name')).toBeDisabled();
    expect(screen.getByLabelText('Sync method')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await act(async () => { finish({ vault: { id: 'pending', name: 'Pending', latestRevision: 0 } }); });
    expect(screen.getByLabelText('Vault name')).toBeEnabled();
    expect(screen.getByLabelText('Sync method')).toBeEnabled();
  });

  it('disables official sync creation when the service is unavailable', async () => {
    vi.spyOn(api, 'vaults').mockResolvedValue({ vaults: [] });
    render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await screen.findByText('No vaults yet');
    expect(screen.getByRole('option', { name: /Official Obsidian Sync/ })).toBeDisabled();
  });

  it('updates the displayed status on refresh', async () => {
    vi.useFakeTimers();
    const vault: Vault = { id: 'one', name: 'One', syncMode: 'obsidian', latestRevision: 1,
      obsidianSync: { enabled: true, phase: 'initial-sync', lastErrorCode: null, lastSyncedAt: null } };
    vi.spyOn(api, 'vaults').mockResolvedValueOnce({ vaults: [vault] }).mockResolvedValueOnce({
      vaults: [{ ...vault, obsidianSync: { ...vault.obsidianSync!, phase: 'running' } }],
    });
    const { unmount } = render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByRole('link', { name: /^One/ })).toHaveTextContent('Initial sync in progress');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole('link', { name: /^One/ })).toHaveTextContent('Running');
    unmount();
    vi.useRealTimers();
  });

  it('polls without overlap, ignores a stale refresh after creation and aborts on unmount', async () => {
    vi.useFakeTimers();
    const initial: Vault = { id: 'one', name: 'One', syncMode: 'obsidian', latestRevision: 1,
      obsidianSync: { enabled: true, phase: 'initial-sync', lastErrorCode: null, lastSyncedAt: null } };
    let resolveRefresh!: (value: { vaults: Vault[] }) => void;
    const refresh = new Promise<{ vaults: Vault[] }>((resolve) => { resolveRefresh = resolve; });
    const vaults = vi.spyOn(api, 'vaults').mockResolvedValueOnce({ vaults: [initial] }).mockReturnValueOnce(refresh).mockReturnValueOnce(new Promise(() => {}));
    const created: Vault = { id: 'two', name: 'Two', syncMode: 'tephra', latestRevision: 0 };
    const create = vi.spyOn(api, 'createVault').mockResolvedValue({ vault: created });
    const { unmount } = render(<MemoryRouter><VaultListPage /></MemoryRouter>);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(vaults).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(vaults).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('Vault name'), { target: { value: 'Two' } });
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Create vault' }).closest('form')!); });
    expect(create).toHaveBeenCalledWith('Two', 'tephra');
    await act(async () => { resolveRefresh({ vaults: [{ ...initial, obsidianSync: { ...initial.obsidianSync!, phase: 'running' } }] }); });
    expect(screen.getByRole('link', { name: /^Two/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^One/ })).toHaveTextContent('Initial sync in progress');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const signal = vaults.mock.calls.at(-1)?.[0];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(vaults).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

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

    await screen.findByRole('link', { name: /^Alpha/i });
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
      expect(screen.queryByRole('link', { name: /^Alpha/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('No vaults yet')).toBeInTheDocument();
  });
});
