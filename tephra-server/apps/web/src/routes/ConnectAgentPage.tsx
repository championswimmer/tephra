import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Vault } from '../api/types';
import { ErrorState, Loading } from '../components/Status';

/**
 * Consent screen for MCP/OAuth sign-in. A coding agent opens
 * `/oauth/authorize` in the browser, which lands here (after sign-in) so the
 * user can pick a vault and access level before a token is issued.
 */
export function ConnectAgentPage() {
  const [params] = useSearchParams();
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const codeChallenge = params.get('code_challenge') ?? '';
  const state = params.get('state') ?? undefined;
  const [client, setClient] = useState<{ name: string; redirectHost: string } | null>(null);
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [vaultId, setVaultId] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('write');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const valid = Boolean(clientId && redirectUri && codeChallenge);

  useEffect(() => {
    if (!valid) return;
    void Promise.all([api.oauthClient(clientId, redirectUri), api.vaults()])
      .then(([info, list]) => {
        setClient(info);
        setVaults(list.vaults);
        setVaultId(list.vaults[0]?.id ?? '');
      })
      .catch(setError);
  }, [valid, clientId, redirectUri]);

  async function decide(decision: 'approve' | 'deny') {
    setBusy(true);
    setError(undefined);
    try {
      const { redirectUrl } = await api.oauthDecision({
        clientId,
        redirectUri,
        codeChallenge,
        ...(state === undefined ? {} : { state }),
        decision,
        ...(decision === 'approve' ? { vaultId, access } : {}),
      });
      setDone(decision === 'approve' ? 'approved' : 'denied');
      window.location.assign(redirectUrl);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  if (!valid)
    return (
      <main className="page narrow">
        <h1>Invalid request</h1>
        <p>This page is opened by a coding agent. Start the sign-in from your agent instead.</p>
      </main>
    );
  if (done)
    return (
      <main className="page narrow">
        <h1>{done === 'approved' ? 'Agent connected' : 'Access denied'}</h1>
        <p>You can close this tab and return to your agent.</p>
      </main>
    );

  return (
    <main className="page narrow">
      <p className="eyebrow">Authorize</p>
      <h1>Connect {client ? client.name : 'an AI agent'}</h1>
      {error !== undefined && <ErrorState error={error} />}
      {!client && error === undefined && <Loading label="Loading request…" />}
      {client && vaults && (
        <section className="settings-card">
          <p>
            <strong>{client.name}</strong> is asking for access to your Tephra notes. Its
            callback goes to <code>{client.redirectHost}</code> on this device. Only approve
            if you just started this from your agent.
          </p>
          {vaults.length === 0 ? (
            <p>You have no vaults yet. Create one first.</p>
          ) : (
            <>
              <label>
                <span>Vault</span>
                <select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Access</legend>
                <label>
                  <input
                    type="radio"
                    name="access"
                    checked={access === 'write'}
                    onChange={() => setAccess('write')}
                  />{' '}
                  Read and edit notes
                </label>
                <br />
                <label>
                  <input
                    type="radio"
                    name="access"
                    checked={access === 'read'}
                    onChange={() => setAccess('read')}
                  />{' '}
                  Read only
                </label>
              </fieldset>
              <p className="muted">
                Creates a revocable API token named “MCP: {client.name}” for this vault only.
                Edits are saved as new revisions.
              </p>
            </>
          )}
          <div className="actions">
            <button className="primary" disabled={busy || !vaultId} onClick={() => void decide('approve')}>
              {busy ? 'Authorizing…' : 'Authorize'}
            </button>{' '}
            <button disabled={busy} onClick={() => void decide('deny')}>
              Deny
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
