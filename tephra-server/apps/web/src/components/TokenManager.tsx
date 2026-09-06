import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { ApiToken, CreatedToken } from '../api/types';
import { EmptyState, ErrorState, Loading } from './Status';
export function TokenManager({ vaultId }: { vaultId: string }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function load() {
    setError(undefined);
    try {
      setTokens((await api.tokens(vaultId)).tokens);
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [vaultId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.createToken(vaultId, name.trim());
      setCreated(result);
      setTokens((current) => [...(current ?? []), result]);
      setName('');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Plugin access</p>
          <h2>Upload tokens</h2>
        </div>
      </div>
      <p>Tokens let the Obsidian plugin upload to this vault. They cannot access other vaults.</p>
      <form className="inline-form" onSubmit={submit}>
        <label>
          <span>Token name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My phone"
            required
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </button>
      </form>
      {created && (
        <div className="token-once" role="status">
          <strong>Copy this token now</strong>
          <p>It will not be shown again.</p>
          <code>{created.token}</code>
          <div>
            <button type="button" onClick={() => void navigator.clipboard.writeText(created.token)}>
              Copy
            </button>
            <button type="button" onClick={() => setCreated(null)}>
              I saved it
            </button>
          </div>
        </div>
      )}
      {error && <ErrorState error={error} retry={() => void load()} />}
      {!tokens && !error ? (
        <Loading label="Loading tokens…" />
      ) : tokens?.length === 0 ? (
        <EmptyState title="No upload tokens" />
      ) : (
        <ul className="token-list">
          {tokens?.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <span>Created {new Date(token.createdAt).toLocaleDateString()}</span>
              </div>
              <button
                className="danger subtle"
                type="button"
                disabled={Boolean(token.revokedAt)}
                onClick={() => {
                  if (!window.confirm(`Revoke “${token.name}”?`)) return;
                  void api
                    .revokeToken(vaultId, token.id)
                    .then(() =>
                      setTokens(
                        (current) =>
                          current?.map((item) =>
                            item.id === token.id ? { ...item, revokedAt: Date.now() } : item,
                          ) ?? [],
                      ),
                    );
                }}
              >
                {token.revokedAt ? 'Revoked' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
