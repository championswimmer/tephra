import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ObsidianRemote, ObsidianSyncSettings } from '../api/types';

const phases: Record<ObsidianSyncSettings['phase'], string> = {
  'pending-login': 'Sign in to Obsidian to continue',
  'pending-remote': 'Choose a remote vault',
  installing: 'Installing the official Sync client…',
  'initial-sync': 'Syncing your vault…',
  running: 'Sync is running',
  stopped: 'Sync is paused',
  error: 'Sync needs attention',
};
const errors: Record<string, string> = {
  OBSIDIAN_SYNC_LIMIT:
    'This server has reached its enabled vault limit. Pause another vault or ask the administrator to raise the limit.',
  OBSIDIAN_UNAVAILABLE: 'The Sync client could not start. Check server network access, then retry.',
  OBSIDIAN_AUTH_EXPIRED: 'Sign in again to renew your Obsidian session.',
  OBSIDIAN_CHECKOUT_MISSING:
    'Local files or Sync state are missing. Sign in if needed, then download a fresh copy below.',
  OBSIDIAN_SETUP_FAILED: 'Check your Sync subscription, vault selection and encryption password.',
  OBSIDIAN_SYNC_FAILED: 'Check server connectivity and disk space, then retry.',
  OBSIDIAN_MFA_REQUIRED: 'Sign in again with a current two-factor code.',
  OBSIDIAN_LOGIN_FAILED: 'Sign in again with your Obsidian credentials.',
};

export function ObsidianVaultSyncPanel({ vaultId }: { vaultId: string }) {
  const [settings, setSettings] = useState<ObsidianSyncSettings>();
  const [remotes, setRemotes] = useState<ObsidianRemote[]>([]);
  const [remoteVaultId, setRemoteVaultId] = useState('');
  const [mode, setMode] = useState<'bidirectional' | 'pull-only'>('bidirectional');
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const snapshotVersion = useRef(0);
  const mutating = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let initializedMode = false;
    let timer: number | undefined;
    snapshotVersion.current++;
    setSettings(undefined);
    setRemotes([]);
    setRemoteVaultId('');
    setEncryptionPassword('');
    setError('');
    const refresh = async () => {
      const version = snapshotVersion.current;
      try {
        const result = await api.obsidianStatus(vaultId);
        if (!cancelled && !mutating.current && version === snapshotVersion.current) {
          setSettings(result.settings);
          if (!initializedMode) {
            setMode(result.settings.mode);
            initializedMode = true;
          }
        }
      } catch (caught) {
        if (!cancelled && !mutating.current && version === snapshotVersion.current)
          setError(caught instanceof Error ? caught.message : 'Unable to load Sync status.');
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 3_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vaultId]);
  async function action(work: () => Promise<void>) {
    snapshotVersion.current++;
    mutating.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to complete the Sync action.');
    } finally {
      snapshotVersion.current++;
      mutating.current = false;
      setBusy(false);
    }
  }
  async function loadRemotes() {
    const result = await api.obsidianRemotes(vaultId);
    setRemotes(result.vaults);
    setRemoteVaultId((current) => current || settings?.remoteVaultId || result.vaults[0]?.id || '');
  }
  function setup(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      try {
        const result = await api.obsidianSetup(vaultId, {
          remoteVaultId,
          mode,
          ...(encryptionPassword ? { encryptionPassword } : {}),
        });
        setSettings(result.settings);
        setRemotes([]);
      } finally {
        setEncryptionPassword('');
      }
    });
  }
  return (
    <section className="settings-card obsidian-settings">
      <h2>Obsidian Sync</h2>
      <p>
        <Link to="/settings?tab=sync">Sign in or reauthenticate your Obsidian account →</Link>
      </p>
      {settings && (
        <div className="obsidian-sync-status" role="status">
          <strong>{phases[settings.phase]}</strong>
          <p>
            Automatic sync: {settings.enabled ? 'enabled' : 'paused'} ·{' '}
            {settings.mode === 'pull-only' ? 'Download only' : 'Two-way sync'}
          </p>
          {settings.lastSyncedAt !== null && (
            <p>Last local update: {new Date(settings.lastSyncedAt).toLocaleString()}</p>
          )}
          {settings.lastErrorCode && (
            <p>{errors[settings.lastErrorCode] ?? 'Retry Sync or sign in again.'}</p>
          )}
          {settings.remoteVaultId && (
            <div className="modal-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () =>
                    setSettings((await api.obsidianEnable(vaultId, !settings.enabled)).settings),
                  )
                }
              >
                {settings.enabled ? 'Pause sync' : 'Enable automatic sync'}
              </button>
              {settings.enabled && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () =>
                      setSettings((await api.obsidianEnable(vaultId, true)).settings),
                    )
                  }
                >
                  Retry sync
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <button type="button" disabled={busy || !settings} onClick={() => void action(loadRemotes)}>
        Load remote vaults
      </button>
      {remotes.length > 0 && (
        <form onSubmit={setup} className="modal-form">
          <label htmlFor="obsidian-remote">Remote vault</label>
          <select
            id="obsidian-remote"
            value={remoteVaultId}
            onChange={(event) => setRemoteVaultId(event.target.value)}
          >
            {remotes
              .filter((remote) => !settings?.remoteVaultId || remote.id === settings.remoteVaultId)
              .map((remote) => (
                <option value={remote.id} key={remote.id}>
                  {remote.name}
                  {remote.region ? ` (${remote.region})` : ''}
                </option>
              ))}
          </select>
          <label htmlFor="obsidian-encryption">
            Vault encryption password (for end-to-end encrypted vaults)
          </label>
          <input
            id="obsidian-encryption"
            type="password"
            autoComplete="off"
            value={encryptionPassword}
            onChange={(event) => setEncryptionPassword(event.target.value)}
          />
          <label htmlFor="obsidian-direction">Sync direction</label>
          <select
            id="obsidian-direction"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
          >
            <option value="bidirectional">Two-way — edits in Tephra sync to Obsidian</option>
            <option value="pull-only">Download only — edit in Obsidian</option>
          </select>
          {settings?.remoteVaultId && (
            <p>
              Downloading a fresh copy replaces this server&apos;s local checkout. Notes already
              imported into Tephra remain available until the download completes.
            </p>
          )}
          <button type="submit" disabled={busy || !remoteVaultId}>
            {settings?.remoteVaultId
              ? 'Download fresh copy and enable sync'
              : 'Connect vault and enable sync'}
          </button>
        </form>
      )}
      {remotes.length === 0 && settings?.phase === 'pending-remote' && (
        <p>
          Load your remote vaults to continue. If none appear, check your Sync subscription and
          create a remote vault in Obsidian.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Working…</p>}
    </section>
  );
}
