import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Plus, Settings, X } from 'lucide-react';
import { api } from '../api/client';
import type { Vault } from '../api/types';
import { EmptyState, ErrorState, Loading } from '../components/Status';
import { syncStatus } from '../vault/sync-status';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function VaultListPage() {
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createError, setCreateError] = useState<unknown>();
  const createDialogRef = useRef<HTMLDialogElement | null>(null);
  const createNameRef = useRef<HTMLInputElement | null>(null);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [syncMode, setSyncMode] = useState<'tephra' | 'obsidian'>('tephra');
  const [obsidianAvailable, setObsidianAvailable] = useState(false);
  const [createdHeadless, setCreatedHeadless] = useState<Vault | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .obsidianAvailable()
      .then((result) => {
        if (!cancelled) setObsidianAvailable(result.available);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const [deletingVault, setDeletingVault] = useState<Vault | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mutationVersion = useRef(0);
  const inFlight = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    activeRequest.current = controller;
    const version = mutationVersion.current;
    try {
      const result = await api.vaults(controller.signal);
      if (!controller.signal.aborted && mounted.current && version === mutationVersion.current) {
        setVaults(result.vaults);
        setError(undefined);
      }
    } catch (caught) {
      if (!controller.signal.aborted && mounted.current) setError(caught);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        inFlight.current = false;
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
      inFlight.current = false;
    };
  }, [load]);
  const hasHeadlessVault = vaults?.some((vault) => vault.syncMode === 'obsidian') ?? false;
  useEffect(() => {
    if (!hasHeadlessVault) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(async () => {
        await load();
        if (!cancelled) schedule();
      }, 10_000);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasHeadlessVault, load]);
  useEffect(() => {
    if (showCreateDialog) {
      createDialogRef.current?.showModal();
      createNameRef.current?.focus();
    }
  }, [showCreateDialog]);
  function closeCreateDialog() {
    createDialogRef.current?.close();
    setShowCreateDialog(false);
    setName('');
    setSyncMode('tephra');
    setCreateError(undefined);
    createTriggerRef.current?.focus();
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const { vault } = await api.createVault(trimmed, syncMode);
      mutationVersion.current += 1;
      setVaults((current) => [...(current ?? []).filter((item) => item.id !== vault.id), vault]);
      setCreatedHeadless(syncMode === 'obsidian' ? vault : null);
      closeCreateDialog();
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  }
  const resetDeleteModal = useCallback((options?: { restoreFocus?: boolean }) => {
    if (
      options?.restoreFocus !== false &&
      deleteTriggerRef.current &&
      document.contains(deleteTriggerRef.current)
    ) {
      deleteTriggerRef.current.focus();
    }
    if (options?.restoreFocus === false) deleteTriggerRef.current = null;
    setDeletingVault(null);
    setDeleteConfirmation('');
    setDeleteError(undefined);
  }, []);
  useEffect(() => {
    if (!deletingVault || deleting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetDeleteModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [deletingVault, deleting, resetDeleteModal]);
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
      mutationVersion.current += 1;
      setVaults((current) => current?.filter((vault) => vault.id !== deletingVault.id) ?? []);
      resetDeleteModal({ restoreFocus: false });
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
          <p>Synced with Obsidian. Edit in the browser or on your device.</p>
        </div>
        <button
          type="button"
          className="primary icon-button new-vault-button"
          ref={createTriggerRef}
          onClick={() => setShowCreateDialog(true)}
        >
          <Plus aria-hidden="true" focusable="false" className="icon" />
          New vault
        </button>
      </div>
      {createdHeadless && (
        <p role="status">
          Vault created.{' '}
          <Link to={`/v/${encodeURIComponent(createdHeadless.name)}/settings`}>
            Set up Obsidian Sync →
          </Link>
        </p>
      )}
      {error !== undefined && <ErrorState error={error} retry={() => void load()} />}
      {!vaults && !error ? (
        <Loading label="Loading vaults…" />
      ) : vaults?.length === 0 ? (
        <EmptyState title="No vaults yet">
          <p>Select New vault to get started.</p>
        </EmptyState>
      ) : (
        <ul className="vault-list" aria-label="Vaults">
          {vaults?.map((vault) => (
            <li key={vault.id}>
              <article className="vault-card">
                <Link className="vault-card-main" to={`/v/${encodeURIComponent(vault.name)}`}>
                  <span className="vault-icon" aria-hidden="true">
                    <Archive size={28} aria-hidden="true" focusable="false" className="icon" />
                  </span>
                  <strong>{vault.name}</strong>
                  <span>
                    {vault.syncMode === 'obsidian'
                      ? syncStatus(vault)
                      : `Revision ${vault.latestRevision}`}
                  </span>
                </Link>
                <div className="vault-card-actions">
                  <Link
                    className="topbar-button icon-button"
                    to={`/v/${encodeURIComponent(vault.name)}/settings`}
                    aria-label={`Settings for ${vault.name}`}
                  >
                    <Settings aria-hidden="true" focusable="false" className="icon" />
                    Settings
                  </Link>
                  <button
                    type="button"
                    className="danger subtle vault-delete-button"
                    onClick={(event) => {
                      deleteTriggerRef.current = event.currentTarget;
                      setDeletingVault(vault);
                      setDeleteConfirmation('');
                      setDeleteError(undefined);
                    }}
                  >
                    Delete vault
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      {showCreateDialog && (
        <dialog
          className="modal create-vault-dialog"
          ref={createDialogRef}
          aria-labelledby="create-vault-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!creating) closeCreateDialog();
          }}
        >
          <div className="modal-header">
            <h2 id="create-vault-title">Create vault</h2>
            <button
              type="button"
              className="modal-close"
              disabled={creating}
              onClick={closeCreateDialog}
              aria-label="Close create vault dialog"
            >
              <X aria-hidden="true" focusable="false" className="icon" />
            </button>
          </div>
          <p className="muted">Give your vault a name and choose how to sync it.</p>
          <form className="modal-form" onSubmit={create}>
            <label htmlFor="vault-name">Vault name</label>
            <input
              id="vault-name"
              ref={createNameRef}
              required
              disabled={creating}
              placeholder="My vault"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label htmlFor="vault-sync-method">Sync method</label>
            <select
              id="vault-sync-method"
              disabled={creating}
              value={syncMode}
              aria-describedby="vault-sync-description vault-creation-method"
              onChange={(event) => setSyncMode(event.target.value as 'tephra' | 'obsidian')}
            >
              <option value="tephra">Direct Tephra plugin</option>
              <option value="obsidian" disabled={!obsidianAvailable}>
                Official Obsidian Sync{!obsidianAvailable ? ' (unavailable)' : ''}
              </option>
            </select>
            <p className="muted" id="vault-sync-description">
              {syncMode === 'tephra'
                ? 'Connect your vault using the Tephra plugin in Obsidian.'
                : 'Connect an existing remote vault with your Obsidian Sync account. You’ll finish setup in vault settings.'}
            </p>
            <p className="muted" id="vault-creation-method">
              The sync method cannot be changed after creation.
            </p>
            {(syncMode === 'obsidian' || !obsidianAvailable) && (
              <p className="muted">
                {!obsidianAvailable && 'Official Obsidian Sync is unavailable on this server. '}
                <Link to="/settings#obsidian-sync">Manage your Obsidian account →</Link>
              </p>
            )}
            {createError !== undefined && (
              <p className="form-error" role="alert">
                {errorMessage(createError)}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="topbar-button"
                disabled={creating}
                onClick={closeCreateDialog}
              >
                Cancel
              </button>
              <button type="submit" className="primary" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create vault'}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {deletingVault && (
        <div className="modal-backdrop" onClick={closeDeleteModal} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-vault-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2 id="delete-vault-title">Delete vault</h2>
              <button
                type="button"
                className="modal-close"
                onClick={closeDeleteModal}
                disabled={deleting}
                aria-label="Close delete vault dialog"
              >
                <X size={16} aria-hidden="true" focusable="false" className="icon" />
              </button>
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
