import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ObsidianRemote, ObsidianSyncSettings, Vault } from '../api/types';

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
    'This server has reached its enabled vault limit. Pause another native vault or ask the administrator to raise the limit.',
  OBSIDIAN_UNAVAILABLE: 'The Sync client could not start. Check server network access, then retry.',
  OBSIDIAN_AUTH_EXPIRED: 'Sign in again to renew your Obsidian session.',
  OBSIDIAN_CHECKOUT_MISSING:
    'Local files or Sync state are missing. Sign in if needed, then download a fresh copy below.',
  OBSIDIAN_SETUP_FAILED: 'Check your Sync subscription, vault selection and encryption password.',
  OBSIDIAN_SYNC_FAILED: 'Check server connectivity and disk space, then retry.',
  OBSIDIAN_MFA_REQUIRED: 'Sign in again with a current two-factor code.',
  OBSIDIAN_LOGIN_FAILED: 'Sign in again with your Obsidian credentials.',
};

export function ObsidianSyncSettingsPanel() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [available, setAvailable] = useState<boolean>();
  const [selected, setSelected] = useState('');
  const [settings, setSettings] = useState<ObsidianSyncSettings>();
  const [remotes, setRemotes] = useState<ObsidianRemote[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [encryptionPassword, setEncryptionPassword] = useState('');
  const [remoteVaultId, setRemoteVaultId] = useState('');
  const [mode, setMode] = useState<'bidirectional' | 'pull-only'>('bidirectional');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const vault = vaults.find((value) => value.id === selected);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.obsidianAvailable(), api.vaults()])
      .then(([capability, result]) => {
        if (cancelled) return;
        setAvailable(capability.available);
        const native = result.vaults.filter((value) => value.syncMode === 'obsidian');
        setVaults(native);
        setSelected(native[0]?.id ?? '');
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Unable to load Obsidian Sync.');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setSettings(undefined);
    setRemotes([]);
    setRemoteVaultId('');
    setPassword('');
    setMfa('');
    setEncryptionPassword('');
    setError('');
    if (!selected || !available) return;
    let cancelled = false;
    const refresh = () =>
      api
        .obsidianStatus(selected)
        .then((result) => {
          if (!cancelled) setSettings(result.settings);
        })
        .catch((caught) => {
          if (!cancelled)
            setError(caught instanceof Error ? caught.message : 'Unable to load Sync status.');
        });
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selected, available]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to complete the Sync action.');
    } finally {
      setBusy(false);
    }
  }
  async function loadRemotes() {
    const result = await api.obsidianRemotes(selected);
    setRemotes(result.vaults);
    setRemoteVaultId((current) => current || settings?.remoteVaultId || result.vaults[0]?.id || '');
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const result = await api.createVault(name.trim(), 'obsidian');
      setVaults((current) => [...current, result.vault]);
      setSelected(result.vault.id);
      setName('');
    });
  }
  function login(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      try {
        const result = await api.obsidianLogin(selected, {
          email,
          password,
          ...(mfa ? { mfa } : {}),
        });
        setSettings(result.settings);
        await loadRemotes();
      } finally {
        setPassword('');
        setMfa('');
      }
    });
  }
  function setup(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      try {
        const result = await api.obsidianSetup(selected, {
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
    <section className="settings-card obsidian-settings" id="obsidian-sync">
      <h2>Obsidian Sync</h2>
      <p>
        Connect an existing remote vault using the official Obsidian headless client. An active
        Obsidian Sync subscription is required.
      </p>
      <p className="muted">
        Your account password and two-factor codes are used only to sign in. The server saves a
        session token and vault encryption key so enabled vaults resume after a restart.
      </p>
      {available === false ? (
        <p role="status">Obsidian Sync is disabled by this server&apos;s administrator.</p>
      ) : available === undefined ? (
        <p>Loading Obsidian Sync…</p>
      ) : (
        <>
          <form onSubmit={create} className="modal-form">
            <label htmlFor="obsidian-vault-name">New Tephra vault name</label>
            <input
              id="obsidian-vault-name"
              value={name}
              maxLength={200}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" disabled={busy || !name.trim()}>
              Create Obsidian Sync vault
            </button>
          </form>
          {vaults.length > 0 && (
            <>
              <label htmlFor="obsidian-vault">Manage vault</label>
              <select
                id="obsidian-vault"
                value={selected}
                disabled={busy}
                onChange={(event) => setSelected(event.target.value)}
              >
                {vaults.map((value) => (
                  <option value={value.id} key={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
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
                            setSettings(
                              (await api.obsidianEnable(selected, !settings.enabled)).settings,
                            ),
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
                              setSettings((await api.obsidianEnable(selected, true)).settings),
                            )
                          }
                        >
                          Retry sync
                        </button>
                      )}
                    </div>
                  )}
                  {vault && <Link to={`/v/${encodeURIComponent(vault.name)}`}>Open vault →</Link>}
                </div>
              )}
              <details
                key={selected}
                open={
                  settings?.phase === 'pending-login' ||
                  settings?.lastErrorCode === 'OBSIDIAN_AUTH_EXPIRED' ||
                  settings?.lastErrorCode === 'OBSIDIAN_MFA_REQUIRED'
                }
              >
                <summary>Sign in to Obsidian</summary>
                <form onSubmit={login} className="modal-form">
                  <label htmlFor="obsidian-email">Obsidian email</label>
                  <input
                    id="obsidian-email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    required
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <label htmlFor="obsidian-password">Obsidian password</label>
                  <input
                    id="obsidian-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    required
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <label htmlFor="obsidian-mfa">Two-factor code (if enabled)</label>
                  <input
                    id="obsidian-mfa"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={mfa}
                    pattern="[0-9]{6}"
                    maxLength={6}
                    onChange={(event) => setMfa(event.target.value)}
                  />
                  <button type="submit" disabled={busy || !password}>
                    Sign in to Obsidian
                  </button>
                </form>
              </details>
              <button type="button" disabled={busy} onClick={() => void action(loadRemotes)}>
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
                      .filter(
                        (remote) =>
                          !settings?.remoteVaultId || remote.id === settings.remoteVaultId,
                      )
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
                    <option value="bidirectional">
                      Two-way — edits in Tephra sync to Obsidian
                    </option>
                    <option value="pull-only">Download only — edit in Obsidian</option>
                  </select>
                  {settings?.remoteVaultId && (
                    <p>
                      Downloading a fresh copy replaces this server&apos;s local checkout. Notes
                      already imported into Tephra remain available until the download completes.
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
                  Load your remote vaults to continue. If none appear, check your Sync subscription
                  and create a remote vault in Obsidian.
                </p>
              )}
            </>
          )}
        </>
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
