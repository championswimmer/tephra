import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { api } from '../api/client';
import type { Vault } from '../api/types';
import { EmptyState, ErrorState, Loading } from '../components/Status';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function VaultListPage() {
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingVault, setDeletingVault] = useState<Vault | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
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
  useEffect(() => {
    if (!deletingVault || deleting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetDeleteModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [deletingVault, deleting, resetDeleteModal]);
  const resetDeleteModal = useCallback(() => {
    setDeletingVault(null);
    setDeleteConfirmation('');
    setDeleteError(undefined);
  }, []);
  function closeDeleteModal() {
    if (deleting) return;
    resetDeleteModal();
  }
  async function removeVault(event: FormEvent) {
    event.preventDefault();
    if (!deletingVault || deleteConfirmation !== deletingVault.name) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await api.deleteVault(deletingVault.id, deletingVault.name);
      setVaults((current) => current?.filter((vault) => vault.id !== deletingVault.id) ?? []);
      resetDeleteModal();
    } catch (caught) {
      setDeleteError(caught);
    } finally {
      setDeleting(false);
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
              <article className="vault-card">
                <Link to={`/v/${encodeURIComponent(vault.name)}`}>
                  <span className="vault-icon" aria-hidden="true">
                    <Archive size={28} aria-hidden="true" focusable="false" className="icon" />
                  </span>
                  <strong>{vault.name}</strong>
                  <span>Revision {vault.latestRevision}</span>
                </Link>
                <button
                  type="button"
                  className="danger subtle vault-delete-button"
                  onClick={() => {
                    setDeletingVault(vault);
                    setDeleteConfirmation('');
                    setDeleteError(undefined);
                  }}
                >
                  Delete vault
                </button>
              </article>
            </li>
          ))}
        </ul>
      )}
      {deletingVault && (
        <div
          className="modal-backdrop"
          onClick={closeDeleteModal}
          role="presentation"
          aria-hidden={false}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-vault-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="delete-vault-title">Delete vault</h2>
            </div>
            <section className="modal-section">
              <p>
                Delete <strong>{deletingVault.name}</strong> from Tephra Server. This only removes
                the remote mirror.
              </p>
              <p className="muted">
                To confirm, enter the vault name exactly: <strong>{deletingVault.name}</strong>
              </p>
              <form className="modal-form" onSubmit={removeVault}>
                <label htmlFor="delete-vault-confirmation">Vault name</label>
                <input
                  id="delete-vault-confirmation"
                  value={deleteConfirmation}
                  autoFocus
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
                {deleteError !== undefined && (
                  <p className="form-error">{errorMessage(deleteError)}</p>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="topbar-button"
                    onClick={closeDeleteModal}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="danger"
                    disabled={deleting || deleteConfirmation !== deletingVault.name}
                  >
                    {deleting ? 'Deleting…' : 'Delete vault'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
