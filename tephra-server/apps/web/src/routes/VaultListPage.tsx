import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { api } from '../api/client';
import type { Vault } from '../api/types';
import { EmptyState, ErrorState, Loading } from '../components/Status';

export function VaultListPage() {
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  async function load() {
    setError(undefined);
    try {
      setVaults((await api.vaults()).vaults);
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(undefined);
    try {
      const { vault } = await api.createVault(trimmed);
      setVaults((current) => [...(current ?? []), vault]);
      setName('');
    } catch (caught) {
      setError(caught);
    } finally {
      setCreating(false);
    }
  }
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Library</p>
          <h1>Your vaults</h1>
          <p>Read-only mirrors synchronized from Obsidian.</p>
        </div>
        <form className="create-vault" onSubmit={create}>
          <label htmlFor="vault-name" className="sr-only">
            Vault name
          </label>
          <input
            id="vault-name"
            placeholder="New vault name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create vault'}
          </button>
        </form>
      </div>
      {error !== undefined && <ErrorState error={error} retry={() => void load()} />}
      {!vaults && !error ? (
        <Loading label="Loading vaults…" />
      ) : vaults?.length === 0 ? (
        <EmptyState title="No vaults yet">
          <p>Create one, then connect the Tephra Obsidian plugin.</p>
        </EmptyState>
      ) : (
        <ul className="vault-grid">
          {vaults?.map((vault) => (
            <li key={vault.id}>
              <Link to={`/v/${encodeURIComponent(vault.name)}`}>
                <span className="vault-icon" aria-hidden="true">
                  <Archive size={28} aria-hidden="true" focusable="false" className="icon" />
                </span>
                <strong>{vault.name}</strong>
                <span>Revision {vault.latestRevision}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
