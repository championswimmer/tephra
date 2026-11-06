import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Vault } from '../api/types';
import { ObsidianVaultSyncPanel } from '../components/ObsidianVaultSyncPanel';
import { ErrorState, Loading } from '../components/Status';
import { TokenManager } from '../components/TokenManager';
import { syncStatus } from '../vault/sync-status';

export function VaultSettingsPage() {
  const { vaultSlug = '' } = useParams();
  const [vault, setVault] = useState<Vault>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let cancelled = false;
    setVault(undefined);
    setError(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    const load = async () => {
      try {
        const result = await api.vault(vaultSlug);
        if (cancelled) return;
        loaded = true;
        setVault(result.vault);
        setError(undefined);
        if (result.vault.syncMode === 'obsidian') timer = setTimeout(() => void load(), 10_000);
      } catch (caught) {
        if (!cancelled) {
          if (!loaded) setError(caught);
          else timer = setTimeout(() => void load(), 10_000);
        }
      }
    };
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [vaultSlug]);

  if (error !== undefined) return <main className="page"><ErrorState error={error} /></main>;
  if (!vault) return <main className="page"><Loading label="Loading vault settings…" /></main>;
  return (
    <main className="page">
      <p><Link to={`/v/${encodeURIComponent(vault.name)}`}>{vault.name}</Link> / Settings</p>
      <h1>Vault settings</h1>
      <section className="settings-card">
        <h2>Sync method</h2>
        <p>{vault.syncMode === 'obsidian' ? 'Official Obsidian Sync' : 'Direct Tephra plugin sync'}</p>
        <p>This sync method was selected at creation and cannot be changed.</p>
        {vault.syncMode === 'obsidian' && <p>{syncStatus(vault)}</p>}
        <p>Revision {vault.latestRevision}</p>
      </section>
      {vault.syncMode === 'obsidian' ? <ObsidianVaultSyncPanel vaultId={vault.id} /> : <TokenManager vaultId={vault.id} />}
    </main>
  );
}
