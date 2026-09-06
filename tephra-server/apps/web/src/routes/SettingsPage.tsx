import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../app/AuthContext';
export function SettingsPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <main className="page narrow">
      <p className="eyebrow">Account</p>
      <h1>Settings</h1>
      <section className="settings-card">
        <h2>Session</h2>
        <p>
          Signed in as <strong>{user?.email}</strong>.
        </p>
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut()
              .then(() => navigate('/login', { replace: true }))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </section>
      <section className="settings-card">
        <h2>Read-only mirror</h2>
        <p>
          Vault content can only be changed from your local Obsidian vault. This web application
          never writes into it.
        </p>
      </section>
    </main>
  );
}
