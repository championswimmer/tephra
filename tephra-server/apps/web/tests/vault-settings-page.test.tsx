import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { VaultSettingsPage } from '../src/routes/VaultSettingsPage';

vi.mock('../src/components/ObsidianVaultSyncPanel', () => ({
  ObsidianVaultSyncPanel: ({ vaultId }: { vaultId: string }) => <p>Sync controls for {vaultId}</p>,
}));
vi.mock('../src/components/TokenManager', () => ({
  TokenManager: ({ vaultId }: { vaultId: string }) => <p>Tokens for {vaultId}</p>,
}));

function openSettings() {
  render(<MemoryRouter initialEntries={['/v/Example/settings']}><Routes>
    <Route path="/v/:vaultSlug/settings" element={<VaultSettingsPage />} />
  </Routes></MemoryRouter>);
}

describe('vault settings', () => {
  it('shows the fixed direct method, revision and token controls', async () => {
    vi.spyOn(api, 'vault').mockResolvedValue({ vault: { id: 'direct-id', name: 'Example', syncMode: 'tephra', latestRevision: 7 } });
    openSettings();
    expect(await screen.findByText('Direct Tephra plugin sync')).toBeInTheDocument();
    expect(screen.getByText('Revision 7')).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed/)).toBeInTheDocument();
    expect(screen.getByText('Tokens for direct-id')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sync method')).not.toBeInTheDocument();
    expect(api.vault).toHaveBeenCalledWith('Example');
  });

  it('shows headless status and its own vault controls', async () => {
    vi.spyOn(api, 'vault').mockResolvedValue({ vault: { id: 'native-id', name: 'Example', syncMode: 'obsidian', latestRevision: 3,
      obsidianSync: { enabled: true, phase: 'running', lastErrorCode: null, lastSyncedAt: null } } });
    openSettings();
    expect(await screen.findByText('Official Obsidian Sync')).toBeInTheDocument();
    expect(screen.getByText('Obsidian Sync · Running')).toBeInTheDocument();
    expect(screen.getByText('Revision 3')).toBeInTheDocument();
    expect(screen.getByText('Sync controls for native-id')).toBeInTheDocument();
    expect(screen.queryByText(/Tokens for/)).not.toBeInTheDocument();
  });

  it('reports metadata load errors without needing the file list', async () => {
    vi.spyOn(api, 'vault').mockRejectedValue(new Error('Vault unavailable'));
    const files = vi.spyOn(api, 'files');
    openSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent('Vault unavailable');
    expect(files).not.toHaveBeenCalled();
  });
});
