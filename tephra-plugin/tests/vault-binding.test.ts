import { describe, expect, it, vi } from 'vitest';
import { ensureVaultBinding, type VaultBindingSettings } from '../src/sync/vault-binding';

function settings(overrides: Partial<VaultBindingSettings> = {}): VaultBindingSettings {
  return {
    serverUrl: 'https://example.test',
    vaultId: 'vault-1',
    vaultName: 'Notes',
    uploadToken: 'tpt_upload',
    ...overrides,
  };
}

function resolver(vault: { id: string; name: string }) {
  return {
    getVault: vi.fn(async () => ({
      id: vault.id,
      name: vault.name,
      latestRevision: 3,
      createdAt: 100,
      updatedAt: 200,
    })),
  };
}

describe('ensureVaultBinding', () => {
  it('confirms a canonical binding with the server and changes nothing', async () => {
    const current = settings();
    const client = resolver({ id: 'vault-1', name: 'Notes' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: true, changed: false, idChanged: false });
    expect(client.getVault).toHaveBeenCalledWith('vault-1', 'tpt_upload');
    expect(current.vaultId).toBe('vault-1');
    expect(current.vaultName).toBe('Notes');
  });

  it('fills a missing vault name from the server', async () => {
    const current = settings({ vaultName: '' });
    const client = resolver({ id: 'vault-1', name: 'Notes' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: true, changed: true, idChanged: false });
    expect(current.vaultId).toBe('vault-1');
    expect(current.vaultName).toBe('Notes');
    expect(client.getVault).toHaveBeenCalledWith('vault-1', 'tpt_upload');
  });

  it('canonicalizes a vault name stored in the id field', async () => {
    const current = settings({ vaultId: 'Notes', vaultName: '' });
    const client = resolver({ id: 'vault-1', name: 'Notes' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: true, changed: true, idChanged: true });
    expect(current.vaultId).toBe('vault-1');
    expect(current.vaultName).toBe('Notes');
    expect(client.getVault).toHaveBeenCalledWith('Notes', 'tpt_upload');
  });

  it('refreshes a stale vault name after a server-side rename', async () => {
    const current = settings({ vaultName: 'Old name' });
    const client = resolver({ id: 'vault-1', name: 'New name' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: true, changed: true, idChanged: false });
    expect(current.vaultId).toBe('vault-1');
    expect(current.vaultName).toBe('New name');
  });

  it('prefers the session token so any owned vault resolves by name', async () => {
    const current = settings({
      vaultId: 'Other vault',
      vaultName: '',
      auth: { sessionToken: 'tps_session' },
    });
    const client = resolver({ id: 'vault-9', name: 'Other vault' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result.resolved).toBe(true);
    expect(client.getVault).toHaveBeenCalledWith('Other vault', 'tps_session');
    expect(current.vaultId).toBe('vault-9');
  });

  it('keeps stored values when the server is unreachable', async () => {
    const current = settings({ vaultName: '' });
    const client = { getVault: vi.fn(async () => Promise.reject(new Error('offline'))) };
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: false, changed: false, idChanged: false });
    expect(current.vaultId).toBe('vault-1');
    expect(current.vaultName).toBe('');
  });

  it('skips resolution without credentials and without clearing anything', async () => {
    const current = settings({ uploadToken: '', auth: undefined });
    const client = resolver({ id: 'vault-1', name: 'Notes' });
    const result = await ensureVaultBinding(current, () => client);
    expect(result).toEqual({ resolved: false, changed: false, idChanged: false });
    expect(client.getVault).not.toHaveBeenCalled();
  });

  it('is a no-op without a server URL or identifier', async () => {
    const client = resolver({ id: 'vault-1', name: 'Notes' });
    const noUrl = settings({ serverUrl: '' });
    expect(await ensureVaultBinding(noUrl, () => client)).toEqual({
      resolved: true,
      changed: false,
      idChanged: false,
    });
    const noSlug = settings({ vaultId: '', vaultName: '' });
    expect(await ensureVaultBinding(noSlug, () => client)).toEqual({
      resolved: true,
      changed: false,
      idChanged: false,
    });
    expect(client.getVault).not.toHaveBeenCalled();
  });
});
