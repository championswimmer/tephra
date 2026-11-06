import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';

export function ObsidianSyncSettingsPanel() {
  const [available, setAvailable] = useState<boolean>();
  const [account, setAccount] = useState<{
    authenticated: boolean;
    email: string | null;
    lastErrorCode: string | null;
  }>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api
      .obsidianAvailable()
      .then(async (result) => {
        if (cancelled) return;
        setAvailable(result.available);
        if (result.available) {
          const result = await api.obsidianAccount();
          if (!cancelled) {
            setAccount(result.account);
            setEmail(result.account.email ?? '');
          }
        }
      })
      .catch((caught) => {
        if (!cancelled)
          setError(caught instanceof Error ? caught.message : 'Unable to load Obsidian account.');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    void api
      .obsidianAccountLogin({ email, password, ...(mfa ? { mfa } : {}) })
      .then((result) => setAccount(result.account))
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Unable to sign in to Obsidian.'),
      )
      .finally(() => {
        setPassword('');
        setMfa('');
        setBusy(false);
      });
  }
  return (
    <section className="settings-card obsidian-settings" id="obsidian-sync">
      <h2>Obsidian Sync account</h2>
      <p>
        Sign in to use the official Obsidian headless client. An active Obsidian Sync subscription
        is required.
      </p>
      <p className="muted">
        Your account password and two-factor codes are used only to sign in. The server saves a
        session token so enabled vaults resume after a restart.
      </p>
      {available === false ? (
        <p role="status">Obsidian Sync is disabled by this server&apos;s administrator.</p>
      ) : available === undefined ? (
        <p>Loading Obsidian Sync…</p>
      ) : (
        <>
          {account && (
            <p role="status">
              {account.authenticated
                ? `Signed in${account.email ? ` as ${account.email}` : ''}.`
                : 'Not signed in to Obsidian.'}
            </p>
          )}
          {account?.lastErrorCode && (
            <p>Obsidian Sync needs attention. Sign in again to renew your session.</p>
          )}
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
              {account?.authenticated ? 'Sign in again' : 'Sign in to Obsidian'}
            </button>
          </form>
          <p>
            <Link to="/vaults">Create or manage vaults →</Link>
          </p>
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
